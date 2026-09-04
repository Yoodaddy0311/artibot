#!/usr/bin/env node
/**
 * sync-readme-claims.js — Auto-fix README count prose to match reality.
 *
 * The release pipeline's badge-sync step rewrites version badges but leaves
 * count *prose* (e.g. "71 slash commands") untouched. When a release changes a
 * count, the prose drifts and only surfaces later as a RED `validate-readme-
 * claims.js --full` gate, forcing a manual hotfix (see release ea8a3b9).
 *
 * This script is the self-healing counterpart to that validator: it reuses the
 * same file-system counts and the same claim regexes, but instead of failing on
 * drift it rewrites the prose in place. Run it in the release sync step (before
 * the validator gate) so count drift never reaches a human.
 *
 * Modes:
 *   (default)  — Rewrite drifting prose across SYNC_TARGETS (the two READMEs,
 *                the entry docs, both marketplace manifests). Idempotent.
 *   --check    — Report would-be changes and exit 1 if any (CI dry-run); makes
 *                no writes. Exit 0 when already in sync.
 *
 * Exit codes:
 *   0 — files already in sync (or were successfully rewritten in write mode)
 *   1 — (--check only) drift detected that a write run would fix
 *
 * Scope: structural counts (skills, commands, agents, hook scripts, hook
 * registrations, CI scripts) plus the committed suite size (`tests`).
 *
 * `tests` (added 2026-09-05) is NOT an exception to "file-system facts only",
 * because this script is not the thing that measures it. Its value is the
 * already-committed `marketplace.json#/qualityMetrics/tests`, written solely by
 * `sync-marketplace-meta.mjs` from a real vitest run — so a release still
 * decides the number, and this script only stops the same number from being
 * transcribed by hand into six documents that then drift apart. Coverage
 * (`statementCoverage`) remains validator-only: it is a threshold claim with no
 * committed integer to propagate.
 *
 * Zero dependencies. Node 20+ built-ins only.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLAIM_PATTERNS,
  collectActuals,
  formatClaimNumber,
  parseClaimNumber,
  partitionFrozenHistory,
  REPO_ROOT,
  SYNC_TARGETS,
} from './readme-claims-registry.js';
import { isMainEntry } from '../hooks/_main-entry.js';

// The files this script rewrites. Defined in the registry beside the patterns
// so the gate and this fixer can never disagree about which documents carry
// claims; the census that produced the list is recorded there.
export { SYNC_TARGETS };

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

/**
 * Rewrite drifting count prose in a single file.
 *
 * Exported so the write path itself is testable against fixture files. The
 * module-level `CHECK_ONLY` stays the CLI default, but `write` is an explicit
 * parameter: a test must not have to reach into `process.argv` to decide
 * whether the function touches the disk.
 *
 * @param {string} file - Absolute path; a missing file is a no-op.
 * @param {Record<string, number>} actuals - Counts from collectActuals().
 * @param {{ write?: boolean }} [opts] - Defaults to the CLI's mode.
 * @returns {{ changed: boolean, edits: Array<{from: string, to: string}> }}
 */
export function syncFile(file, actuals, { write = !CHECK_ONLY } = {}) {
  if (!existsSync(file)) return { changed: false, edits: [] };
  const original = readFileSync(file, 'utf-8');
  // Rewrite live sections only. Release notes state what was true at that
  // version, so auto-healing them to today's counts would falsify history —
  // frozen segments are carried through byte-for-byte.
  const edits = [];

  const updated = partitionFrozenHistory(original)
    .map((segment) => {
      if (segment.frozen) return segment.text;
      let text = segment.text;
      for (const { key, regex } of CLAIM_PATTERNS) {
        const actual = actuals[key];
        if (actual === null || actual === undefined) continue;
        text = text.replace(regex, (match, num, tail) => {
          if (parseClaimNumber(num) === actual) return match;
          // Keep the document's own separator style: "9,900+ tests" heals to
          // "14,953+ tests", while a bare "9900" stays ungrouped. `tail` is
          // reproduced verbatim, so a floor claim's "+" survives.
          const replacement = `${formatClaimNumber(actual, num)}${tail}`;
          edits.push({ from: match, to: replacement });
          return replacement;
        });
      }
      return text;
    })
    .join('');

  if (updated === original) return { changed: false, edits: [] };
  if (write) writeFileSync(file, updated);
  return { changed: true, edits };
}

function main() {
  const actuals = collectActuals();
  const targets = SYNC_TARGETS;

  console.log(`Artibot README claim sync (mode: ${CHECK_ONLY ? 'check' : 'write'})`);
  console.log('Actual counts:');
  for (const [k, v] of Object.entries(actuals)) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }
  console.log('');

  let anyChange = false;
  for (const file of targets) {
    const rel = path.relative(REPO_ROOT, file);
    const { changed, edits } = syncFile(file, actuals);
    if (!changed) continue;
    anyChange = true;
    console.log(`${rel}:`);
    for (const e of edits) {
      const verb = CHECK_ONLY ? 'would rewrite' : 'rewrote';
      console.log(`  ${YELLOW}${verb}${NC} "${e.from.trim()}" -> "${e.to.trim()}"`);
    }
  }

  if (!anyChange) {
    console.log(`${GREEN}README count prose already in sync — no changes.${NC}`);
    process.exit(0);
  }

  if (CHECK_ONLY) {
    console.log('');
    console.log(`${RED}Drift detected. Run \`node scripts/ci/sync-readme-claims.js\` to fix.${NC}`);
    process.exit(1);
  }

  console.log('');
  console.log(`${GREEN}README count prose synced to file-system counts.${NC}`);
  process.exit(0);
}

// Run only when invoked directly (node sync-readme-claims.js), not on import —
// tests import syncFile to exercise the write path against fixture files, and
// an unguarded main() would rewrite the real READMEs and process.exit the test
// worker. Mirrors the guard in validate-readme-claims.js.
const invokedDirectly = isMainEntry(import.meta.url);
if (invokedDirectly) main();
