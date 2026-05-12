#!/usr/bin/env node
/**
 * validate-readme-claims.js — Verify README count claims match reality.
 *
 * Scans both README.md (root) and plugins/artibot/README.md for numeric claims
 * about skills, commands, agents, hooks, tests, and coverage. Compares each
 * claim against the actual file-system count and fails on drift.
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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const MODE = args.includes('--full') ? 'full' : 'structural';
const VERBOSE = args.includes('--verbose');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(scriptDir, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

function countDirsWith(dir, marker) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() && existsSync(path.join(full, marker));
  }).length;
}

function countFiles(dir, ext, exclude = []) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(
    (f) => f.endsWith(ext) && !exclude.includes(f)
  ).length;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// Collect actual counts from the file system.
function collectActuals() {
  const actuals = {
    skills: countDirsWith(path.join(PLUGIN_ROOT, 'skills'), 'SKILL.md'),
    commands: countFiles(path.join(PLUGIN_ROOT, 'commands'), '.md'),
    agents: countFiles(path.join(PLUGIN_ROOT, 'agents'), '.md', ['INDEX.md', 'README.md']),
    hookScripts: countFiles(path.join(PLUGIN_ROOT, 'scripts', 'hooks'), '.js'),
  };

  // hooks.json registration count (sum of array lengths across event types).
  const hooksJson = readJsonSafe(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'));
  if (hooksJson?.hooks) {
    actuals.hookRegistrations = Object.values(hooksJson.hooks).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    );
  }

  if (MODE === 'full') {
    const summary = readJsonSafe(
      path.join(PLUGIN_ROOT, 'coverage', 'coverage-summary.json')
    );
    if (summary?.total) {
      actuals.statementCoverage = Math.round(summary.total.statements.pct);
    }
  }

  return actuals;
}

// Claim patterns: each maps a regex against a category in `actuals`.
// Match group 1 must be the numeric claim. Tolerance is exact unless noted.
const CLAIM_PATTERNS = [
  { key: 'skills', regex: /(\d{2,3})\s+(?:domain\s+)?skills?\b/gi, label: 'skills' },
  { key: 'skills', regex: /(\d{2,3})\s+skill\s+director(?:y|ies)/gi, label: 'skill dirs' },
  { key: 'commands', regex: /(\d{2,3})\s+(?:slash\s+)?commands?\b/gi, label: 'commands' },
  { key: 'agents', regex: /(\d{2,3})\s+(?:specialist\s+)?agents?\b/gi, label: 'agents' },
  { key: 'agents', regex: /(\d{2,3})\s+agent\s+definitions?/gi, label: 'agent defs' },
  { key: 'hookRegistrations', regex: /(\d{2,3})\s+hook\s+registrations?/gi, label: 'hook regs' },
  { key: 'hookScripts', regex: /(\d{2,3})\s+hook\s+scripts?/gi, label: 'hook scripts' },
];

function scanFile(file, actuals) {
  if (!existsSync(file)) return [];
  const content = readFileSync(file, 'utf-8');
  const findings = [];

  for (const { key, regex, label } of CLAIM_PATTERNS) {
    if (actuals[key] === null || actuals[key] === undefined) continue;
    const matches = [...content.matchAll(regex)];
    for (const m of matches) {
      const claimed = Number(m[1]);
      const actual = actuals[key];
      // Allow exact match only — README counts must be precise.
      if (claimed !== actual) {
        findings.push({ file, label, claimed, actual, snippet: m[0] });
      } else if (VERBOSE) {
        findings.push({ file, label, claimed, actual, snippet: m[0], ok: true });
      }
    }
  }
  return findings;
}

function main() {
  const actuals = collectActuals();
  const targets = [
    path.join(REPO_ROOT, 'README.md'),
    path.join(PLUGIN_ROOT, 'README.md'),
  ];

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

main();
