/**
 * OB-07 / SH-15 (W2-6) — the two workflows that verify each carry the record
 * step, in the shape that was measured to work.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `commands/verify.md` Step 5 tells a model to file its verdict with
 * `scripts/ledger/record-verify.mjs`, and `tests/ledger/record-verify.test.js`
 * pins that wording. But `/verify` is one of THREE places a model verifies.
 * `/autopilot` Phase 4 (VERIFY) and `/team` Phase 4 / 4.5 (cross-check and
 * inspection) verify work too, and neither named the script, so a verified run
 * inside either left no `verify.completed` self-report line and no
 * evidence-registry row. Recorded before this limb (V5-BACKLOG OB-07, re-measure
 * 2026-09-28 04:16Z): `self_report` 0 across the ledger; SH-15's live registry
 * file did not exist.
 *
 * The three causes measured for verify.md (V5-BACKLOG §4-d, "§4 ③ 원인 3개")
 * apply to the new carriers unchanged, and each is pinned here in BOTH of them:
 *   (a) the call was a bullet, and a bullet is read as commentary — it must sit
 *       in a NUMBERED step;
 *   (b) a relative `node scripts/ledger/...` resolves only when the cwd is the
 *       source repository's `plugins/artibot` — the `REC=` chain must resolve
 *       from anywhere, `$HOME` first;
 *   (c) the host exports `CLAUDE_CODE_SESSION_ID`, not `CLAUDE_SESSION_ID` — a
 *       call reading only the first spelling records `recorded:false`.
 *
 * ── WHERE THE STEP LIVES, AND ONE CORRECTION TO THE PLAN ────────────────────
 * The plan row for W2-6 says "team Phase 3.5(검증)". `commands/team.md` has no
 * such phase: Phase 3.5 is the progress-bar section
 * (`schemas/completion-block-carriers.json#carriers[0].progressBarAnchor`).
 * The phases that verify are 4 (cross-check) and 4.5 (inspection), so the team
 * step sits at the end of 4.5, between the inspection material and
 * `### 중계 계약`. In `commands/autopilot.md` it sits at the end of
 * `#### Phase 4 — VERIFY`. Each is asserted to lie INSIDE its verification
 * section, not merely somewhere in the file.
 *
 * ── WHAT IS PINNED ──────────────────────────────────────────────────────────
 *  - the whole fenced line, byte for byte, once per file (`verify.md` Step 5's
 *    line plus one `--evidence` argument);
 *  - that it sits in a fenced block inside a numbered step and that a LATER
 *    numbered step reads `recorded`;
 *  - the sentence "Recording never changes the VERDICT.";
 *  - that the step is ordered before the thing it must not be skipped by;
 *  - that every flag the line names is one the REAL CLI accepts, and that the
 *    resulting rows are counted by the real reader as one self-report with an
 *    evidence-registry row behind it.
 *
 * ── WHAT THIS FILE CANNOT SEE (rules §9 — written beside the gate) ──────────
 *  - WHETHER ANY MODEL RUNS THE STEP. This pins wording. A model that skips a
 *    numbered step leaves every assertion here green.
 *  - THE SHELL LINE ITSELF IS NEVER EXECUTED HERE. Only its flags are fed to
 *    the real CLI through `node`. A quoting mistake in the line, or a wrong
 *    `[ -f ]` chain, is guarded by the byte pin and by a manual literal probe,
 *    not by a run in this suite. The `${A:-$B}` fallback is POSIX shell
 *    semantics that nothing here exercises.
 *  - THE INSTALLED COPIES. This reads the commands in THIS worktree.
 *    `~/.claude/commands` and the plugin cache can lag by releases.
 *  - THE PROSE RULES. Only the load-bearing sentences are pinned. What counts
 *    as PASS, what counts as evidence and the skip-when-nothing-ran rule are
 *    prose; a reworded rule stays green.
 *  - WHETHER `--status PASS` IS TRUE. Nothing behind the flag ran a linter.
 *  - OTHER COMMANDS THAT VERIFY. `/go`, `/implement`, `/orchestrate` and the
 *    rest are outside this limb and are not inventoried here.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * Like `tests/ledger/record-verify.test.js`: every case that spawns the CLI
 * builds its own temp root carrying `.git/`, passes it as BOTH the child cwd
 * and `--cwd`, and blanks BOTH session spellings in the child env so the host
 * session cannot reach a row. Nothing here can touch the repository's ledger.
 *
 * @module tests/commands/verify-record-steps
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { evidenceRegistryPath } from '../../lib/verification/evidence-registry.js';
import { computeVerifyRate } from '../../lib/verification/verify-rate.js';
import { SELF_REPORT_NOTE } from '../../scripts/ledger/record-verify.mjs';

// The real-CLI case spawns a child process. The budget buys headroom for load;
// nothing here waits on a timer.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'record-verify.mjs');

const SID = 'sessW26000001';

/** Both env spellings blanked — the only spelling of "no host session" that holds. */
const NO_SESSION_ENV = { CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' };

/** The one argument this limb adds to `commands/verify.md` Step 5's line. */
const EVIDENCE_ARG = ' --evidence "<path:line|command>"';

/**
 * The whole fenced line, resolution chain included, byte for byte. Spelled out
 * rather than built from `verify.md`, so a wording change here is a visible
 * edit; the parity test at the bottom ties it back to `verify.md`.
 */
const DOC_LINE = 'REC="$HOME/.claude/artibot/scripts/ledger/record-verify.mjs";'
  + ' [ -f "$REC" ] || REC="${CLAUDE_PLUGIN_ROOT:-}/scripts/ledger/record-verify.mjs";'
  + ' [ -f "$REC" ] || REC="plugins/artibot/scripts/ledger/record-verify.mjs";'
  + ' if [ -f "$REC" ]; then node "$REC" --status <PASS|FAIL> --command "<one-line summary>"'
  + EVIDENCE_ARG
  + ' --session "${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}" --cwd "<project root>";'
  + ' else echo "record-verify not found - outcome NOT recorded"; fi';

/** The flags the line is expected to name — the cardinality anchor for the CLI case. */
const DOC_FLAGS = ['--status', '--command', '--evidence', '--session', '--cwd'];

/** The three places the script may live, in the order the chain must try them. */
const CHAIN = [
  '$HOME/.claude/artibot/scripts/ledger/record-verify.mjs',
  '${CLAUDE_PLUGIN_ROOT:-}/scripts/ledger/record-verify.mjs',
  'plugins/artibot/scripts/ledger/record-verify.mjs',
];

/**
 * The two verifying workflows. `verifyStart`/`verifyStop` bound the section that
 * does the verifying; `stepStart` is where the record step begins INSIDE it;
 * `before` is the sentence shape that orders the step ahead of what it must not
 * be skipped by.
 */
const CARRIERS = [
  {
    file: 'autopilot.md',
    verifyStart: '#### Phase 4 — VERIFY',
    verifyStop: '\n#### Phase 5 — IMPROVE',
    stepStart: '**VERIFY 마감 — 원장 기록 (번호 단계).**',
    // The record step must precede `recordPhaseResult(VERIFY)`: that call can
    // end in PAUSED, and a step placed after it vanishes on the failure path.
    before: /recordPhaseResult[\s\S]{0,80}\*\*전에\*\*/,
  },
  {
    file: 'team.md',
    verifyStart: '### Phase 4.5: INSPECTION',
    verifyStop: '\n### 중계 계약',
    stepStart: '#### Phase 4.5 마감 — 검증 기록 (Leader only, 번호 단계)',
    // The record step must precede whatever the verdict sets in motion.
    before: /\*\*전에\*\*/,
  },
];

/** A command file, newline-normalized. */
function read(file) {
  return readFileSync(path.join(COMMANDS_DIR, file), 'utf-8').replace(/\r\n/g, '\n');
}

/** How many times `needle` occurs in `haystack`. */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** The verification section, or null when either bound is missing or misordered. */
function verifySection(doc, carrier) {
  const start = doc.indexOf(carrier.verifyStart);
  if (start === -1) return null;
  const stop = doc.indexOf(carrier.verifyStop, start);
  return stop === -1 ? null : doc.slice(start, stop);
}

/** From the record step's start to the end of the verification section, or null. */
function stepBlock(doc, carrier) {
  const section = verifySection(doc, carrier);
  if (section === null) return null;
  const at = section.indexOf(carrier.stepStart);
  return at === -1 ? null : section.slice(at);
}

/** Column-0 numbered items of `text`, as their numbers, in order. */
function numberedItems(text) {
  return [...text.matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1]));
}

/** The lines of `doc` that hold the invocation. */
function callLines(doc) {
  return doc.split('\n').filter((line) => line.includes('node "$REC"'));
}

/** @type {string} */
let tmp;

/** A project root the Artibot guards will actually run inside. */
function makeRoot(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** Run the real CLI inside a project root, with the host session blanked. */
function runCli(args, root) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd: root, env: { ...process.env, ...NO_SESSION_ENV },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** Every well-formed event in a project's ledger. */
function ledgerEvents(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** Parsed rows of a root's evidence registry; `[]` when it was never written. */
function registryRows(root) {
  const file = evidenceRegistryPath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-vrsteps-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe.each(CARRIERS)('verify record step: $file', (carrier) => {
  const { file } = carrier;

  it('has its verification section and its record step heading, each exactly once', () => {
    const doc = read(file);
    expect(countOf(doc, carrier.verifyStart), `${carrier.verifyStart} in ${file}`).toBe(1);
    expect(countOf(doc, carrier.stepStart), `${carrier.stepStart} in ${file}`).toBe(1);
  });

  it('keeps the record step inside the verification section', () => {
    const doc = read(file);
    const section = verifySection(doc, carrier);
    expect(section, `${file}: verification section bounds not found`).not.toBeNull();
    expect(section).toContain(carrier.stepStart);
    expect(section).toContain(DOC_LINE);
  });

  it('spells the invocation exactly once, resolution chain and flags included', () => {
    const doc = read(file);
    // Exactly once: two copies drift, and a model told twice records twice.
    expect(countOf(doc, DOC_LINE), `the fenced line in ${file}`).toBe(1);
    // And no SECOND, differently worded invocation. `node "$REC"` is the only
    // spelling this document may use to run the script.
    expect(countOf(doc, 'node "$REC"')).toBe(1);
    // Cause (b): a direct-path call is exactly the shape that only resolves
    // inside the source repository.
    expect(doc.match(/node\s+\S*record-verify\.mjs/g) ?? []).toEqual([]);
  });

  it('resolves the script from anywhere and reads the session from either spelling', () => {
    const lines = callLines(read(file));
    expect(lines, `${file} must hold the invocation on exactly one line`).toHaveLength(1);
    const [line] = lines;

    // Cause (b): all three locations, and in this order — `$HOME` first because
    // `${CLAUDE_PLUGIN_ROOT}` can be empty in a Bash shell.
    const at = CHAIN.map((part) => line.indexOf(part));
    expect(at.every((i) => i > -1), `every REC location present: ${JSON.stringify(at)}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    // Cause (c): the second spelling is the one this host actually sets.
    expect(line).toContain('--session "${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}"');
    // A record filed from the wrong directory lands in the wrong project's ledger.
    expect(line).toContain('--cwd "<project root>"');
    // SH-15: the registry row is minted from the evidence the caller names.
    expect(line).toContain(EVIDENCE_ARG.trim());
  });

  it('puts the call in a fenced line inside a numbered step, and reads recorded in a later one', () => {
    const block = stepBlock(read(file), carrier);
    expect(block, `${file}: record step block not found`).not.toBeNull();
    const callAt = block.indexOf('node "$REC"');
    expect(callAt, `the call inside the ${file} record step`).toBeGreaterThan(-1);
    const beforeCall = block.slice(0, callAt);
    const afterCall = block.slice(callAt);

    // Cause (a): NUMBERED, not a bullet. The list before the call starts at 1
    // and has no gaps, and the closest list marker above the call is a number.
    const numbers = numberedItems(beforeCall);
    expect(numbers.length).toBeGreaterThanOrEqual(1);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
    const markers = beforeCall.split('\n').filter((line) => /^(\d+\.|[-*])\s/.test(line));
    expect(markers[markers.length - 1]).toMatch(/^\d+\.\s/);

    // The line is inside a code fence (an odd number of fence lines above it),
    // so "run exactly this" stays copy-pasteable rather than prose.
    expect((beforeCall.match(/^\s*```/gm) ?? []).length % 2).toBe(1);

    // The result is read from stdout in a LATER numbered step — the script
    // exits 0 even when it recorded nothing.
    expect(afterCall).toMatch(/^\d+\.\s.*`recorded`/m);
  });

  it('says recording never changes the verdict', () => {
    const block = stepBlock(read(file), carrier);
    expect(block, `${file}: record step block not found`).not.toBeNull();
    expect(block).toContain('Recording never changes the VERDICT.');
  });

  it('orders the step before what it must not be skipped by', () => {
    const block = stepBlock(read(file), carrier);
    expect(block, `${file}: record step block not found`).not.toBeNull();
    const firstItem = block.search(/^1\.\s/m);
    expect(firstItem, `${file}: the numbered list has a first item`).toBeGreaterThan(-1);
    expect(block.slice(0, firstItem)).toMatch(carrier.before);
  });

  it('feeds every flag the doc names to the real CLI, and the reader counts one self-report', () => {
    const lines = callLines(read(file));
    expect(lines, `${file} must hold the invocation on exactly one line`).toHaveLength(1);

    const flags = lines[0].match(/--[a-z][a-z-]*/g) ?? [];
    // CARDINALITY ANCHOR. Without this the run below could iterate an empty flag
    // list and pass while the doc named nothing at all.
    expect(flags).toEqual(DOC_FLAGS);

    const root = makeRoot(file.replace(/\W/g, ''));
    const values = {
      '--status': 'PASS',
      '--command': `${file}: doc-pinned invocation`,
      '--evidence': 'tests/x.test.js:12',
      '--session': SID,
      '--cwd': root,
    };
    const out = runCli(flags.flatMap((flag) => [flag, values[flag]]), root);

    // A flag the doc invented would be rejected as an unknown argument (exit 2),
    // which is precisely the drift a wording-only pin cannot see.
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
    const printed = JSON.parse(out.stdout);
    expect(printed.recorded).toBe(true);
    expect(printed.appended).toBe(4);

    // Exit 0 and `recorded:true` are the script's account of itself. The ROWS
    // are the evidence: four lines, none rejected, the marker on the
    // deterministic one, and the real reader folding them into one self-report.
    const events = ledgerEvents(root);
    expect(events.filter((e) => e.event === 'ledger.rejected')).toEqual([]);
    const rows = events.filter((e) => e.event === 'verify.completed');
    expect(rows).toHaveLength(4);
    const deterministic = rows.find((e) => e.data.layer === 'deterministic');
    expect(deterministic.data.evidence[0].note).toBe(SELF_REPORT_NOTE);
    expect(computeVerifyRate(rows).ids.self_report).toBe(1);

    // SH-15: the `--evidence` ref became a registry row beside the ledger.
    const registry = registryRows(root);
    expect(registry.length).toBeGreaterThanOrEqual(1);
    expect(registry.some((row) => row.type === 'file')).toBe(true);
  });
});

describe('verify record step: shared with commands/verify.md', () => {
  it('differs from verify.md Step 5 by the --evidence argument and nothing else', () => {
    const verifyLines = read('verify.md')
      .split('\n')
      .filter((line) => line.startsWith('REC="$HOME/.claude/artibot/'));
    // CARDINALITY ANCHOR: exactly one Step 5 line to compare against.
    expect(verifyLines).toHaveLength(1);
    const expected = verifyLines[0].trim();
    expect(DOC_LINE.replace(EVIDENCE_ARG, '')).toBe(expected);

    for (const { file } of CARRIERS) {
      const lines = callLines(read(file));
      expect(lines, `${file} must hold the invocation on exactly one line`).toHaveLength(1);
      // The chain, the session fallback and the else branch cannot drift from
      // verify.md's: the three copies move together or this goes red.
      expect(lines[0].trim().replace(EVIDENCE_ARG, '')).toBe(expected);
    }
  });
});
