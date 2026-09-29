/**
 * R1 / OB-24 (2026-09-29) -- the `where` scope on an Existence Audit carrier,
 * and the one carrier that uses it: `skills`.
 *
 * WHY THIS EXISTS. `tool.used` carries two tools since SH-09 (2e44461d): Skill
 * and AskUserQuestion. `CARRIERS.skills` used to filter on the EVENT only, so
 * every question row landed in the skills fold's `absent` bucket AND counted
 * toward its denominator, and a ledger holding question rows but no Skill row
 * read every skill as `measured: true, fired: 0` where it used to read
 * `unmeasured`. Per-skill `fired` counts were never affected -- a row with no
 * `skill` credits nobody -- which is why the defect was a denominator defect
 * and not a count defect. The carrier is now scoped to `data.tool === 'Skill'`.
 *
 * Sibling of `existence-audit.test.js`, split out because that file was already
 * past the 800-line cap. The carrier pin and the note pins stay THERE; the
 * behaviour of the scope lives here.
 *
 * WHAT THIS CANNOT SEE. It folds hand-built lines. Whether the live ledger's
 * Skill rows all carry `data.tool === 'Skill'` (they are written by
 * `tool-used-record.js`, which requires `tool`) was not measured by this file.
 *
 * @module tests/replay/existence-audit-scope
 */

import { describe, expect, it } from 'vitest';

import {
  buildExistenceAudit,
  CARRIER_ABSENT_REASON,
  CARRIERS,
  foldFiredCounts,
} from '../../lib/replay/existence-audit.js';

function line(event, data) {
  return {
    v: 1,
    ts: '2026-09-29T00:00:00.000Z',
    event,
    mission_id: 'M-20260929-001',
    session_id: 's1',
    source: 'hook',
    pid: 1,
    seq: 0,
    data,
  };
}

/** A Skill row as `tool-used-record.js` writes it; the key is OMITTED when unnamed. */
const skillRow = (name) => line('tool.used', {
  tool: 'Skill', ok: true, duration_ms: null, ...(name === undefined ? {} : { skill: name }),
});
const questionRow = () => line('tool.used', { tool: 'AskUserQuestion', ok: true, duration_ms: 15234 });
const bashRow = () => line('tool.used', { tool: 'Bash', ok: true, duration_ms: 12 });

describe('the skills carrier is scoped to Skill rows', () => {
  it('does not count a question row: not a bucket, not absent, not in the denominator', () => {
    const events = [skillRow('artibot:split'), questionRow(), questionRow(), bashRow()];
    expect(foldFiredCounts(events, CARRIERS.skills)).toEqual({
      counts: { 'artibot:split': 1 },
      absent: 0,
      denominator: 1,
    });
  });

  it('still counts a Skill row that names none as absent: that is what absent is for', () => {
    const events = [skillRow('artibot:split'), skillRow(undefined), questionRow()];
    expect(foldFiredCounts(events, CARRIERS.skills)).toEqual({
      counts: { 'artibot:split': 1 },
      absent: 1,
      denominator: 2,
    });
  });

  it('reads a ledger holding only question rows as UNMEASURED for skills, never a measured zero', () => {
    const inventory = { skills: ['split', 'team'] };
    const questionsOnly = buildExistenceAudit([questionRow(), questionRow()], { inventory });
    expect(questionsOnly.kinds.skills.denominator).toBe(0);
    for (const entry of questionsOnly.kinds.skills.entries) {
      expect(entry.measured, entry.name).toBe(false);
      expect(entry.fired, entry.name).toBeNull();
      expect(entry.reason, entry.name).toBe(CARRIER_ABSENT_REASON);
    }

    // Control in the same shape: one Skill row makes the kind measurable, and only then.
    const withSkill = buildExistenceAudit([questionRow(), skillRow('split')], { inventory });
    const byName = Object.fromEntries(withSkill.kinds.skills.entries.map((e) => [e.name, e]));
    expect(byName.split).toMatchObject({ fired: 1, measured: true });
    expect(byName.team).toMatchObject({ fired: 0, measured: true });
    expect(withSkill.kinds.skills.denominator).toBe(1);
  });

  it('leaves per-skill fired counts exactly as they were: the defect was in the denominator', () => {
    const skillsOnly = [skillRow('split'), skillRow('split'), skillRow('team')];
    const withQuestions = [...skillsOnly, questionRow(), questionRow(), questionRow()];
    expect(foldFiredCounts(withQuestions, CARRIERS.skills).counts)
      .toEqual(foldFiredCounts(skillsOnly, CARRIERS.skills).counts);
  });

  it('is decided by each row\'s own data.tool, so rows written before the scope existed are corrected too', () => {
    // Pre-SH-09 ledgers hold Skill rows and non-Skill tool rows only; both carry `tool`.
    const old = [skillRow('split'), bashRow(), line('tool.used', { tool: 'Read', ok: true, duration_ms: 3 })];
    expect(foldFiredCounts(old, CARRIERS.skills)).toEqual({
      counts: { split: 1 }, absent: 0, denominator: 1,
    });
  });
});

describe('the scope is strict', () => {
  it.each([
    ['a lowercase tool name', { tool: 'skill', skill: 'split' }],
    ['a padded tool name', { tool: 'Skill ', skill: 'split' }],
    ['a namespaced tool name', { tool: 'mcp__Skill', skill: 'split' }],
    ['no tool at all', { skill: 'split' }],
    ['a non-string tool', { tool: ['Skill'], skill: 'split' }],
  ])('drops a row with %s', (_label, data) => {
    expect(foldFiredCounts([line('tool.used', data)], CARRIERS.skills))
      .toEqual({ counts: {}, absent: 0, denominator: 0 });
  });

  it('drops a row with no data object, and a row whose tool is only inherited', () => {
    const inherited = { event: 'tool.used', data: Object.create({ tool: 'Skill' }) };
    expect(foldFiredCounts([{ event: 'tool.used' }, { event: 'tool.used', data: null }, inherited], CARRIERS.skills))
      .toEqual({ counts: {}, absent: 0, denominator: 0 });
  });

  it('applies to a multi-valued carrier too: a row outside the scope is not absent there either', () => {
    const carrier = { event: 'hook.fired', field: 'hooks', multi: true, where: { slot: 'Stop' } };
    const events = [
      line('hook.fired', { slot: 'Stop', hooks: ['stop-recap'], count: 1 }),
      line('hook.fired', { slot: 'Stop', hooks: 'stop-recap', count: 1 }),
      line('hook.fired', { slot: 'PreToolUse', hooks: ['pre-bash'], count: 1 }),
    ];
    expect(foldFiredCounts(events, carrier)).toEqual({
      counts: { 'stop-recap': 1 },
      absent: 1,
      denominator: 2,
    });
  });

  it('leaves a carrier without a scope exactly as it was: every row of the event belongs', () => {
    const events = [skillRow('split'), questionRow(), bashRow()];
    expect(foldFiredCounts(events, { event: 'tool.used', field: 'skill' }))
      .toEqual({ counts: { split: 1 }, absent: 2, denominator: 3 });
    // The other two shipped carriers carry no scope.
    expect(CARRIERS.hooks.where).toBeUndefined();
    expect(CARRIERS.commands.where).toBeUndefined();
  });
});

describe('a malformed scope is refused, not read as "no rows" or "all rows"', () => {
  it.each([
    ['an empty map', {}],
    ['an array', ['tool']],
    ['null', null],
    ['a string', 'tool=Skill'],
    ['an object value', { tool: {} }],
    ['a null value', { tool: null }],
    ['an undefined value', { tool: undefined }],
    ['a function value', { tool: () => 'Skill' }],
  ])('throws for %s', (_label, where) => {
    expect(() => foldFiredCounts([skillRow('split')], { event: 'tool.used', field: 'skill', where }))
      .toThrow(/where must be a non-empty/);
  });

  it('accepts string, number and boolean scalars', () => {
    const events = [line('x.y', { a: 'k', n: 1, b: true, name: 'z' }), line('x.y', { a: 'k', n: 2, b: true, name: 'q' })];
    expect(foldFiredCounts(events, { event: 'x.y', field: 'name', where: { a: 'k', n: 1, b: true } }))
      .toEqual({ counts: { z: 1 }, absent: 0, denominator: 1 });
  });
});
