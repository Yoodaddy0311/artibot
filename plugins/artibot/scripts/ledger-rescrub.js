#!/usr/bin/env node
/**
 * ledger-rescrub.js — ONE-TIME maintenance: retroactively re-apply the current
 * secret redactor to already-persisted ambient-ledger lines.
 *
 * Why: redaction is a WRITE-TIME chokepoint (lib/learning/ledger/store.js:201,210
 * via `redactLines`), so a later tightening of the redactor scope (e.g. IMP-03,
 * which folded URL-embedded `user:pass@` credentials into the secret scope) does
 * NOT reach lines that were appended before the change. Those historical lines
 * may still carry a plaintext secret. This script re-scrubs them in place.
 *
 * FAITHFULNESS: it applies the SAME transform the store applies at write time —
 * `redactSecrets` over each WHOLE JSONL line string — NOT a per-field parse.
 * Mirroring the write-time contract is what makes the result identical to "what
 * the current redactor would have written" and keeps the pass idempotent
 * (re-scrubbing already-redacted text is a no-op: [REDACTED_*] tokens never
 * re-match a secret pattern). Lines are never parsed, so an unparseable/malformed
 * line is still passed through the (lossless) redactor and preserved — a secret
 * inside it is masked, all non-secret content is kept, and the line is never
 * dropped.
 *
 * SAFETY: per-file `.bak` backup + atomic tmp+rename, and a file is only touched
 * when its content actually changes. Best-effort / never-throw. Backups are
 * PRESERVED (not auto-deleted) so recovery is a manual `mv <f>.bak <f>`.
 *
 * DATA POLICY: local files only, no network. Output is COUNTS ONLY — verbatim
 * ledger text is never written to stdout/stderr.
 *
 * Manual run only (no hook registration):
 *   node scripts/ledger-rescrub.js        # re-scrub <cwd>/.artibot/ledger/*.jsonl
 */

import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from '../lib/learning/ledger/redact.js';
import { _internals as storeInternals } from '../lib/learning/ledger/store.js';

const { LEDGER_REL } = storeInternals;

/**
 * Re-scrub a raw file body. Splits on '\n' and re-applies `redactSecrets` to
 * every segment (empty segments — including the trailing one from a newline-
 * terminated file — pass through unchanged), so line count and trailing newline
 * are preserved exactly. Non-JSON lines are handled identically (never parsed).
 *
 * @param {string} raw
 * @returns {{ content: string, scanned: number, changed: number }}
 */
export function rescrubContent(raw) {
  const parts = String(raw ?? '').split('\n');
  let scanned = 0;
  let changed = 0;
  const out = parts.map((line) => {
    if (line === '') return line; // trailing / blank segment — not a record
    scanned += 1;
    const redacted = redactSecrets(line);
    if (redacted !== line) changed += 1;
    return redacted;
  });
  return { content: out.join('\n'), scanned, changed };
}

/**
 * Re-scrub a single ledger file in place. Writes a `.bak` + atomic replace only
 * when the content changed. Best-effort — a failure is reported, never thrown.
 *
 * @param {string} filePath
 * @returns {Promise<{ scanned: number, changed: boolean, changedLines: number, error: boolean }>}
 */
export async function rescrubFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return { scanned: 0, changed: false, changedLines: 0, error: true };
  }
  const { content, scanned, changed } = rescrubContent(raw);
  if (changed === 0) return { scanned, changed: false, changedLines: 0, error: false };

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(`${filePath}.bak`, raw, 'utf-8'); // preserve original for recovery
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, filePath); // atomic replace
    return { scanned, changed: true, changedLines: changed, error: false };
  } catch {
    try { await rm(tmp, { force: true }); } catch { /* noop */ }
    return { scanned, changed: false, changedLines: 0, error: true };
  }
}

/**
 * Re-scrub every `*.jsonl` under `<projectRoot>/.artibot/ledger/`. Cursor/queue
 * files (`.cursor.json`, `.corpus-cursor.json`, `.review-queue.json`) and prior
 * `.bak` files are skipped (they do not end in `.jsonl`). Best-effort.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ files: number, filesChanged: number, linesScanned: number, linesChanged: number, backups: number, errors: number }>}
 */
export async function rescrubLedger(projectRoot) {
  const stats = { files: 0, filesChanged: 0, linesScanned: 0, linesChanged: 0, backups: 0, errors: 0 };
  if (!projectRoot) return stats;
  const dir = path.join(projectRoot, LEDGER_REL);

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return stats; // no ledger dir — nothing to do
  }

  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    try {
      const st = await stat(full);
      if (!st.isFile()) continue;
    } catch {
      continue; // race-disappear: skip
    }
    stats.files += 1;
    const res = await rescrubFile(full);
    stats.linesScanned += res.scanned;
    if (res.error) stats.errors += 1;
    if (res.changed) {
      stats.filesChanged += 1;
      stats.backups += 1;
      stats.linesChanged += res.changedLines;
    }
  }
  return stats;
}

/**
 * Render a counts-only summary. NEVER includes ledger text (DATA POLICY).
 * @param {Awaited<ReturnType<typeof rescrubLedger>>} stats
 * @returns {string}
 */
export function renderStats(stats) {
  const s = stats || {};
  const lines = [
    'Ledger re-scrub (secret redaction, retroactive)',
    `- Files scanned:   ${s.files ?? 0}`,
    `- Files changed:   ${s.filesChanged ?? 0} (backups written: ${s.backups ?? 0})`,
    `- Lines scanned:   ${s.linesScanned ?? 0}`,
    `- Lines re-scrubbed: ${s.linesChanged ?? 0}`,
    `- Errors:          ${s.errors ?? 0}`,
  ];
  if ((s.filesChanged ?? 0) > 0) {
    lines.push('', 'Originals preserved as <file>.bak — remove them once verified.');
  } else {
    lines.push('', 'Nothing to change — ledger already matches the current redactor.');
  }
  return lines.join('\n');
}

async function main() {
  const stats = await rescrubLedger(process.cwd());
  process.stdout.write(`${renderStats(stats)}\n`);
}

// Run as CLI only when invoked directly, not when imported by tests.
const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && path.resolve(thisFile) === invokedFile) {
  main().catch((err) => {
    process.stderr.write(`ledger-rescrub failed: ${err?.message || err}\n`);
    process.exitCode = 1;
  });
}
