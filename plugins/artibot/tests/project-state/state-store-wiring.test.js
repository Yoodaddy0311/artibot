/**
 * Evidence gate — `/doctor` Checks 8 and 9 reach a VERDICT on real wiring
 * output.
 *
 * Every other Check-8 test in this repo feeds `checkLedgerStateParity`
 * hand-built fixtures. That proves the comparison logic and nothing about the
 * pipeline: if the wiring wrote no journal, or wrote it somewhere Check 8 does
 * not look, the check returns `unmeasured` — and `unmeasured` is not a
 * failure, so a green suite would keep saying so forever. This file closes
 * that gap by running the middleware for real and requiring the check to come
 * back with an actual judgement.
 *
 * Check 9 (`checkStateVersionGaps`) is called on the SAME journal, because a
 * clean parity result does not imply a clean version sequence: parity compares
 * the store against the ledger and the projection, and never looks at whether
 * the store's own `state_version` run is well formed. Measured 09:13 on
 * 2026-09-05, that check FAILED on this very fixture.
 *
 * The inputs come from the three production readers, not from the store
 * handle: `readLedgerCensus` off disk, `readJournal` off the store's own
 * journal file, and `state.yaml` as RAW TEXT. Text matters — with a string,
 * `compareProjection` re-renders from the journal and compares BYTE FOR BYTE,
 * which is the strict form. Handing it a parsed object would fall to the
 * structural comparison and stop measuring the renderer.
 *
 * ── What this gate CANNOT see ─────────────────────────────────────────────
 * Written here so the gate does not become the next false-confidence signal:
 *
 *  - **Single process, single thread.** One middleware call, one commit. The
 *    store's file lock is advisory and fail-OPEN, so nothing here measures
 *    what two writers do to each other.
 *  - **Real concurrency.** No contention is generated. A lost update under
 *    load would not show up in any assertion below.
 *  - **Ledger distribution across worktrees.** The ledger is resolved from a
 *    single `projectRoot`. Whether N `/split` windows converge on ONE ledger
 *    while the store converges on ONE git common dir is the whole point of
 *    the design, and it is NOT measured here — this fixture has one root.
 *  - **Store/ledger co-location.** The store lands under the git COMMON dir
 *    and the ledger under `<projectRoot>/.artibot/runtime/`. In a linked
 *    worktree those diverge. This tmpdir is a plain checkout, so the two
 *    resolve to the same repository by construction.
 *  - **Adjacent same-version records.** Check 9 folds a run of equal
 *    `state_version` values into ONE transaction, which is what makes the
 *    healthy [1, 1, 2] below pass. Journal records carry no transaction id, so
 *    two genuinely separate writes that both landed on one version and sit
 *    next to each other are indistinguishable from one multi-record commit and
 *    are NOT caught — here or by Check 9. Verified 09:16 on 2026-09-05 that
 *    NON-adjacent duplicates, gaps and regressions still are.
 *  - **Volume.** At most two prompts and three journal records. Fold behaviour
 *    over a long journal, the 4 KB ledger line cap and dedupe under real seq
 *    pressure are all outside the fixture's reach. Nothing here measures a
 *    version sequence long enough for a gap to hide in the middle of it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTasksMiddleware } from '../../lib/runtime/middleware/tasks.js';
import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { readJournal } from '../../lib/project-state/state-manager.js';
import { checkLedgerStateParity, checkStateVersionGaps, CheckStatus } from '../../lib/project-state/doctor-checks.js';

const SESSION_ID = 'sess-e247a22f-parity';
const NOW_MS = 1700000000000;

/**
 * Substantive by signal S5, measured by running `compileMission` directly
 * (2026-09-05) rather than read off the gate's source. See the equivalent note
 * in `tests/runtime/middleware/tasks.test.js`.
 */
const SUBSTANTIVE = '/implement add a retry guard to the ledger writer';

const roots = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

/** One prompt payload against the given root. */
const promptState = (projectRoot) => ({
  input: {
    prompt: SUBSTANTIVE,
    hookData: { cwd: projectRoot, session_id: SESSION_ID },
  },
  context: {
    routing: { system: 'system1', score: 0.3 },
    intent: { best: 'action:implement', commands: [], agents: [], ambiguous: false },
  },
  messageParts: [],
  userPrompt: SUBSTANTIVE,
});

/**
 * Run the middleware `runs` times over ONE fresh repository and collect exactly
 * what `/doctor` Checks 8 and 9 would collect.
 *
 * The same middleware instance serves every run, as a real session would: a
 * fresh instance per prompt would hide any state the closure carries.
 *
 * @param {number} [runs=1] - How many prompts to submit.
 * @returns {Promise<object>} `{parity, gaps, projectRoot, project, projection, events, journal, census}`.
 */
async function runAndInspect(runs = 1) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-parity-'));
  roots.push(projectRoot);
  mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

  const middleware = createTasksMiddleware({ now: () => NOW_MS });
  for (let i = 0; i < runs; i += 1) {
    await middleware(promptState(projectRoot));
  }

  const journalPath = path.join(projectRoot, '.git', 'artibot', 'project-state.jsonl');
  const projectionPath = path.join(projectRoot, '.artibot', 'state.yaml');

  const { events, census } = readLedgerCensus(projectRoot);
  const journal = existsSync(journalPath) ? readJournal(journalPath).records : undefined;
  const projection = existsSync(projectionPath)
    ? readFileSync(projectionPath, 'utf8')
    : undefined;

  // `createStateStore` defaults `project` to `path.basename(projectRoot)`, and
  // the wiring passes no override. It is supplied EXPLICITLY rather than left
  // to Check 8's own `?? 'artibot'` default, which would rename the project
  // mid-comparison and surface as a projection drift that is really a naming
  // mismatch. The assumption is asserted on its own below, so a wiring that
  // chose another name fails loudly instead of hiding inside a drift finding.
  const project = path.basename(projectRoot);
  const parity = checkLedgerStateParity({ events, journal, projection, project, census });
  const gaps = checkStateVersionGaps({ journal });

  return { parity, gaps, projectRoot, project, projection, events, journal, census };
}

/** The single-prompt case the parity assertions below are written against. */
const runOnceAndInspect = () => runAndInspect(1);

describe('state-store wiring — /doctor Check 8 produces evidence, not "unmeasured"', () => {
  it('supplies all three parity inputs, so the check is actually measured', async () => {
    const { parity, events, journal, projection } = await runOnceAndInspect();

    expect(Array.isArray(events)).toBe(true);
    expect(Array.isArray(journal)).toBe(true);
    expect(typeof projection).toBe('string');

    expect(parity.status).not.toBe(CheckStatus.UNMEASURED);
    expect(parity.findings.map((f) => f.code)).not.toContain('parity-inputs-absent');
  });

  it('finds neither a ledger-subset violation nor projection drift', async () => {
    const { parity } = await runOnceAndInspect();
    const codes = parity.findings.map((f) => f.code);

    // A store version with no paired ledger event IS the lost-update
    // signature; drift means the journal no longer reproduces state.yaml.
    expect(codes).not.toContain('ledger-subset-violation');
    expect(codes).not.toContain('projection-drift');
  });

  it('reaches an outright pass, with no warning left standing', async () => {
    const { parity } = await runOnceAndInspect();
    expect(parity.findings).toEqual([]);
    expect(parity.status).toBe(CheckStatus.PASS);
  });

  it('counts a clean ledger — the census dropped nothing', async () => {
    const { parity, census } = await runOnceAndInspect();

    expect(census.file.present).toBe(true);
    expect(census.file.readable).toBe(true);
    expect(parity.census.status).toBe(CheckStatus.PASS);
  });

  it('names the project the store actually used', async () => {
    const { project, projection } = await runOnceAndInspect();
    expect(projection).toContain(project);
  });

  it('leaves no version gap or duplicate after a second prompt commits', async () => {
    // TWO prompts, deliberately. The first commit writes `mission.upsert` AND
    // `graph.upsert` under ONE `state_version`; the second writes
    // `mission.upsert` alone, because the graph already exists. So the journal
    // reads [1, 1, 2] — a repeated version that is one transaction, not two
    // writes. That multi-record first commit IS the failure region, and a
    // single-prompt fixture ([1, 1]) would never reach the second transaction
    // at all. Asserting the shape first means a change in the store's record
    // plan shows up here as itself rather than as a mysterious Check 9 verdict.
    const { gaps, journal } = await runAndInspect(2);
    expect(journal.map((r) => r.state_version)).toEqual([1, 1, 2]);

    // A gap is a lost committed write; a duplicate is two writes claiming one
    // version. Neither is what a healthy multi-record transaction looks like.
    expect(gaps.gaps).toEqual([]);
    expect(gaps.duplicates).toEqual([]);
    expect(gaps.regressions).toEqual([]);
    expect(gaps.status).toBe(CheckStatus.PASS);
  });
});
