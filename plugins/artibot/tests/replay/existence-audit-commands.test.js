/**
 * `lib/replay/existence-audit.js` — the COMMANDS carrier fold (SH-29 part B).
 *
 * WHY A SECOND FILE. `tests/replay/existence-audit.test.js` was 837 lines after
 * the carrier pins were re-derived for this wave (measured 2026-09-17,
 * `wc -l`), past the repo's 800-line standard, so the new fold cases land here
 * under the `<stem>-<suffix>` rule rather than pushing that file further out.
 * The CARRIER/CARRIER_NOTES pins stay there; only the arithmetic is here.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9 — stated next to the gate):
 *   - THAT ANY ROW IS EVER WRITTEN. Every event below is a hand-built fixture.
 *     The writer's round trip is `tests/hooks/runtime-prompt-command-wiring
 *     .test.js`; this file is pure arithmetic over injected lines.
 *   - ANY LIVE FIRING RATE. No number here comes from a real ledger.
 *   - THAT AN INVENTORY SPELLING MATCHES THE ROWS. The fold matches names
 *     literally. The `doctor` case below is precisely the false `fired: 0` that
 *     a mismatched spelling produces, asserted so the shape is visible rather
 *     than discovered in a report.
 *
 * @module tests/replay/existence-audit-commands
 */

import { describe, expect, it } from 'vitest';
import {
  buildExistenceAudit, CARRIERS, foldFiredCounts,
} from '../../lib/replay/existence-audit.js';

/**
 * One ledger line, minimal but shaped like the writer's output.
 *
 * @param {string} event - registered event name.
 * @param {object} data - the `data` object.
 * @returns {object} a ledger line.
 */
function line(event, data) {
  return {
    v: '1.0',
    ts: '2026-09-17T00:00:00.000Z',
    event,
    mission_id: 'M-20260917-Sabcdef12',
    session_id: 's1',
    source: 'hook',
    pid: 1,
    seq: 0,
    data,
  };
}

/** Two slash rows plus one classifier-style row that names no command. */
const EVENTS = [
  line('intent.detected', { type: 'slash-command', confidence: 1, command: 'split' }),
  line('intent.detected', { type: 'slash-command', confidence: 1, command: 'team' }),
  // The rows this event was ORIGINALLY registered for: an intent type, no
  // command. They must not vanish from the denominator and must not invent a
  // bucket — that is the whole reason `command` stays out of `required`.
  line('intent.detected', { type: 'question', confidence: 0.4 }),
];

describe('the commands fold counts slash rows and buckets the rest as absent', () => {
  it('folds two named commands, one absent, denominator 3', () => {
    const fold = foldFiredCounts(EVENTS, CARRIERS.commands);
    expect(fold.counts).toEqual({ split: 1, team: 1 });
    expect(fold.absent).toBe(1);
    expect(fold.denominator).toBe(3);
  });

  it('ignores rows of every other event', () => {
    const fold = foldFiredCounts([
      ...EVENTS,
      line('tool.used', { tool: 'Skill', ok: true, duration_ms: null, skill: 'artibot:split' }),
      line('hook.fired', { slot: 'Stop', hooks: ['stop-recap'], failed: [], count: 1 }),
    ], CARRIERS.commands);
    // Unchanged: the denominator is rows OF intent.detected, not lines handed in.
    expect(fold.denominator).toBe(3);
    expect(fold.counts).toEqual({ split: 1, team: 1 });
  });

  it('is SINGLE-valued — an array value is absent, not a set of names', () => {
    // A defect-shaped row. In multi mode this would count two names; in single
    // mode `countBy` refuses a non-scalar and the row lands in `absent`. Pinned
    // so a later `multi: true` on this carrier cannot pass unnoticed.
    const fold = foldFiredCounts(
      [line('intent.detected', { type: 'slash-command', confidence: 1, command: ['a', 'b'] })],
      CARRIERS.commands,
    );
    expect(fold.counts).toEqual({});
    expect(fold.absent).toBe(1);
    expect(fold.denominator).toBe(1);
  });
});

describe('the audit reports a measured zero for an inventoried command that never fired', () => {
  it('counts split and team, and calls doctor a MEASURED zero', () => {
    const audit = buildExistenceAudit(EVENTS, {
      inventory: { commands: ['split', 'team', 'doctor'] },
    });
    const byName = Object.fromEntries(audit.kinds.commands.entries.map((e) => [e.name, e]));

    expect(audit.kinds.commands.denominator).toBe(3);
    expect(byName.split.fired).toBe(1);
    expect(byName.team.fired).toBe(1);
    // MEASURED TRUE with fired 0 — the reading that is evidence for removal,
    // and the reading a spelling mismatch or a namespaced slash counterfeits.
    // Asserted, not hoped for: `measured` must be true here, because the fold
    // really did look and really did not find it.
    expect(byName.doctor.fired).toBe(0);
    expect(byName.doctor.measured).toBe(true);
    expect(byName.doctor.reason).toBeNull();
    // Observe records; it never judges, whatever the count says.
    for (const entry of audit.kinds.commands.entries) {
      expect(entry.candidate, entry.name).toBe(false);
    }
  });

  it('does not contaminate the other kinds', () => {
    const audit = buildExistenceAudit(EVENTS, {
      inventory: { commands: ['split'], hooks: ['runtime-prompt'], modules: ['replay.js'] },
    });
    // No hook.fired row here, so hooks is carried but empty; modules has no
    // carrier at all. The two must keep different reasons.
    expect(audit.kinds.hooks.denominator).toBe(0);
    expect(audit.kinds.hooks.entries[0].reason)
      .toBe('unmeasured:carrier-event-absent-from-ledger');
    expect(audit.kinds.modules.entries[0].reason).toBe('unmeasured:no-event-carries-module');
  });
});
