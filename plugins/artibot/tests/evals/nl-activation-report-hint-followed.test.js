/**
 * Gate for the FOURTH axis of the NL-activation instrument,
 * `activation.hint-followed` (`scripts/evals/nl-activation-report.mjs`).
 *
 * WHY A SIBLING FILE. `tests/evals/nl-activation-report.test.js` owns the three
 * axes that shipped before this one and is already near the 800-line ceiling;
 * folding these suites in pushed it to 881. The split is by axis, not by
 * convenience: everything here reads `data.hint_recommend` (TOP LEVEL, the key
 * the writer actually writes) and the pairing rule between consecutive
 * activation rows. The sibling file keeps the `0/0 → null` property and the
 * fallback-exclusion rule for all four axes.
 *
 * WHAT THIS FILE DOES NOT SEE
 *  - Whether the pairing rule matches real sessions. Every fixture here is
 *    hand-written and single-digit; the live decisions store has run files this
 *    file has never read, and no fixture reproduces an interleaving of eight
 *    recorders under load.
 *  - A dropped write. If the N+1 activation row never lands, row N pairs with
 *    N+2 and the verdict is silently wrong. No fixture can distinguish that
 *    from a real answer, because the missing row is missing on disk too.
 *  - Whether a hint was ACCEPTED. It sees only whether a slash command was
 *    typed on the next turn, which is a lower bound — see the axis note.
 *
 * Every root is an `mkdtemp` directory. Pointing any of these at the real
 * project root would write into the live decisions store.
 *
 * @module tests/evals/nl-activation-report-hint-followed
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACTIVATION_OBSERVED, HINT_SLASH_MAP } from '../../lib/observability/decision-events.js';
import {
  AXES,
  buildReport,
  collectStores,
  defaultFixturePath,
  foldHintFollowed,
  loadFixtureCases,
} from '../../scripts/evals/nl-activation-report.mjs';

/** @type {string} */
let tmpRoot;
/** @type {string} */
let otherRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'nl-hint-followed-'));
  otherRoot = mkdtempSync(path.join(os.tmpdir(), 'nl-hint-followed-b-'));
});

afterEach(() => {
  for (const root of [tmpRoot, otherRoot]) {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * One ledger envelope line. `seq` is what keeps otherwise-identical lines from
 * colliding on `dedupeKey` (`lib/runtime/ledger.js#dedupeKey`) and being dropped
 * as duplicates before the fold ever sees them.
 *
 * @param {number} seq
 * @param {string} event
 * @param {object} data
 * @returns {string}
 */
function ledgerLine(seq, event, data) {
  return JSON.stringify({
    v: 1,
    ts: new Date(Date.UTC(2026, 8, 14, 0, 0, seq)).toISOString(),
    event,
    mission_id: `m-${seq}`,
    session_id: 's-1',
    source: 'hook',
    pid: 4242,
    seq,
    data,
  });
}

/**
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
 * @param {string} axisName
 * @returns {object}
 */
function axis(report, axisName) {
  const found = report.axes.find((a) => a.axis === axisName);
  if (!found) throw new Error(`axis ${axisName} missing from report`);
  return found;
}

/**
 * One activation record as the writer shapes it
 * (`lib/observability/decision-events.js#recordActivationObserved`, 2026-09-21):
 * `hint_recommend` sits at the TOP LEVEL of `data`, not inside
 * `activation_observed`.
 *
 * @param {object} data
 * @param {number} [seq]
 * @param {string} [type]
 * @returns {object}
 */
function actEvent(data, seq = 0, type = ACTIVATION_OBSERVED) {
  return {
    ts: new Date(Date.UTC(2026, 8, 14, 0, 0, seq)).toISOString(),
    sessionId: 's1',
    phase: null,
    type,
    level: 'info',
    message: 'observed',
    data,
  };
}

/**
 * The record that PUTS a row in the hint-followed denominator: a hint was shown.
 *
 * `hint_resolved_by` is filled the way the writer fills it
 * (`decision-events.js#resolveHint`), NOT left null: a fixture that is shaped
 * unlike the producer can pass while the real record fails. The reader ignores
 * the field and recomputes the verdict, so every count here is identical either
 * way — asserted, not assumed, by the "ignores the stored hint_resolved_by"
 * case below, which feeds rows that lie about their own resolution.
 *
 * @param {string} hint
 * @param {string} promptId
 * @returns {object}
 */
function hintShown(hint, promptId) {
  return {
    hint_recommend: hint,
    hint_resolved_by: Object.hasOwn(HINT_SLASH_MAP, hint) ? 'slash-map' : 'unmapped',
    prompt_id: promptId,
  };
}

/**
 * The record that can SATISFY a preceding denominator row: the user typed a
 * slash command on the next turn.
 *
 * @param {string} slash
 * @param {string} promptId
 * @returns {object}
 */
function slashTyped(slash, promptId) {
  return {
    activation_observed: { slash },
    hint_recommend: null,
    hint_resolved_by: null,
    prompt_id: promptId,
  };
}

/**
 * An axis object as bytes, with the tmp root masked and separators folded to
 * `/`. Those two are the ONLY parts that legitimately vary: the root is an
 * `mkdtemp` path, and `path.join` yields `\` on win32 and `/` elsewhere. Every
 * other byte — key order included — is pinned.
 *
 * @param {object} report
 * @param {string} axisName
 * @param {string} root
 * @returns {string}
 */
function axisJson(report, axisName, root) {
  const escaped = JSON.stringify(root).slice(1, -1);
  return JSON.stringify(axis(report, axisName))
    .split(escaped)
    .join('<ROOT>')
    // A win32 separator is an escaped backslash pair inside a JSON string.
    .split('\\\\')
    .join('/');
}

/**
 * Captured 2026-09-21 by building the report with the UNCHANGED reader, before
 * the first edit of the hint-followed limb. These are the two axes the new axis
 * must not disturb: an additive fourth axis that quietly shifted a byte of
 * `activation.slash-agreement` or `mission.deferral-rate` would move a number
 * an operator is already reading, and `toHaveLength(4)` would not catch it.
 */
const PRE_CHANGE = Object.freeze({
  empty: {
    slash: '{"axis":"activation.slash-agreement","numerator":0,"denominator":0,"ratio":null,"measured_at":"2026-09-14T00:00:00.000Z","ledger_path":"<ROOT>/.artibot/runtime/ledger.jsonl","note":"UNMEASURED: no writer records command_activation to any store yet (compileMission holds it in memory), so denominator 0 is the result, not a defect. Denominator = records whose command_activation map has ≥1 true key; numerator = those where activation_observed.slash equals one of those keys.","by_store":{"canonical":{"numerator":0,"denominator":0},"fallback":{"numerator":0,"denominator":0},"decisions":{"numerator":0,"denominator":0}}}',
    deferral: '{"axis":"mission.deferral-rate","numerator":0,"denominator":0,"ratio":null,"measured_at":"2026-09-14T00:00:00.000Z","ledger_path":"<ROOT>/.artibot/runtime/ledger.jsonl","note":"Auxiliary, NOT the §3.7 ≥90% axis. Top-level counts are the CANONICAL ledger only — the fallback is pre-ADR-011 residue that may overlap it, so never sum the stores; read by_store for each one separately.","by_store":{"canonical":{"numerator":0,"denominator":0},"fallback":{"numerator":0,"denominator":0},"decisions":{"numerator":0,"denominator":0}}}',
  },
  ledger: {
    slash: '{"axis":"activation.slash-agreement","numerator":1,"denominator":1,"ratio":1,"measured_at":"2026-09-14T00:00:00.000Z","ledger_path":"<ROOT>/.artibot/runtime/ledger.jsonl","note":"Denominator = records whose command_activation map has ≥1 true key; numerator = those where activation_observed.slash equals one of those keys. Top-level counts sum the canonical ledger and the decisions store only — never the fallback, which is pre-ADR-011 residue that may overlap the canonical file; read by_store for each store separately.","by_store":{"canonical":{"numerator":1,"denominator":1},"fallback":{"numerator":1,"denominator":1},"decisions":{"numerator":0,"denominator":0}}}',
    deferral: '{"axis":"mission.deferral-rate","numerator":1,"denominator":2,"ratio":0.5,"measured_at":"2026-09-14T00:00:00.000Z","ledger_path":"<ROOT>/.artibot/runtime/ledger.jsonl","note":"Auxiliary, NOT the §3.7 ≥90% axis. Top-level counts are the CANONICAL ledger only — the fallback is pre-ADR-011 residue that may overlap it, so never sum the stores; read by_store for each one separately.","by_store":{"canonical":{"numerator":1,"denominator":2},"fallback":{"numerator":1,"denominator":2},"decisions":{"numerator":0,"denominator":0}}}',
  },
  decisions: {
    slash: '{"axis":"activation.slash-agreement","numerator":1,"denominator":1,"ratio":1,"measured_at":"2026-09-14T00:00:00.000Z","ledger_path":"<ROOT>/.artibot/runtime/ledger.jsonl","note":"Denominator = records whose command_activation map has ≥1 true key; numerator = those where activation_observed.slash equals one of those keys. Top-level counts sum the canonical ledger and the decisions store only — never the fallback, which is pre-ADR-011 residue that may overlap the canonical file; read by_store for each store separately.","by_store":{"canonical":{"numerator":0,"denominator":0},"fallback":{"numerator":0,"denominator":0},"decisions":{"numerator":1,"denominator":1}}}',
    deferral: '{"axis":"mission.deferral-rate","numerator":0,"denominator":0,"ratio":null,"measured_at":"2026-09-14T00:00:00.000Z","ledger_path":"<ROOT>/.artibot/runtime/ledger.jsonl","note":"Auxiliary, NOT the §3.7 ≥90% axis. Top-level counts are the CANONICAL ledger only — the fallback is pre-ADR-011 residue that may overlap it, so never sum the stores; read by_store for each one separately.","by_store":{"canonical":{"numerator":0,"denominator":0},"fallback":{"numerator":0,"denominator":0},"decisions":{"numerator":0,"denominator":0}}}',
  },
});

describe('adding the fourth axis moves nothing that was already there', () => {
  it('keeps the four axes in a fixed order, hint-followed last', async () => {
    const report = await reportFor(tmpRoot);

    expect(report.axes.map((a) => a.axis)).toEqual([
      'activation.slash-agreement',
      'activation.hint-acceptance',
      'mission.deferral-rate',
      'activation.hint-followed',
    ]);
    expect(AXES.HINT_FOLLOWED).toBe('activation.hint-followed');
    expect(report.axes[3].axis).toBe(AXES.HINT_FOLLOWED);
  });

  it('reproduces the pre-change bytes of both untouched axes on an empty root', async () => {
    const report = await reportFor(tmpRoot);

    expect(axisJson(report, AXES.SLASH_AGREEMENT, tmpRoot)).toBe(PRE_CHANGE.empty.slash);
    expect(axisJson(report, AXES.DEFERRAL_RATE, tmpRoot)).toBe(PRE_CHANGE.empty.deferral);
  });

  it('reproduces the pre-change bytes over a synthetic ledger', async () => {
    writeLedger(tmpRoot, [
      ledgerLine(1, 'mission.created', {
        command_activation: { plan: true },
        activation_observed: { slash: 'plan', hint_recommend: 'plan', hint_accepted: true },
      }),
      ledgerLine(2, 'mission.candidate_deferred', {}),
    ]);

    const report = await reportFor(tmpRoot);

    expect(axisJson(report, AXES.SLASH_AGREEMENT, tmpRoot)).toBe(PRE_CHANGE.ledger.slash);
    expect(axisJson(report, AXES.DEFERRAL_RATE, tmpRoot)).toBe(PRE_CHANGE.ledger.deferral);
  });

  it('reproduces the pre-change bytes over a decisions store', async () => {
    writeDecisions(tmpRoot, 's1', [
      actEvent({
        command_activation: { split: true },
        activation_observed: { slash: 'split' },
        hint_recommend: 'split',
        hint_resolved_by: 'slash-map',
        prompt_id: 'p1',
      }),
    ]);

    const report = await reportFor(tmpRoot);

    expect(axisJson(report, AXES.SLASH_AGREEMENT, tmpRoot)).toBe(PRE_CHANGE.decisions.slash);
    expect(axisJson(report, AXES.DEFERRAL_RATE, tmpRoot)).toBe(PRE_CHANGE.decisions.deferral);
  });
});

describe('hint-acceptance is now PERMANENTLY unmeasured, and says why', () => {
  it('names both the key the writer uses and the axis that reads it', async () => {
    const hint = axis(await reportFor(tmpRoot), AXES.HINT_ACCEPTANCE);

    expect(hint.note).toContain('UNMEASURED');
    // The old sentence blamed stdout. The writer landed; the axis still reads 0
    // because it looks at a nested key the writer never writes.
    expect(hint.note).not.toContain('stdout only');
    expect(hint.note).toContain('hint_recommend');
    expect(hint.note).toContain(AXES.HINT_FOLLOWED);
    expect(hint.note).toContain('workflow-planned');
  });

  it('stays at 0/0 when the writer-shaped top-level key is present', async () => {
    writeDecisions(tmpRoot, 's1', [
      actEvent(hintShown('split', 'p-1'), 1),
      actEvent(slashTyped('split', 'p-2'), 2),
    ]);

    const report = await reportFor(tmpRoot);

    expect(axis(report, AXES.HINT_ACCEPTANCE).denominator).toBe(0);
    expect(axis(report, AXES.HINT_ACCEPTANCE).ratio).toBeNull();
    expect(axis(report, AXES.HINT_FOLLOWED).denominator).toBe(1);
  });
});

describe('foldHintFollowed — the pure fold over run-bounded activation rows', () => {
  /**
   * @param {object[]} events
   * @param {string} [runId]
   * @returns {object}
   */
  function fold1(events, runId = 'r1') {
    return foldHintFollowed([{ runId, events }]);
  }

  it('counts a split hint followed by /split as 1 of 1', () => {
    const out = fold1([actEvent(hintShown('split', 'p-1'), 1), actEvent(slashTyped('split', 'p-2'), 2)]);

    expect(out.numerator).toBe(1);
    expect(out.denominator).toBe(1);
    expect(out.no_next).toBe(0);
    expect(out.unmapped).toBe(0);
  });

  it('counts an autopilot hint followed by /autopilot', () => {
    const out = fold1([
      actEvent(hintShown('autopilot', 'p-1'), 1),
      actEvent(slashTyped('autopilot', 'p-2'), 2),
    ]);

    expect(out.numerator).toBe(1);
    expect(out.denominator).toBe(1);
  });

  it('counts a watch hint followed by /watch — watch runs without confirmation, so this is the rare visible case', () => {
    const out = fold1([actEvent(hintShown('watch', 'p-1'), 1), actEvent(slashTyped('watch', 'p-2'), 2)]);

    expect(out.numerator).toBe(1);
    expect(out.by_hint.watch).toEqual({ numerator: 1, denominator: 1 });
  });

  it('counts a workflow hint in the denominator and in unmapped, never in the numerator', () => {
    // There is no /workflow command, so no next row can ever satisfy it.
    const out = fold1([
      actEvent(hintShown('workflow', 'p-1'), 1),
      actEvent(slashTyped('workflow', 'p-2'), 2),
    ]);

    expect(out.denominator).toBe(1);
    expect(out.numerator).toBe(0);
    expect(out.unmapped).toBe(1);
    expect(Object.hasOwn(HINT_SLASH_MAP, 'workflow')).toBe(false);
  });

  it('leaves a null hint out of the denominator entirely', () => {
    const out = fold1([
      actEvent({ hint_recommend: null, hint_resolved_by: null, prompt_id: 'p-1' }, 1),
      actEvent(slashTyped('split', 'p-2'), 2),
    ]);

    expect(out.denominator).toBe(0);
  });

  it('counts a mismatched next slash as a measured miss', () => {
    const out = fold1([actEvent(hintShown('split', 'p-1'), 1), actEvent(slashTyped('watch', 'p-2'), 2)]);

    expect(out.denominator).toBe(1);
    expect(out.numerator).toBe(0);
    expect(out.no_next).toBe(0);
  });

  it('counts the last row of a run as no_next, not as a miss the reader can act on', () => {
    const out = fold1([actEvent(hintShown('split', 'p-1'), 1)]);

    expect(out.denominator).toBe(1);
    expect(out.numerator).toBe(0);
    expect(out.no_next).toBe(1);
  });

  it('never pairs a row with the next row of a DIFFERENT run', () => {
    const out = foldHintFollowed([
      { runId: 'r1', events: [actEvent(hintShown('split', 'p-1'), 1)] },
      { runId: 'r2', events: [actEvent(slashTyped('split', 'p-2'), 2)] },
    ]);

    expect(out.denominator).toBe(1);
    expect(out.numerator).toBe(0);
    expect(out.no_next).toBe(1);
  });

  it('skips rows of other types sitting between the hint and the slash', () => {
    const out = fold1([
      actEvent(hintShown('split', 'p-1'), 1),
      actEvent({ recommendation: 'split' }, 2, 'topology-recommended'),
      actEvent({ written: 3, failed: 0 }, 3, 'recorder-stats'),
      actEvent(slashTyped('split', 'p-2'), 4),
    ]);

    expect(out.numerator).toBe(1);
    expect(out.denominator).toBe(1);
  });

  it('does not treat a re-record of the same prompt_id as the next turn', () => {
    const out = fold1([
      actEvent(hintShown('split', 'p-1'), 1),
      actEvent(hintShown('split', 'p-1'), 2),
      actEvent(slashTyped('split', 'p-2'), 3),
    ]);

    // One prompt was shown one hint. The repeat is collapsed, so it neither
    // doubles the denominator nor stands in as the following turn.
    expect(out.denominator).toBe(1);
    expect(out.numerator).toBe(1);
  });

  it('cannot be satisfied by a prototype key — a constructor hint is unmapped', () => {
    const out = fold1([
      actEvent(hintShown('constructor', 'p-1'), 1),
      actEvent(slashTyped('constructor', 'p-2'), 2),
    ]);

    expect(out.denominator).toBe(1);
    expect(out.numerator).toBe(0);
    expect(out.unmapped).toBe(1);
  });

  it('keeps by_hint free of prototype keys it never saw', () => {
    const out = fold1([actEvent(hintShown('split', 'p-1'), 1)]);

    expect(Object.hasOwn(out.by_hint, 'constructor')).toBe(false);
    expect(Object.keys(out.by_hint)).toEqual(['split']);
  });

  it('breaks the denominator down by hint value', () => {
    const out = fold1([
      actEvent(hintShown('split', 'p-1'), 1),
      actEvent(slashTyped('split', 'p-2'), 2),
      actEvent(hintShown('watch', 'p-3'), 3),
      actEvent(slashTyped('plan', 'p-4'), 4),
      actEvent(hintShown('workflow', 'p-5'), 5),
      actEvent(slashTyped('split', 'p-6'), 6),
    ]);

    expect(out.by_hint).toEqual({
      split: { numerator: 1, denominator: 1 },
      watch: { numerator: 0, denominator: 1 },
      workflow: { numerator: 0, denominator: 1 },
    });
    expect(out.numerator).toBe(1);
    expect(out.denominator).toBe(3);
  });

  it('returns an empty fold for no runs at all', () => {
    const out = foldHintFollowed([]);

    expect(out).toEqual({ numerator: 0, denominator: 0, unmapped: 0, no_next: 0, by_hint: {} });
  });
});

describe('activation.hint-followed axis in the report', () => {
  it('reports ratio null on a denominator of 0 rather than a measured zero', async () => {
    const followed = axis(await reportFor(tmpRoot), AXES.HINT_FOLLOWED);

    expect(followed.denominator).toBe(0);
    expect(followed.ratio).toBeNull();
    expect(followed.ratio).not.toBe(0);
  });

  it('folds two runs of the decisions store into one measured axis', async () => {
    writeDecisions(tmpRoot, 'r1', [
      actEvent(hintShown('split', 'p-1'), 1),
      actEvent(slashTyped('split', 'p-2'), 2),
    ]);
    writeDecisions(tmpRoot, 'r2', [
      actEvent(hintShown('watch', 'p-3'), 3),
      actEvent(slashTyped('plan', 'p-4'), 4),
    ]);

    const followed = axis(await reportFor(tmpRoot), AXES.HINT_FOLLOWED);

    expect(followed.numerator).toBe(1);
    expect(followed.denominator).toBe(2);
    expect(followed.ratio).toBe(0.5);
    expect(followed.by_store.decisions).toEqual({ numerator: 1, denominator: 2 });
    expect(followed.by_store.canonical).toEqual({ numerator: 0, denominator: 0 });
  });

  it('ignores the stored hint_resolved_by and recomputes the verdict from the slash map', async () => {
    // Both rows LIE about their own resolution, in opposite directions. The
    // reader must not inherit a verdict computed by whichever hook version was
    // installed when the row was written.
    writeDecisions(tmpRoot, 'r1', [
      actEvent({ hint_recommend: 'workflow', hint_resolved_by: 'slash-map', prompt_id: 'p-1' }, 1),
      actEvent(slashTyped('workflow', 'p-2'), 2),
      actEvent({ hint_recommend: 'split', hint_resolved_by: 'unmapped', prompt_id: 'p-3' }, 3),
      actEvent(slashTyped('split', 'p-4'), 4),
    ]);

    const followed = axis(await reportFor(tmpRoot), AXES.HINT_FOLLOWED);

    expect(followed.denominator).toBe(2);
    // workflow stays out of the numerator despite claiming slash-map; split
    // enters it despite claiming unmapped.
    expect(followed.numerator).toBe(1);
    expect(followed.unmapped).toBe(1);
    expect(followed.by_hint.split).toEqual({ numerator: 1, denominator: 1 });
  });

  it('carries a prototype-named hint through the store merge without polluting anything', async () => {
    // The fold-level cases prove `foldHintFollowed` handles this; they do NOT
    // reach the per-store MERGE inside the axis, which is where a plain `{}`
    // accumulator resolves `into.constructor` to the Object function and then
    // does `+=` on it. `constructor` passes the writer's charset
    // (`lib/observability/decision-events.js#SLASH_NAME_RE`), so this shape can
    // reach disk.
    writeDecisions(tmpRoot, 'r1', [
      actEvent(hintShown('constructor', 'p-1'), 1),
      actEvent(hintShown('split', 'p-2'), 2),
    ]);

    const followed = axis(await reportFor(tmpRoot), AXES.HINT_FOLLOWED);

    expect(followed.denominator).toBe(2);
    expect(followed.by_hint.constructor).toEqual({ numerator: 0, denominator: 1 });
    expect(followed.by_hint.split).toEqual({ numerator: 0, denominator: 1 });
    // The breakdown must account for every row the top line counted.
    const breakdown = Object.values(followed.by_hint).reduce((n, c) => n + c.denominator, 0);
    expect(breakdown).toBe(followed.denominator);
    // And nothing may have been written onto the shared prototype on the way.
    const probe = {};
    expect(probe.denominator).toBeUndefined();
    expect(probe.numerator).toBeUndefined();
    expect(Object.numerator).toBeUndefined();
    expect(Object.denominator).toBeUndefined();
  });

  it('reports the censoring-excluded reading as its own named field', async () => {
    writeDecisions(tmpRoot, 'r1', [
      actEvent(hintShown('split', 'p-1'), 1),
      actEvent(slashTyped('split', 'p-2'), 2),
      actEvent(hintShown('split', 'p-3'), 3),
    ]);

    const followed = axis(await reportFor(tmpRoot), AXES.HINT_FOLLOWED);

    expect(followed.denominator).toBe(2);
    expect(followed.no_next).toBe(1);
    expect(followed.resolvable_denominator).toBe(1);
    expect(followed.ratio).toBe(0.5);
    expect(followed.ratio_resolvable).toBe(1);
    expect(followed.note).toContain('resolvable_denominator');
    expect(followed.note).toContain('ratio_resolvable');
  });

  it('says what it counts, what next means, and that it is a lower bound', async () => {
    writeDecisions(tmpRoot, 'r1', [
      actEvent(hintShown('split', 'p-1'), 1),
      actEvent(slashTyped('split', 'p-2'), 2),
    ]);

    const measured = axis(await reportFor(tmpRoot), AXES.HINT_FOLLOWED);
    const unmeasured = axis(await reportFor(otherRoot), AXES.HINT_FOLLOWED);

    for (const note of [measured.note, unmeasured.note]) {
      expect(note).toContain('hint_recommend');
      expect(note).toContain('append order');
      expect(note).toContain('LOWER BOUND');
      expect(note).toContain('watch');
      expect(note).toContain('censored');
      expect(note).toContain('recorder-stats');
      expect(note).toMatch(/never sum|canonical only|never the fallback/i);
    }
    expect(unmeasured.note).toContain('UNMEASURED');
    expect(measured.note).not.toContain('UNMEASURED');
  });
});

