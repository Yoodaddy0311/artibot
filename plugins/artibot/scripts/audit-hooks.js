#!/usr/bin/env node
/**
 * audit-hooks.js — Phase 2 WS-C.1 Hook Audit (advisory, read-only)
 *
 * Reads plugins/artibot/hooks/hooks.json and produces a GFM inventory
 * table of every hook registration plus per-event summary statistics.
 *
 * This script NEVER mutates any file. It is safe to run at any time.
 * Exit code is always 0 (advisory).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..');
const HOOKS_JSON = resolve(PLUGIN_ROOT, 'hooks', 'hooks.json');

const write = (line) => process.stdout.write(line + '\n');

/**
 * Parse the "command" string from a hook entry and return the relative
 * script path inside plugins/artibot/ (or null if it cannot be derived).
 */
function extractScriptPath(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+\.(?:js|sh|cjs|mjs))/);
  if (!match) return null;
  return match[1];
}

/**
 * Inspect a script file on disk and collect metadata used for the audit.
 */
function inspectScript(relPath) {
  const abs = resolve(PLUGIN_ROOT, relPath);
  const info = {
    exists: false,
    lines: 0,
    size_bytes: 0,
    last_modified: '',
    has_error_handler: false,
    has_io_utils: false,
  };
  if (!existsSync(abs)) return info;
  info.exists = true;
  try {
    const st = statSync(abs);
    info.size_bytes = st.size;
    info.last_modified = st.mtime.toISOString().slice(0, 10);
    const content = readFileSync(abs, 'utf8');
    info.lines = content.split(/\r?\n/).length;
    info.has_error_handler =
      /createErrorHandler/.test(content) || /\btry\s*\{[\s\S]*?\}\s*catch/.test(content);
    info.has_io_utils = /scripts\/utils\/index\.js/.test(content);
  } catch {
    // leave defaults
  }
  return info;
}

/**
 * Walk the hooks.json structure and flatten into a list of registrations.
 */
function collectRegistrations(hooksDoc) {
  const out = [];
  const events = hooksDoc.hooks || {};
  for (const [event, entries] of Object.entries(events)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const matcher = entry.matcher || '';
      const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
      for (const h of inner) {
        const scriptPath = extractScriptPath(h.command);
        const meta = scriptPath
          ? inspectScript(scriptPath)
          : { exists: false, lines: 0, size_bytes: 0, last_modified: '', has_error_handler: false, has_io_utils: false };
        out.push({
          event,
          matcher,
          script: scriptPath || '(unresolved)',
          timeout: h.timeout ?? null,
          priority: entry.priority || '',
          category: entry.category || '',
          ...meta,
        });
      }
    }
  }
  return out;
}

function renderInventory(regs) {
  write('# Hook Audit Inventory (generated)\n');
  write(`Plugin root: ${relative(process.cwd(), PLUGIN_ROOT) || PLUGIN_ROOT}`);
  write(`Source: hooks/hooks.json`);
  write(`Total registrations: ${regs.length}\n`);
  write('| # | Event | Script | Exists | Lines | Size | Modified | ErrHandler | IOUtils | Priority |');
  write('|---|-------|--------|--------|-------|------|----------|------------|---------|----------|');
  regs.forEach((r, i) => {
    write(
      `| ${i + 1} | ${r.event} | \`${r.script}\` | ${r.exists ? 'yes' : 'NO'} | ${r.lines} | ${r.size_bytes} | ${r.last_modified || '-'} | ${r.has_error_handler ? 'yes' : 'no'} | ${r.has_io_utils ? 'yes' : 'no'} | ${r.priority} |`
    );
  });
  write('');
}

function renderSummary(regs) {
  const byEvent = new Map();
  for (const r of regs) {
    byEvent.set(r.event, (byEvent.get(r.event) || 0) + 1);
  }
  const canonical = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact'];
  write('## Summary\n');
  write('| Event | Registrations | Canonical Slot? |');
  write('|-------|--------------:|:----------------|');
  for (const [event, count] of [...byEvent.entries()].sort()) {
    write(`| ${event} | ${count} | ${canonical.includes(event) ? 'yes' : 'no'} |`);
  }
  write('');

  const missing = regs.filter((r) => !r.exists);
  const noErr = regs.filter((r) => r.exists && !r.has_error_handler);
  write(`Missing script files: ${missing.length}`);
  for (const m of missing) write(`  - ${m.event}: ${m.script}`);
  write(`Registrations without error handler: ${noErr.length}`);
  for (const n of noErr) write(`  - ${n.event}: ${n.script}`);
  write('');

  const inCanonical = regs.filter((r) => canonical.includes(r.event)).length;
  const inException = regs.length - inCanonical;
  write(`In canonical 4 slots: ${inCanonical}`);
  write(`Outside canonical 4 slots (exception candidates): ${inException}`);
}

function main() {
  let doc;
  try {
    doc = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  } catch (e) {
    write(`ERROR: could not read ${HOOKS_JSON}: ${e.message}`);
    process.exit(0);
  }
  const regs = collectRegistrations(doc);
  renderInventory(regs);
  renderSummary(regs);
  process.exit(0);
}

main();
