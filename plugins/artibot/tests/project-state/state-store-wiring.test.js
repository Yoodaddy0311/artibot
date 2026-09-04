/**
 * Evidence gate — `/doctor` Check 8 reaches a VERDICT on real wiring output.
 *
 * Every other Check-8 test in this repo feeds `checkLedgerStateParity`
 * hand-built fixtures. That proves the comparison logic and nothing about the
 * pipeline: if the wiring wrote no journal, or wrote it somewhere Check 8 does
 * not look, the check returns `unmeasured` — and `unmeasured` is not a
 * failure, so a green suite would keep saying so forever. This file closes
 * that gap by running the middleware for real and requiring the check to come
 * back with an actual judgement.
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
 *  - **Volume.** One mission, one write. Fold behaviour over a long journal,
 *    the 4 KB ledger line cap and dedupe under real seq pressure are all
 *    outside the fixture's reach.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTasksMiddleware } from '../../lib/runtime/middleware/tasks.js';
import { readLedgerCensus } from '../../lib/runtime/ledger.js';
import { readJournal } from '../../lib/project-state/state-manager.js';
import { checkLedgerStateParity, CheckStatus } from '../../lib/project-state/doctor-checks.js';

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

/**
 * Run the middleware once over a fresh repository and collect exactly what
 * `/doctor` Check 8 would collect.
 *
 * @returns {Promise<object>} `{parity, projectRoot, project, projection, events, journal, census}`.
 */
async function runOnceAndInspect() {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-parity-'));
  roots.push(projectRoot);
  mkdirSync(path.join(projectRoot, '.git'), { recursive: true });

  await createTasksMiddleware({ now: () => NOW_MS })({
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

  return { parity, projectRoot, project, projection, events, journal, census };
}

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
});
