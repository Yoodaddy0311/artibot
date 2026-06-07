#!/usr/bin/env node
/**
 * Triage wiring-audit gaps — read-only false-positive classifier.
 *
 * The WIRING-AUDIT "no caller in lib/" heuristic over-reports dead code: a
 * capability can be invoked from a CLI (bin/), an MCP bridge, a command/hook,
 * or re-exported through an index.js barrel and still look "dead" to a naive
 * lib-only grep. This tool re-classifies the 57 UNVERIFIED claimed gaps into:
 *
 *   - dead            : zero qualifying production caller (genuine gap).
 *   - wired-suspect   : at least one qualifying production caller (false-positive
 *                       suspect — the audit likely missed the call site).
 *   - config-only     : a config FLAG (not a symbol) — judged by config-key
 *                       presence in artibot.config.json + a consumer grep.
 *
 * A "qualifying production caller" excludes three noise sources:
 *   (a) the capability's own definition file (from the audit `file` field),
 *   (b) anything under a `tests/` path,
 *   (c) a bare `index.js` barrel re-export line (`export ... from './x.js'`).
 *
 * Depth-2 orphan refinement: a caller that lives in a file which itself has NO
 * inbound production reference (an "orphan caller") does not count — this catches
 * transitively-dead chains (e.g. episodic.appendEpisode is called only from
 * working.js#flush(), whose own trigger working-compaction.js is never wired).
 *
 * READ-ONLY: emits a single JSON object to stdout. Creates/modifies no files.
 *
 * Usage: node scripts/ci/triage-wiring-gaps.mjs
 *
 * @module scripts/ci/triage-wiring-gaps
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_JSON = path.join(PLUGIN_ROOT, 'docs', 'wiring-audit-result.json');

/**
 * The five config-flag gaps named in the audit's "config flags audit" bucket.
 * These are config KEYS, not symbols, so they bypass the symbol-grep path.
 */
const CONFIG_FLAG_KEYS = [
  'context.importCacheTTL',
  'automation.intentDetection',
  'cognitive.system1.maxLatency',
  'cognitive.system2.maxRetries',
  'cognitive.router.adaptRate',
];

/** Reserved words / generic tokens that must never be treated as a symbol. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'via', 'with', 'without', 'not', 'config', 'flag',
  'side', 'path', 'shape', 'input', 'output', 'enabled', 'session', 'store',
  'data', 'writer', 'reader', 'bundle', 'class', 'base', 'abstract', 'option',
  'contract', 'mismatch', 'counter', 'display', 'displayed', 'production',
  'incl', 'true', 'false', 'null', 'from', 'only', 'state', 'server',
  'manifest', 'registered', 'wiring', 'bridge', 'bridges', 'function',
]);

/* -------------------------------------------------------------------------- */
/* Input loading                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Load the 57 unverified claimed gaps from the audit JSON.
 * Unverified == `confirmedRealGaps` entries WITHOUT `verifyConfirmed === true`.
 *
 * @returns {{ subsystem: string, capability: string, file: string }[]}
 */
function loadUnverifiedGaps() {
  if (!existsSync(AUDIT_JSON)) {
    throw new Error(`audit input not found: ${AUDIT_JSON}`);
  }
  const audit = JSON.parse(readFileSync(AUDIT_JSON, 'utf-8'));
  const all = Array.isArray(audit.confirmedRealGaps) ? audit.confirmedRealGaps : [];
  return all
    .filter((g) => g && g.verifyConfirmed !== true)
    .map((g) => ({
      subsystem: String(g.subsystem || ''),
      capability: String(g.capability || ''),
      file: String(g.file || ''),
    }));
}

/* -------------------------------------------------------------------------- */
/* Symbol + module extraction                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extract grep-able identifier symbols from a capability description.
 * Dotted access keeps the trailing segment (episodic.appendEpisode ->
 * appendEpisode); slash lists are split (searchMemory/getMemoryStats).
 *
 * @param {string} capability
 * @returns {string[]} Distinct candidate symbol names.
 */
export function extractSymbols(capability) {
  const out = new Set();
  // Pull tokens that look like JS identifiers (optionally dotted), length>=4.
  const tokens = capability.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) || [];
  for (const raw of tokens) {
    // Slash-separated lists arrive as separate regex hits already; dotted -> last.
    const seg = raw.includes('.') ? raw.split('.').pop() : raw;
    if (!seg || seg.length < 4) continue;
    if (STOPWORDS.has(seg.toLowerCase())) continue;
    // Heuristic: real API symbols are camelCase/PascalCase or contain a verb-y
    // prefix. Skip all-lowercase plain words that are not known factory verbs.
    const isCamelOrPascal = /[a-z][A-Z]/.test(seg) || /^[A-Z]/.test(seg);
    const isFactoryVerb = /^(create|build|run|get|set|append|register|route|parse|select|evaluate|detect|wire|upload|download|promote|stage|load|list|persist|rank|apply|process|init|request|fulfill|read|search|decay|add|rotate|generate|revoke|collect|classify|recommend)/.test(seg);
    if (isCamelOrPascal || isFactoryVerb) out.add(seg);
  }
  return [...out];
}

/**
 * Extract the definition module basename from an audit `file` field
 * ("lib/core/event-bus.js:159" -> "event-bus"). Used as an extra grep target
 * so module-level imports (not just symbol calls) are detected.
 *
 * @param {string} file
 * @returns {{ defPath: string|null, moduleName: string|null }}
 */
export function extractModule(file) {
  const pathPart = file.split(':')[0].trim();
  const isJs = pathPart.endsWith('.js') || pathPart.endsWith('.mjs');
  if (!pathPart || !isJs) {
    return { defPath: null, moduleName: null };
  }
  const base = path.basename(pathPart).replace(/\.(js|mjs)$/, '');
  return { defPath: pathPart.replace(/\\/g, '/'), moduleName: base };
}

/* -------------------------------------------------------------------------- */
/* lib/ source index (read once)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Recursively collect every .js/.mjs file under lib/ (excluding tests).
 *
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {string[]} Absolute file paths.
 */
function walkLib(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'node_modules') continue;
      walkLib(full, acc);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Build an in-memory index of lib/ source files with their content, keyed by
 * a repo-relative POSIX path. Read once; reused for every gap.
 *
 * @returns {{ relPath: string, base: string, content: string, isBarrel: boolean }[]}
 */
function buildLibIndex() {
  const libDir = path.join(PLUGIN_ROOT, 'lib');
  if (!existsSync(libDir)) return [];
  return walkLib(libDir).map((abs) => {
    const relPath = path.relative(PLUGIN_ROOT, abs).replace(/\\/g, '/');
    return {
      relPath,
      base: path.basename(abs),
      content: readFileSync(abs, 'utf-8'),
      isBarrel: path.basename(abs) === 'index.js',
    };
  });
}

/**
 * True if a source line is a pure barrel re-export
 * (`export ... from './x.js'` / `export * from ...`).
 *
 * @param {string} line
 * @returns {boolean}
 */
function isBarrelReexportLine(line) {
  return /^\s*export\s+(\*|\{[^}]*\})\s+from\s+['"]/.test(line);
}

/**
 * True if a line DEFINES the given symbol (function/const/class export or a
 * bare function/class declaration). Definition sites must never count as callers.
 *
 * @param {string} line
 * @param {string} esc - Regex-escaped symbol name.
 * @returns {boolean}
 */
function isDefinitionLine(line, esc) {
  return new RegExp(
    `\\b(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${esc}\\b`
  ).test(line)
    // method-shorthand definition inside a returned object literal: the line
    // both opens the param list AND the body block (`  NAME(args) {`). The
    // trailing `{` is what distinguishes a definition from a bare call
    // statement like `NAME();`.
    || new RegExp(`^\\s*(?:async\\s+)?${esc}\\s*\\([^)]*\\)\\s*\\{`).test(line)
    // property-style export (`  NAME,` inside a return {...} object)
    || new RegExp(`^\\s*${esc}\\s*,\\s*$`).test(line);
}

/**
 * Find qualifying production CALLERS of a symbol across the lib index, applying
 * the exclusion rules. A qualifying line must (i) match the symbol at a word
 * boundary, (ii) NOT be the symbol's definition, (iii) NOT be a barrel
 * re-export, and (iv) look like a use site — a call `NAME(`, a method call
 * `.NAME(`, or an explicit named import of the symbol.
 *
 * @param {string} token - Identifier to locate.
 * @param {string|null} defPath - Repo-relative audit def file to exclude.
 * @param {{relPath:string,base:string,content:string,isBarrel:boolean}[]} libIndex
 * @returns {string[]} Repo-relative paths of files that actually use the symbol.
 */
function findCallerFiles(token, defPath, libIndex) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = new RegExp(`\\b${esc}\\b`);
  const callSite = new RegExp(`(?:\\b|\\.)${esc}\\s*\\(`); // NAME( or .NAME(
  const namedImport = new RegExp(`import[^;]*\\b${esc}\\b[^;]*from`);
  const hits = [];
  for (const f of libIndex) {
    if (f.relPath === defPath) continue; // (a) audit-declared def file
    let matched = false;
    let definesHere = false;
    for (const line of f.content.split('\n')) {
      if (!word.test(line)) continue;
      if (isCommentLine(line)) continue; // ignore JSDoc/// mentions (no real use)
      if (isDefinitionLine(line, esc)) { definesHere = true; continue; } // exclude def site
      if (f.isBarrel && isBarrelReexportLine(line)) continue; // (c) barrel re-export
      if (callSite.test(line) || namedImport.test(line)) matched = true;
    }
    // A file that DEFINES the symbol is the definition module, never a caller —
    // even if it also references the symbol internally.
    if (matched && !definesHere) hits.push(f.relPath);
  }
  return hits;
}

/**
 * True if a source line is purely a comment (single-line `//`, or a JSDoc/block
 * continuation line beginning with `*`). Comment mentions are not call sites.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Depth-2 orphan check: does this caller file have ANY inbound production
 * reference (someone imports its basename) outside itself/tests? If not, the
 * caller is itself orphaned and should not keep the gap alive.
 *
 * @param {string} callerRelPath
 * @param {{relPath:string,base:string,content:string,isBarrel:boolean}[]} libIndex
 * @returns {boolean} True if the caller file is referenced by another lib file.
 */
function callerHasInbound(callerRelPath, libIndex) {
  const base = path.basename(callerRelPath).replace(/\.(js|mjs)$/, '');
  if (!base) return false;
  const re = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (const f of libIndex) {
    if (f.relPath === callerRelPath) continue;
    // Only count import/require references to the module, not incidental words.
    for (const line of f.content.split('\n')) {
      if (/\b(import|require|from)\b/.test(line) && re.test(line)) return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Classify a single symbol-based gap as 'dead' or 'wired-suspect'.
 *
 * @param {{subsystem:string,capability:string,file:string}} gap
 * @param {{relPath:string,base:string,content:string,isBarrel:boolean}[]} libIndex
 * @param {Set<string>} [gapDefFiles] - Repo-relative def files of OTHER unverified
 *   gaps. A caller that is itself a gap subject is part of a mutually-dead chain
 *   and does not keep this gap alive.
 * @returns {{ verdict: 'dead'|'wired-suspect', symbols: string[], callers: string[], orphanCallers: string[] }}
 */
export function classifyGap(gap, libIndex, gapDefFiles = new Set()) {
  const symbols = extractSymbols(gap.capability);
  const { defPath, moduleName } = extractModule(gap.file);

  // Symbols are the primary signal. The module BASENAME is only used as a
  // fallback grep target when NO API symbol could be extracted from the prose
  // capability — using it unconditionally floods results with incidental
  // mentions of common subsystem nouns (e.g. "episodic", "memory").
  const targets = new Set(symbols);
  if (symbols.length === 0 && moduleName && moduleName.length >= 5) {
    targets.add(moduleName);
  }

  const qualifying = new Set();
  for (const token of targets) {
    for (const caller of findCallerFiles(token, defPath, libIndex)) {
      qualifying.add(caller);
    }
  }

  // Depth-2: drop orphan callers. A caller does NOT keep the gap alive if it is
  // (a) itself the subject of another unverified gap (mutually-dead chain), or
  // (b) an orphan file that nothing imports.
  const realCallers = [];
  const orphanCallers = [];
  for (const caller of qualifying) {
    const isGapSubject = gapDefFiles.has(caller) && caller !== defPath;
    if (!isGapSubject && callerHasInbound(caller, libIndex)) realCallers.push(caller);
    else orphanCallers.push(caller);
  }

  return {
    verdict: realCallers.length > 0 ? 'wired-suspect' : 'dead',
    symbols: [...targets],
    callers: realCallers.sort(),
    orphanCallers: orphanCallers.sort(),
  };
}

/**
 * Judge a config-flag gap: present in artibot.config.json AND has a consumer.
 *
 * @param {string} flagKey - Dotted config key (e.g. 'cognitive.router.adaptRate').
 * @param {object} config - Parsed artibot.config.json.
 * @param {{relPath:string,base:string,content:string,isBarrel:boolean}[]} libIndex
 * @returns {{ key: string, inConfig: boolean, hasConsumer: boolean, consumers: string[] }}
 */
export function classifyConfigFlag(flagKey, config, libIndex) {
  const leaf = flagKey.split('.').pop();
  const inConfig = configHasPath(config, flagKey);
  const consumers = [];
  const re = new RegExp(`\\b${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (const f of libIndex) {
    if (re.test(f.content)) consumers.push(f.relPath);
  }
  return { key: flagKey, inConfig, hasConsumer: consumers.length > 0, consumers: consumers.sort() };
}

/**
 * Walk a dotted path into a plain object.
 *
 * @param {object} obj
 * @param {string} dotted
 * @returns {boolean} True if the full path resolves to a defined value.
 */
function configHasPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return cur !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Run the full triage and return the result object.
 *
 * @returns {object} { dead, 'wired-suspect', 'config-only', summary }
 */
export function runTriage() {
  const gaps = loadUnverifiedGaps();
  const libIndex = buildLibIndex();

  // Repo-relative def files of every unverified gap — used for mutually-dead
  // chain detection (a caller that is itself a flagged gap subject).
  const gapDefFiles = new Set(
    gaps.map((g) => extractModule(g.file).defPath).filter(Boolean)
  );

  const configPath = path.join(PLUGIN_ROOT, 'artibot.config.json');
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, 'utf-8'))
    : {};

  /** A capability is a config-flag gap if it names one of the five keys. */
  const isConfigFlagGap = (cap) => CONFIG_FLAG_KEYS.some((k) => cap.includes(k));

  const dead = [];
  const wiredSuspect = [];
  const configOnly = [];
  const seenFlags = new Set();

  for (const gap of gaps) {
    if (isConfigFlagGap(gap.capability)) {
      const matchedKey = CONFIG_FLAG_KEYS.find((k) => gap.capability.includes(k));
      seenFlags.add(matchedKey);
      const res = classifyConfigFlag(matchedKey, config, libIndex);
      configOnly.push({ subsystem: gap.subsystem, capability: gap.capability, ...res });
      continue;
    }
    const res = classifyGap(gap, libIndex, gapDefFiles);
    const record = {
      subsystem: gap.subsystem,
      capability: gap.capability,
      file: gap.file,
      symbols: res.symbols,
      callers: res.callers,
      orphanCallers: res.orphanCallers,
    };
    if (res.verdict === 'dead') dead.push(record);
    else wiredSuspect.push(record);
  }

  // Any of the 5 canonical flags never matched by a gap row → judge standalone
  // so the config-only bucket always reflects all five keys.
  for (const key of CONFIG_FLAG_KEYS) {
    if (seenFlags.has(key)) continue;
    const res = classifyConfigFlag(key, config, libIndex);
    configOnly.push({ subsystem: 'config flags audit', capability: `${key} (standalone)`, ...res });
  }

  return {
    dead,
    'wired-suspect': wiredSuspect,
    'config-only': configOnly,
    summary: {
      totalUnverified: gaps.length,
      dead: dead.length,
      wiredSuspect: wiredSuspect.length,
      configOnly: configOnly.length,
      configOnlyInConfigButUnconsumed: configOnly.filter((c) => c.inConfig && !c.hasConsumer).length,
    },
  };
}

// Run only when invoked directly; export the pure functions for tests.
const invokedDirectly =
  process.argv[1] && path.basename(process.argv[1]) === 'triage-wiring-gaps.mjs';
if (invokedDirectly) {
  try {
    const result = runTriage();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`[triage] failed: ${err.message}\n`);
    process.exit(1);
  }
}
