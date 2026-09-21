/**
 * `recordActivationObserved` — the persisting half of the NL-activation writer.
 *
 * WHAT THIS SUITE CANNOT SEE:
 *  1. It never runs the hook. That `scripts/hooks/runtime-prompt.js` calls this
 *     on a real prompt is the sibling limb's wiring test; a green run here is
 *     not evidence that a single live record exists, and the §3.7 axis stays
 *     0/0 until one does.
 *  2. Every write goes to a `storeDir` under `os.tmpdir()`. The real
 *     `<projectRoot>/.artibot/runtime/decisions/` resolution is untouched.
 *  3. The byte size below is measured on a synthetic record. A live record's
 *     size varies with the session id, which is part of the idempotency key.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildActivationRecord } from '../../lib/observability/activation-observed.js';
import {
  ACTIVATION_OBSERVED,
  DECISION_EVENT_TYPES,
  getDecisionEventsPath,
  getDecisionRecorderStats,
  isAllowedDecisionType,
  readDecisionEvents,
  recordActivationObserved,
  resetDecisionRecorderStats,
} from '../../lib/observability/decision-events.js';

let storeDir;
const RUN = 'run-1';

beforeEach(() => {
  storeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'artibot-activation-store-'));
  resetDecisionRecorderStats();
});

afterEach(() => {
  try { fsSync.rmSync(storeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  resetDecisionRecorderStats();
});

/** The raw file contents, so an assertion can look at bytes rather than parsed objects. */
function rawFile(runId = RUN) {
  return fsSync.readFileSync(getDecisionEventsPath(runId, { storeDir }), 'utf-8');
}

describe('the type is registered in the closed allowlist', () => {
  it('is the eighth member and passes the predicate `record` consults', () => {
    expect(ACTIVATION_OBSERVED).toBe('activation-observed');
    expect(DECISION_EVENT_TYPES).toContain(ACTIVATION_OBSERVED);
    expect(DECISION_EVENT_TYPES).toHaveLength(8);
    expect(isAllowedDecisionType('activation-observed')).toBe(true);
  });
});

describe('recordActivationObserved() writes one line', () => {
  it('persists the type, phase and idempotency key with the run id folded in', () => {
    const ev = recordActivationObserved(RUN, buildActivationRecord({
      topology: { mode: 'split', reason: ['recommendation:split'] },
      slashCommand: 'split',
      promptId: 'p-1',
    }), { storeDir });

    expect(ev).not.toBeNull();
    const lines = readDecisionEvents(RUN, { storeDir });
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line.type).toBe('activation-observed');
    expect(line.phase).toBe('ROUTE');
    expect(line.level).toBe('info');
    // The builder emits `activation:p-1`; the run id is the recorder's to add,
    // and without it the key would collide across sessions.
    expect(line.data.idempotency_key).toBe('activation:run-1:p-1');
    expect(line.data.prompt_id).toBe('p-1');
    expect(line.data.observe_only).toBe(true);
  });

  it('carries the predicted map and the observed slash the reader folds', () => {
    recordActivationObserved(RUN, buildActivationRecord({
      topology: { mode: 'autopilot_fast', reason: ['nl-match:flag-fast'] },
      slashCommand: 'autopilot',
      promptId: 'p-2',
    }), { storeDir });

    const { data } = readDecisionEvents(RUN, { storeDir })[0];
    expect(data.command_activation).toEqual({ autopilot: true, autopilot_fast: true, split: false });
    expect(data.activation_observed).toEqual({ slash: 'autopilot' });
    expect(data.predicted_mode).toBe('autopilot_fast');
    expect(data.predicted_signal).toBe('nl-explicit');
    expect(data.predicted_nl_match).toBe('flag-fast');
    // This record is a numerator hit: `autopilot` is among the true keys.
    const trueKeys = Object.keys(data.command_activation).filter((k) => data.command_activation[k]);
    expect(trueKeys).toContain(data.activation_observed.slash);
  });

  it('summarises the pair in the message', () => {
    recordActivationObserved(RUN, buildActivationRecord({
      topology: { mode: 'split' }, slashCommand: 'split',
    }), { storeDir });
    expect(readDecisionEvents(RUN, { storeDir })[0].message).toBe('activation slash=split predicted=split');
  });

  it('says none on both sides when there is nothing to report', () => {
    recordActivationObserved(RUN, buildActivationRecord({ topology: { mode: 'solo' } }), { storeDir });
    const [line] = readDecisionEvents(RUN, { storeDir });
    expect(line.message).toBe('activation slash=none predicted=none');
    expect(line.data.idempotency_key).toBeNull();
  });
});

describe('no run id means no file', () => {
  it('counts the call as skipped and writes nothing', () => {
    const ev = recordActivationObserved(null, buildActivationRecord({
      topology: { mode: 'split' }, slashCommand: 'split', promptId: 'p-1',
    }), { storeDir });

    expect(ev).toBeNull();
    expect(getDecisionRecorderStats()).toMatchObject({ recorded: 0, failed: 0, skipped: 1 });
    expect(fsSync.readdirSync(storeDir)).toEqual([]);
  });

  it('treats an empty string and a non-string the same way', () => {
    expect(recordActivationObserved('', {}, { storeDir })).toBeNull();
    expect(recordActivationObserved(42, {}, { storeDir })).toBeNull();
    expect(getDecisionRecorderStats().skipped).toBe(2);
    expect(fsSync.readdirSync(storeDir)).toEqual([]);
  });
});

describe('privacy — the recorder re-validates rather than trusting its caller', () => {
  it('drops foreign top-level keys and a foreign key inside the observed container', () => {
    // Fed directly, bypassing the pure builder: the recorder is not guaranteed
    // to be called with a builder result, so its filtering must stand alone.
    recordActivationObserved(RUN, {
      observe_only: true,
      command_activation: { split: true },
      activation_observed: { slash: 'split', text: 'leak' },
      prompt: 'the user typed something private',
      predicted_mode: 'split',
      prompt_id: 'p-3',
    }, { storeDir });

    const raw = rawFile();
    expect(raw).not.toContain('leak');
    expect(raw).not.toContain('the user typed something private');
    expect(raw).not.toContain('"prompt"');

    const { data } = readDecisionEvents(RUN, { storeDir })[0];
    expect(data.activation_observed).toEqual({ slash: 'split' });
    // The closed key set, pinned so a key added upstream cannot reach disk
    // unnoticed. The two `hint_*` keys joined it with the Wave 13 hint axis;
    // their own cases live in `decision-events.test.js` (recorder) and
    // `activation-observed.test.js` (builder).
    expect(Object.keys(data).sort()).toEqual([
      'activation_observed', 'command_activation', 'hint_recommend', 'hint_resolved_by',
      'idempotency_key', 'observe_only', 'predicted_mode', 'predicted_nl_match',
      'predicted_signal', 'prompt_id',
    ]);
  });

  it('drops a slash name that is not a command name', () => {
    recordActivationObserved(RUN, {
      activation_observed: { slash: '/split please leak' },
    }, { storeDir });
    expect(rawFile()).not.toContain('please leak');
    expect(readDecisionEvents(RUN, { storeDir })[0].data.activation_observed).toEqual({});
  });

  it('drops an nl-match id that carries text instead of an id', () => {
    recordActivationObserved(RUN, {
      predicted_nl_match: 'secret prompt text',
    }, { storeDir });
    expect(rawFile()).not.toContain('secret prompt text');
    expect(readDecisionEvents(RUN, { storeDir })[0].data.predicted_nl_match).toBeNull();
  });

  it('keeps only boolean entries of command_activation', () => {
    recordActivationObserved(RUN, {
      command_activation: {
        split: true, autopilot: false, skills: ['leaky-skill'], count: 3, note: 'leak',
      },
    }, { storeDir });

    const raw = rawFile();
    expect(raw).not.toContain('leaky-skill');
    expect(raw).not.toContain('leak');
    expect(readDecisionEvents(RUN, { storeDir })[0].data.command_activation)
      .toEqual({ split: true, autopilot: false });
  });

  it('drops a predicted_mode carrying free text rather than a mode name', () => {
    // Cross-review 2026-09-17: a `typeof === 'string'` check let this reach
    // disk verbatim. A mode is a command-shaped token, so it is bounded like
    // one.
    recordActivationObserved(RUN, {
      predicted_mode: 'SECRET-MODE-TEXT the user asked about their salary',
    }, { storeDir });

    const raw = rawFile();
    expect(raw).not.toContain('SECRET-MODE-TEXT');
    expect(raw).not.toContain('salary');
    expect(readDecisionEvents(RUN, { storeDir })[0].data.predicted_mode).toBeNull();
  });

  it('drops an activation KEY carrying free text, not just a bad value', () => {
    // Cross-review 2026-09-17: filtering by value type alone was not enough —
    // a boolean under a sentence-shaped KEY reached both `data` and the
    // `message` line, because the map's keys come from a caller this module
    // does not own.
    recordActivationObserved(RUN, {
      command_activation: { split: true, 'user typed SECRET-KEY-TEXT': true },
    }, { storeDir });

    const raw = rawFile();
    expect(raw).not.toContain('SECRET-KEY-TEXT');
    expect(raw).not.toContain('user typed');
    const [line] = readDecisionEvents(RUN, { storeDir });
    expect(line.data.command_activation).toEqual({ split: true });
    // The message is built from the surviving true keys, so it must be clean too.
    expect(line.message).toBe('activation slash=none predicted=split');
  });

  it('keeps an unknown but command-shaped mode, so a new router mode is visible', () => {
    // The bound is a charset, not an allowlist of today's six modes. A mode
    // added to the router must still appear rather than silently becoming null.
    recordActivationObserved(RUN, { predicted_mode: 'quantum_split' }, { storeDir });
    expect(readDecisionEvents(RUN, { storeDir })[0].data.predicted_mode).toBe('quantum_split');
  });

  it('nulls command_activation when it is not an object', () => {
    for (const bad of ['x', 42, ['split'], null]) {
      recordActivationObserved(RUN, { command_activation: bad }, { storeDir });
    }
    const lines = readDecisionEvents(RUN, { storeDir });
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l.data.command_activation).toBeNull();
  });

  it('nulls a predicted_signal outside the allowlist', () => {
    recordActivationObserved(RUN, { predicted_signal: 'telepathy' }, { storeDir });
    expect(rawFile()).not.toContain('telepathy');
    expect(readDecisionEvents(RUN, { storeDir })[0].data.predicted_signal).toBeNull();

    recordActivationObserved(RUN, { predicted_signal: 'runner' }, { storeDir });
    expect(readDecisionEvents(RUN, { storeDir })[1].data.predicted_signal).toBe('runner');
  });

  it('nulls an over-long prompt id and its key', () => {
    recordActivationObserved(RUN, { prompt_id: 'x'.repeat(129) }, { storeDir });
    const { data } = readDecisionEvents(RUN, { storeDir })[0];
    expect(data.prompt_id).toBeNull();
    expect(data.idempotency_key).toBeNull();
  });

  it('never throws on a malformed observation', () => {
    expect(() => recordActivationObserved(RUN, null, { storeDir })).not.toThrow();
    expect(() => recordActivationObserved(RUN, 'nope', { storeDir })).not.toThrow();
    expect(readDecisionEvents(RUN, { storeDir })).toHaveLength(2);
  });
});

describe('record size', () => {
  it('stays small enough that per-prompt recording costs nothing meaningful', () => {
    recordActivationObserved('run-1', buildActivationRecord({
      topology: { mode: 'split', reason: ['nl-match:flag-split'] },
      slashCommand: 'split',
      promptId: 'p-1',
    }), { storeDir });

    const bytes = Buffer.byteLength(rawFile(), 'utf-8');
    // Reported, not silently asserted: a reader of this suite should see the
    // number rather than trust a bound. Synthetic record, tmpdir store. The
    // bounds below would still pass if the payload silently doubled, so the
    // printed value is the part that carries information.
    // eslint-disable-next-line no-console -- the measurement is the point; a size assertion alone hides the number
    console.info(`[activation-observed] one record = ${bytes} B (synthetic, runId=run-1)`);
    expect(bytes).toBeGreaterThan(200);
    expect(bytes).toBeLessThan(600);
  });
});
