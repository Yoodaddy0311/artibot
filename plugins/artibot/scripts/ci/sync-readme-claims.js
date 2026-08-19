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
 *   (default)  — Rewrite drifting prose in README.md (root) and
 *                plugins/artibot/README.md. Idempotent: a no-op when in sync.
 *   --check    — Report would-be changes and exit 1 if any (CI dry-run); makes
 *                no writes. Exit 0 when already in sync.
 *
 * Exit codes:
 *   0 — files already in sync (or were successfully rewritten in write mode)
 *   1 — (--check only) drift detected that a write run would fix
 *
 * Scope: only structural counts (skills, commands, agents, hook scripts, hook
 * registrations). Coverage/test counts live in --full validator territory and
 * are deliberately NOT auto-rewritten here (they are remote/threshold claims,
 * not file-system facts a release should silently mutate).
 *
 * Zero dependencies. Node 20+ built-ins only.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLAIM_PATTERNS,
  collectActuals,
  PLUGIN_ROOT,
  REPO_ROOT,
  splitFrozenHistory,
} from './readme-claims-registry.js';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

// Rewrite drifting prose in a single file. Returns { changed, edits }.
function syncFile(file, actuals) {
  if (!existsSync(file)) return { changed: false, edits: [] };
  const original = readFileSync(file, 'utf-8');
  // Rewrite the live region only. Release notes state what was true at that
  // version, so auto-healing them to today's counts would falsify history —
  // `frozen` is carried through byte-for-byte and re-appended below.
  const { scanned, frozen } = splitFrozenHistory(original);
  const edits = [];

  let updated = scanned;
  for (const { key, regex } of CLAIM_PATTERNS) {
    const actual = actuals[key];
    if (actual === null || actual === undefined) continue;
    updated = updated.replace(regex, (match, num, tail) => {
      if (Number(num) === actual) return match;
      edits.push({ from: match, to: `${actual}${tail}` });
      return `${actual}${tail}`;
    });
  }

  if (updated === scanned) return { changed: false, edits: [] };
  if (!CHECK_ONLY) writeFileSync(file, updated + frozen);
  return { changed: true, edits };
}

function main() {
  const actuals = collectActuals();
  const targets = [
    path.join(REPO_ROOT, 'README.md'),
    path.join(PLUGIN_ROOT, 'README.md'),
  ];

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

main();
