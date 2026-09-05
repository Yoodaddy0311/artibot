#!/usr/bin/env node
/**
 * validate-readme-claims.js — Verify README count claims match reality.
 *
 * Scans README.md (root), plugins/artibot/README.md, and plugins/artibot/CLAUDE.md
 * for numeric claims about skills, commands, agents, hooks, tests, and coverage.
 * Compares each claim against the actual file-system count and fails on drift.
 *
 * Modes:
 *   structural (default)  — Counts files only. Fast (<1s). PR gate.
 *   full                  — Adds remote checks (test count + coverage thresholds
 *                           from coverage-summary.json). main-branch gate.
 *
 * Exit codes:
 *   0 — all claims match (within tolerance)
 *   1 — at least one claim drifts beyond tolerance
 *
 * Tolerance: ±5% for "≈" claims (e.g., "~99 skills"), exact for badges.
 *
 * Zero dependencies. Node 20+ built-ins only.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLAIM_PATTERNS,
  collectActuals,
  parseClaimNumber,
  partitionFrozenHistory,
  REPO_ROOT,
  SCAN_TARGETS,
} from './readme-claims-registry.js';
import { isMainEntry } from '../hooks/_main-entry.js';

// Files scanned for count claims. The list itself lives in the registry
// (readme-claims-registry.js#SCAN_TARGETS) alongside the patterns, so the gate
// and the auto-fixer cannot disagree about which files carry claims — the same
// reason the regexes are shared. Re-exported here because callers and tests
// have imported `SCAN_TARGETS` from this module since it was introduced.
//
// History worth keeping: marketplace.json was added on 2026-08-22 after its
// `description` / `shortDescription` / screenshot captions were found carrying
// "N agents, N skills, N commands" claims that nothing watched —
// `sync-marketplace-meta.mjs` only touches `version`, `qualityMetrics.tests`
// and `release.current`. Measured drift then: `75 commands` vs 78 actual, while
// both READMEs already said 78. Scanning it is claim-shaped, not JSON-shaped:
// the patterns need a digit immediately followed by " commands"/" skills"/
// " agents", so structural fields like `"count": 78` are invisible here — those
// are asserted in `tests/ci/marketplace-version-sync.test.js` instead. Probe on
// the unfixed file returned exactly 1 finding and 0 false positives.
//
// That entry, and CLAUDE.md's, used to be validate-only ("fixed by hand"). As
// of 2026-09-05 both are synced: the hand-fix never happened, and the file was
// caught disagreeing with ITSELF — `description` said `9,900+ tests` while
// `qualityMetrics.tests` in the same file said 14953.
export { SCAN_TARGETS };

const args = process.argv.slice(2);
const MODE = args.includes('--full') ? 'full' : 'structural';
const VERBOSE = args.includes('--verbose');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

/**
 * Scan one file for count claims that disagree with `actuals`.
 *
 * Exported so the gate's own decision logic is testable against fixture files
 * (a pattern-level test would only prove the regex matches, not that a wrong
 * count actually produces a finding, nor that frozen history is skipped).
 *
 * @param {string} file - Absolute path; a missing file yields [].
 * @param {Record<string, number>} actuals - Counts from collectActuals().
 * @returns {Array<{file:string,label:string,claimed:number,actual:number,snippet:string,ok?:boolean}>}
 */
export function scanFile(file, actuals) {
  if (!existsSync(file)) return [];
  // Only live sections are claim-checked; release-note sections record what was
  // true at that version and must stay frozen (see partitionFrozenHistory).
  // Segments are scanned individually rather than concatenated so a match can
  // never straddle the boundary between two non-adjacent live sections.
  const live = partitionFrozenHistory(readFileSync(file, 'utf-8')).filter((s) => !s.frozen);
  const findings = [];

  for (const { key, regex, label } of CLAIM_PATTERNS) {
    if (actuals[key] === null || actuals[key] === undefined) continue;
    for (const segment of live) {
      for (const m of segment.text.matchAll(regex)) {
        // parseClaimNumber, not Number(): group 1 may be "9,900".
        const claimed = parseClaimNumber(m[1]);
        const actual = actuals[key];
        // Allow exact match only — README counts must be precise.
        if (claimed !== actual) {
          findings.push({ file, label, claimed, actual, snippet: m[0] });
        } else if (VERBOSE) {
          findings.push({ file, label, claimed, actual, snippet: m[0], ok: true });
        }
      }
    }
  }
  return findings;
}

function main() {
  const actuals = collectActuals({ full: MODE === 'full' });
  const targets = SCAN_TARGETS;

  console.log(`Artibot README claim validator (mode: ${MODE})`);
  console.log('Actual counts:');
  for (const [k, v] of Object.entries(actuals)) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }
  console.log('');

  const drifts = [];
  for (const file of targets) {
    const rel = path.relative(REPO_ROOT, file);
    const findings = scanFile(file, actuals);
    const driftsHere = findings.filter((f) => !f.ok);
    if (VERBOSE && findings.length > 0) {
      console.log(`${rel}:`);
      findings.forEach((f) => {
        const tag = f.ok ? `${GREEN}OK${NC}` : `${RED}DRIFT${NC}`;
        console.log(`  ${tag} [${f.label}] claimed=${f.claimed} actual=${f.actual} (${f.snippet.trim()})`);
      });
    }
    drifts.push(...driftsHere);
  }

  if (drifts.length === 0) {
    console.log(`${GREEN}All README claims match file-system counts.${NC}`);
    process.exit(0);
  }

  console.log(`${RED}README claim drift detected (${drifts.length} mismatch${drifts.length === 1 ? '' : 'es'}):${NC}`);
  for (const d of drifts) {
    const rel = path.relative(REPO_ROOT, d.file);
    console.log(`  ${RED}✗${NC} ${rel}: "${d.snippet.trim()}" — claimed ${YELLOW}${d.claimed}${NC}, actual ${GREEN}${d.actual}${NC} (${d.label})`);
  }
  console.log('');
  console.log('Fix: update the README to match actual counts, or run the relevant');
  console.log('count-update script. Run with --verbose to see all matches.');
  process.exit(1);
}

// Run only when invoked directly (node validate-readme-claims.js), not on import
// — tests import SCAN_TARGETS without triggering the process.exit path.
const invokedDirectly = isMainEntry(import.meta.url);
if (invokedDirectly) main();
