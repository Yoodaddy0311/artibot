/**
 * Gate for the NL-activation MEASURING INSTRUMENT
 * (`scripts/evals/nl-activation-report.mjs`).
 *
 * The property this file exists to pin is the one that would silently corrupt
 * the §3.7 exit criterion: `0/0` must report `ratio: null` (UNMEASURED), never
 * `0` (measured zero). No live store writes `command_activation` or
 * `activation_observed` today, so every activation ratio the runner prints
 * against the real repo is `null`. If that ever renders as `0`, a future reader
 * would read "0% agreement, the classifier is broken" off an axis that was
 * never measured at all — and `0` is also the honest answer for a real `0/5`,
 * so the two cases must stay distinguishable by type.
 *
 * WHAT THIS FILE DOES NOT SEE
 *  - Whether the ACTIVATION axes are correct against real data. Nothing writes
 *    those fields, so every store-backed assertion here runs on a synthetic
 *    ledger this file wrote itself. Only `mission.deferral-rate` has live
 *    numbers today.
 *  - Fixture size. All tmp fixtures are single-digit line counts; they say
 *    nothing about the runner's behaviour on the live canonical ledger, which is
 *    three orders of magnitude larger. Nor do they cover a git root whose
 *    fallback ledger exists and DIFFERS from the canonical one: measured
 *    2026-09-14 the parent repo's fallback is absent, so that shape has no
 *    live specimen to test against.
 *  - Whether the fixture's own agreement number means anything. It does not —
 *    see `FIXTURE_WARNING`.
 *
 * Every root is an `mkdtemp` directory. Pointing any of these at the real
 * project root would write into the live decisions store.
 *
 * @module tests/evals/nl-activation-report
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVATION_FIELDS,
  AXES,
  buildReport,
  collectStores,
  defaultFixturePath,
  FIXTURE_WARNING,
  loadFixtureCases,
  ratioOf,
} from '../../scripts/evals/nl-activation-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const RUNNER = path.join(PLUGIN_ROOT, 'scripts', 'evals', 'nl-activation-report.mjs');

/** @type {string} */
let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'nl-activation-'));
});

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * One ledger envelope line. `seq` is what keeps otherwise-identical lines from
 * colliding on `dedupeKey` (`lib/runtime/ledger.js#dedupeKey`, 2026-09-14) and
 * being dropped as duplicates before the fold ever sees them.
 *
 * @param {number} seq
 * @param {string} event
 * @param {object} data
 * @param {string} [sessionId]
 * @returns {string}
 */
function ledgerLine(seq, event, data, sessionId = 's-1') {
  return JSON.stringify({
    v: 1,
    ts: new Date(Date.UTC(2026, 8, 14, 0, 0, seq)).toISOString(),
    event,
    mission_id: `m-${seq}`,
    session_id: sessionId,
    source: 'hook',
    pid: 4242,
    seq,
    data,
  });
}

/**
 * Write `lines` to the fallback-shaped ledger path inside `root`. In a non-git
 * tmp root this is ALSO where the canonical resolver lands
 * (`lib/runtime/event-writer.js#ledgerFilePath` returns
 * `projectRoot + rel` when no git common dir resolves), which is exactly the
 * same-file overlap `same_as_canonical` exists to declare.
 *
 * @param {string} root
 * @param {string[]} lines
 */
function writeLedger(root, lines) {
  const dir = path.join(root, '.artibot', 'runtime');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'ledger.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

/**
 * @param {string} root
 * @param {string} runId
 * @param {object[]} events
 */
function writeDecisions(root, runId, events) {
  const dir = path.join(root, '.artibot', 'runtime', 'decisions');
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(path.join(dir, `${runId}.events.ndjson`), `${lines}\n`, 'utf8');
}

/**
 * Build the report for a tmp root the same way the CLI does.
 *
 * @param {string} root
 * @returns {Promise<object>}
 */
async function reportFor(root) {
  const stores = collectStores(root);
  const fixture = await loadFixtureCases(defaultFixturePath());
  return buildReport({ ...stores, fixture, measuredAt: '2026-09-14T00:00:00.000Z' });
}

/**
 * @param {object} report
 * @param {string} axis
 * @returns {object}
 */
function axis(report, axisName) {
  const found = report.axes.find((a) => a.axis === axisName);
  if (!found) throw new Error(`axis ${axisName} missing from report`);
  return found;
}

describe('ratioOf — unmeasured is null, measured zero is 0', () => {
  it('returns null for 0/0 rather than 0', () => {
    expect(ratioOf(0, 0)).toBeNull();
    expect(ratioOf(0, 0)).not.toBe(0);
  });

  it('returns 0 for a real 0/5 — a measured zero is not the same claim', () => {
    expect(ratioOf(0, 5)).toBe(0);
    expect(ratioOf(0, 5)).not.toBeNull();
  });

  it('rounds to 4 decimals', () => {
    expect(ratioOf(2, 3)).toBe(0.6667);
    expect(ratioOf(3, 3)).toBe(1);
  });
});

describe('empty project root — every axis is UNMEASURED, not zero', () => {
  it('reports ratio null and denominator 0 on all three axes', async () => {
    const report = await reportFor(tmpRoot);

    expect(report.schema).toBe('nl-activation-report/v1');
    expect(report.axes).toHaveLength(3);
    for (const a of report.axes) {
      expect(a.denominator, `${a.axis} denominator`).toBe(0);
      expect(a.ratio, `${a.axis} ratio`).toBeNull();
      expect(a.ratio, `${a.axis} ratio must not be a measured zero`).not.toBe(0);
    }
  });

  it('names the missing writer in each activation axis note', async () => {
    const report = await reportFor(tmpRoot);

    expect(axis(report, AXES.SLASH_AGREEMENT).note).toContain(ACTIVATION_FIELDS.predicted);
    expect(axis(report, AXES.HINT_ACCEPTANCE).note).toContain(ACTIVATION_FIELDS.observed);
    expect(axis(report, AXES.SLASH_AGREEMENT).note).toContain('UNMEASURED');
  });

  it('reports the canonical ledger as absent rather than failing', async () => {
    const report = await reportFor(tmpRoot);

    expect(report.stores.canonical.present).toBe(false);
    expect(report.stores.canonical.survivors).toBe(0);
    expect(report.stores.decisions.files).toBe(0);
    expect(report.stores.decisions.events).toBe(0);
  });
});

describe('slash-agreement axis over a synthetic ledger', () => {
  it('counts 3 of 3 predicted commands as agreeing when the observed slash matches', async () => {
    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        command_activation: { plan: true, split: false },
        activation_observed: { slash: 'plan' },
      }),
      ledgerLine(2, 'mission.created', {
        command_activation: { plan: true },
        activation_observed: { slash: 'plan' },
      }),
      ledgerLine(3, 'mission.candidate_deferred', {
        command_activation: { plan: true },
        activation_observed: { slash: 'plan' },
      }),
    ]);

    const slash = axis(await reportFor(tmpRoot), AXES.SLASH_AGREEMENT);

    expect(slash.numerator).toBe(3);
    expect(slash.denominator).toBe(3);
    expect(slash.ratio).toBe(1);
  });

  it('counts a predicted-but-diverging record in the denominator only', async () => {
    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        command_activation: { plan: true },
        activation_observed: { slash: 'plan' },
      }),
      ledgerLine(2, 'mission.created', {
        command_activation: { plan: true },
        activation_observed: { slash: 'plan' },
      }),
      ledgerLine(3, 'mission.created', {
        command_activation: { ultraplan: true },
        activation_observed: { slash: 'plan' },
      }),
    ]);

    const slash = axis(await reportFor(tmpRoot), AXES.SLASH_AGREEMENT);

    expect(slash.numerator).toBe(2);
    expect(slash.denominator).toBe(3);
    expect(slash.ratio).toBe(0.6667);
  });

  it('ignores a command_activation with no true value — nothing was predicted', async () => {
    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        command_activation: { plan: false, split: false },
        activation_observed: { slash: 'plan' },
      }),
    ]);

    const slash = axis(await reportFor(tmpRoot), AXES.SLASH_AGREEMENT);

    expect(slash.denominator).toBe(0);
    expect(slash.ratio).toBeNull();
  });
});

describe('hint-acceptance axis', () => {
  it('counts an accepted hint as 1 of 1', async () => {
    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        activation_observed: { hint_recommend: 'split', hint_accepted: true },
      }),
    ]);

    const hint = axis(await reportFor(tmpRoot), AXES.HINT_ACCEPTANCE);

    expect(hint.numerator).toBe(1);
    expect(hint.denominator).toBe(1);
    expect(hint.ratio).toBe(1);
  });

  it('counts an unaccepted hint as a measured 0 of 2, not null', async () => {
    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        activation_observed: { hint_recommend: 'split', hint_accepted: false },
      }),
      ledgerLine(2, 'mission.created', {
        activation_observed: { hint_recommend: 'watch' },
      }),
    ]);

    const hint = axis(await reportFor(tmpRoot), AXES.HINT_ACCEPTANCE);

    expect(hint.numerator).toBe(0);
    expect(hint.denominator).toBe(2);
    expect(hint.ratio).toBe(0);
  });

  it('refuses the decisions-recommendation proxy in its note', async () => {
    const hint = axis(await reportFor(tmpRoot), AXES.HINT_ACCEPTANCE);

    expect(hint.note).toContain('workflow-planned');
  });
});

describe('the axis note follows the denominator, not the calendar', () => {
  it('drops the UNMEASURED claim as soon as the axis has records', async () => {
    // "no writer records this yet" is only true while nothing does. A note
    // hardcoded to that sentence would keep asserting it on a row that has
    // real numbers — the exact stale claim this report exists to prevent.
    const empty = axis(await reportFor(tmpRoot), AXES.SLASH_AGREEMENT);
    expect(empty.note).toContain('UNMEASURED');
    expect(empty.note).toContain('no writer records');

    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        command_activation: { plan: true },
        activation_observed: { slash: 'plan', hint_recommend: 'plan', hint_accepted: true },
      }),
    ]);
    const report = await reportFor(tmpRoot);
    const slash = axis(report, AXES.SLASH_AGREEMENT);
    const hint = axis(report, AXES.HINT_ACCEPTANCE);

    expect(slash.denominator).toBe(1);
    expect(slash.note).not.toContain('UNMEASURED');
    expect(slash.note).not.toContain('no writer records');
    expect(slash.note).toContain(ACTIVATION_FIELDS.predicted);

    expect(hint.denominator).toBe(1);
    expect(hint.note).not.toContain('UNMEASURED');
    // The proxy refusal is NOT a function of the denominator — it stays.
    expect(hint.note).toContain('workflow-planned');
  });
});

describe('decisions store is folded alongside the ledger', () => {
  it('counts a decision event carrying the activation fields', async () => {
    writeDecisions(tmpRoot, 's1', [
      {
        ts: '2026-09-14T00:00:00.000Z',
        sessionId: 's1',
        phase: null,
        type: 'mission-compiled',
        level: 'info',
        message: 'compiled',
        data: {
          command_activation: { plan: true },
          activation_observed: { slash: 'ultraplan' },
        },
      },
    ]);

    const report = await reportFor(tmpRoot);
    const slash = axis(report, AXES.SLASH_AGREEMENT);

    expect(report.stores.decisions.files).toBe(1);
    expect(report.stores.decisions.events).toBe(1);
    expect(slash.by_store.decisions.denominator).toBe(1);
    expect(slash.by_store.decisions.numerator).toBe(0);
    expect(slash.denominator).toBe(1);
    expect(slash.ratio).toBe(0);
  });
});

describe('mission.deferral-rate — the one axis with live numbers today', () => {
  it('reports 6 deferrals over 8 mission candidates as 0.75', async () => {
    const lines = [];
    for (let i = 0; i < 2; i += 1) lines.push(ledgerLine(i + 1, 'mission.created', {}));
    for (let i = 0; i < 6; i += 1) lines.push(ledgerLine(i + 10, 'mission.candidate_deferred', {}));
    writeLedger(tmpRoot, lines);

    const deferral = axis(await reportFor(tmpRoot), AXES.DEFERRAL_RATE);

    expect(deferral.numerator).toBe(6);
    expect(deferral.denominator).toBe(8);
    expect(deferral.ratio).toBe(0.75);
  });

  it('never sums the fallback store into the top-level count, and says so', async () => {
    const lines = [];
    for (let i = 0; i < 2; i += 1) lines.push(ledgerLine(i + 1, 'mission.created', {}));
    for (let i = 0; i < 6; i += 1) lines.push(ledgerLine(i + 10, 'mission.candidate_deferred', {}));
    writeLedger(tmpRoot, lines);

    const report = await reportFor(tmpRoot);
    const deferral = axis(report, AXES.DEFERRAL_RATE);

    // The fallback resolves to the same file here, so a summing implementation
    // would read 12/16 instead of 6/8.
    expect(report.stores.fallback.same_as_canonical).toBe(true);
    expect(deferral.denominator).toBe(8);
    expect(deferral.by_store.canonical.denominator).toBe(8);
    expect(deferral.note).toMatch(/never sum|canonical only/i);
    expect(deferral.ledger_path).toBe(report.stores.canonical.path);
  });
});

describe('the fallback store is never summed into any top-level count', () => {
  it('reports the overlap and keeps the activation denominators at the canonical count', async () => {
    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        command_activation: { plan: true },
        activation_observed: { slash: 'plan', hint_recommend: 'plan', hint_accepted: true },
      }),
    ]);

    const report = await reportFor(tmpRoot);
    const slash = axis(report, AXES.SLASH_AGREEMENT);

    expect(report.stores.fallback.same_as_canonical).toBe(true);
    expect(report.stores.fallback.path).toBe(report.stores.canonical.path);
    // The fallback read the same file, so it sees the record too — and it is
    // still reported. A summing implementation would read 2 here.
    expect(slash.by_store.fallback.denominator).toBe(1);
    expect(slash.denominator).toBe(1);
    expect(axis(report, AXES.HINT_ACCEPTANCE).by_store.fallback.denominator).toBe(1);
    expect(axis(report, AXES.HINT_ACCEPTANCE).denominator).toBe(1);
  });

  it('applies the same exclusion on every axis, so one field name means one thing', async () => {
    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        command_activation: { plan: true },
        activation_observed: { slash: 'plan', hint_recommend: 'plan', hint_accepted: true },
      }),
      ledgerLine(2, 'mission.candidate_deferred', {}),
    ]);

    const report = await reportFor(tmpRoot);

    for (const a of report.axes) {
      expect(a.by_store.fallback.denominator, `${a.axis} fallback is reported`).toBeGreaterThan(0);
      expect(
        a.denominator,
        `${a.axis} top-level must not include the fallback`,
      ).toBe(a.by_store.canonical.denominator + a.by_store.decisions.denominator);
      expect(a.note).toMatch(/never .*fallback|fallback|canonical only/i);
    }
  });
});

describe('fixture side-by-side', () => {
  it('carries all 10 cases and the verbatim non-evidence warning', async () => {
    const report = await reportFor(tmpRoot);

    expect(report.fixture.cases).toBe(10);
    expect(report.fixture.expected).toHaveLength(10);
    expect(report.fixture.warning).toBe(FIXTURE_WARNING);
    expect(FIXTURE_WARNING).toContain('NOT evidence');
  });

  it('reports command_activation for exactly the cases that declare one', async () => {
    const report = await reportFor(tmpRoot);
    const declared = report.fixture.expected
      .filter((c) => c.command_activation !== null)
      .map((c) => c.id)
      .sort();

    // Measured 2026-09-14 against tests/evals/fixtures/nl-activation.cases.jsonl:
    // THREE of the ten cases declare `command_activation`, not four.
    expect(declared).toEqual([
      'explicit-ultraplan-command-s5',
      'split-upgrade-fidelity',
      'two-explicit-requests-s3',
    ]);
    expect(report.fixture.with_command_activation).toBe(3);
    expect(
      report.fixture.expected.find((c) => c.id === 'explicit-ultraplan-command-s5').command_activation,
    ).toEqual({ ultraplan: true });
  });
});

describe('CLI', () => {
  it('prints one JSON document to stdout when spawned directly', () => {
    const stdout = execFileSync(process.execPath, [RUNNER, '--project-root', tmpRoot], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const report = JSON.parse(stdout);
    expect(report.schema).toBe('nl-activation-report/v1');
    expect(report.axes).toHaveLength(3);
    expect(report.project_root).toBe(tmpRoot);
    expect(typeof report.measured_at).toBe('string');
  });
});
