/**
 * Existence Audit — the tests that keep an UNMEASURED thing from reading as a
 * measured zero.
 *
 * CLAUDE.md:86 says a thing with zero consumers and zero firings for two
 * releases becomes a removal candidate. Every failure mode of that rule points
 * the same way: something gets deleted because nobody was listening, not
 * because nothing spoke. So the assertions here are mostly about which zero is
 * which.
 *
 *   1. A KIND WITH NO CARRIER REPORTS null, NOT 0. Two kinds still have none:
 *      no registered event names a command or a `lib/` module (re-measured
 *      2026-09-15 across the 39 events then in
 *      `schemas/ledger-events.allowlist.json`, 40 once Wave 12 registered
 *      `hook.fired`; it was all four kinds and 36 events on 2026-09-02).
 *      `fired: 0` there would be a number nobody measured. `skills` left that
 *      state in Wave 11 — `tool.used.skill`, written by
 *      `scripts/hooks/tool-used-record.js` — and `hooks` in Wave 12 —
 *      `hook.fired.hooks`, written by `scripts/hooks/_hook-fired-record.js`.
 *      The cases below assert BOTH regimes.
 *   1b. THE HOOKS CARRIER IS MULTI-VALUED. One `hook.fired` row is one
 *      dispatch and names SEVERAL handlers, so the denominator is dispatch
 *      rows, not names, and a name's count is the number of rows containing
 *      it. The cases pin that a row whose field is not an array is `absent`
 *      while still counting toward the denominator, that non-string elements
 *      are skipped without dropping their row, and that a repeated element
 *      inside one row counts twice (the chosen semantics — the dispatch table
 *      never repeats a name within a slot, so a repeat is a writer defect and
 *      must stay visible).
 *   2. A CARRIER WITH AN EMPTY LEDGER IS ALSO null, and carries a DIFFERENT
 *      reason string than case 1. "The field does not exist" and "the field
 *      exists and saw nothing" are different facts about the world. With a real
 *      carrier this stopped being hypothetical: a ledger holding no `tool.used`
 *      row reports `unmeasured:carrier-event-absent-from-ledger`, never
 *      `fired: 0`, because a zero there would read as removal evidence for a
 *      skill nobody had instrumented yet.
 *   3. AN EXEMPT ENTRY IS STILL COUNTED, never skipped. Exemption changes the
 *      verdict, not the measurement — CLAUDE.md:88 says "실측과 무관하게 유지".
 *   4. THE EXEMPT LIST DOES NOT DRIFT. The module restates CLAUDE.md:88 as a
 *      constant; this file parses that line and compares item for item, in
 *      order. A restated safety list nobody compares is a list that drifts.
 *   5. `candidate` IS HARD false. Observe records; it does not judge.
 *   6. `summary.eventsReceived` IS SURVIVORS, NOT LEDGER LINES. It is the
 *      audit's denominator, so reading it as the ledger's line count overstates
 *      every firing rate. One case writes a real ledger with a corrupt line and
 *      pins `eventsReceived < raw lines`.
 *
 * ── WHAT THESE TESTS CANNOT SEE (repo rules §9) ─────────────────────────────
 *   - NO FIXTURE HERE IS LIVE TRAFFIC. The 2026-09-02 note said no live ledger
 *     existed; that reading used the wrong path. The ledger lands at
 *     `<git-common-dir>/artibot/ledger.jsonl` (`lib/runtime/event-writer.js`
 *     :261-273), and measured there 2026-09-15 it holds 1,167 lines across 10
 *     distinct events — with `tool.used` rows = 0, so the newly carried
 *     `skills` kind has a writer and no rows yet. Every fixture below is
 *     hand-built and tiny; passing here says the arithmetic is right, not that
 *     it survives real traffic, real volume, or a real inventory. The
 *     survivors case does
 *     write a REAL ledger, but into a temp directory, three lines long, so it
 *     proves the reader drops a corrupt line and nothing about live scale.
 *   - NO CONSUMER COUNT IS TESTED, because none is computed. Half of
 *     CLAUDE.md:86's rule is out of the ledger's reach and stays a literal
 *     'unmeasured' string; these tests pin that string, not a number.
 *   - NO RELEASE HISTORY. `candidate` is asserted false everywhere, which is
 *     easy precisely because the two-release rule is unimplementable from one
 *     fold. When release history arrives, these assertions must be revisited
 *     rather than trusted.
 *   - THE PURITY CHECK IS A TEXT SCAN. It reads the module source for `node:fs`
 *     and clock/randomness tokens. An effect reached indirectly — through an
 *     injected callback or a dynamic import string — passes it. It closes the
 *     accidental path, not a determined one. The directory-wide version lives
 *     in `tests/replay/no-second-source.test.js`.
 *
 * @module tests/replay/existence-audit
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetSeq } from '../../lib/runtime/event-writer.js';
import {
  appendLedgerEvent, ledgerFilePath, readAllEvents, readLedgerCensus,
} from '../../lib/runtime/ledger.js';
import {
  AUDITED_KINDS,
  buildExistenceAudit,
  CANDIDATE_BLOCKED_REASON,
  CARRIER_ABSENT_REASON,
  CARRIER_NOTES,
  CARRIERS,
  CONSUMERS_UNMEASURED,
  EXEMPT_CONTRACTS,
  foldFiredCounts,
  KIND_SINGULAR,
  noCarrierReason,
  resolveExemption,
} from '../../lib/replay/existence-audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const MODULE_PATH = join(PLUGIN_ROOT, 'lib', 'replay', 'existence-audit.js');
const CLAUDE_MD_PATH = join(PLUGIN_ROOT, 'CLAUDE.md');
const DISPATCH_TABLE_PATH = join(PLUGIN_ROOT, 'hooks', 'dispatch-table.json');

/** CLAUDE.md line number (1-based) of the 면제 sentence the constant restates. */
const EXEMPT_LINE_NO = 88;

/** A carrier that does not exist in the allowlist, used to exercise the fold. */
const HYPOTHETICAL_CARRIER = Object.freeze({ event: 'tool.used', field: 'tool' });

/**
 * A minimal ledger line.
 *
 * @param {string} event - event name.
 * @param {object} data - event payload.
 * @returns {object} ledger line.
 */
function line(event, data) {
  return {
    v: 1,
    ts: '2026-09-02T10:00:00.000Z',
    event,
    mission_id: 'M-20260902-044',
    session_id: 's1',
    source: 'hook',
    pid: 1,
    seq: 0,
    data,
  };
}

describe('an unmeasured kind reports null, never zero', () => {
  it('hooks and skills are carried; commands and modules are still null', () => {
    // A PIN, not a description. If someone adds another carrier this fails on
    // purpose: the module header states which kinds are measured and why the
    // rest are not, and a new carrier makes that statement stale. `skills`
    // measured 2026-09-15 (Wave 11), `hooks` 2026-09-17 (Wave 12), both SH-29.
    expect(CARRIERS.skills).toEqual({ event: 'tool.used', field: 'skill' });
    expect(CARRIERS.hooks).toEqual({ event: 'hook.fired', field: 'hooks', multi: true });
    // Only `hooks` is multi-valued; a second one would change how every reader
    // has to interpret the denominator, so it does not slip in unannounced.
    expect(AUDITED_KINDS.filter((k) => CARRIERS[k]?.multi === true)).toEqual(['hooks']);
    for (const kind of ['commands', 'modules']) {
      expect(CARRIERS[kind], `${kind} carrier`).toBeNull();
    }
    // Every kind states WHERE its number comes from, or why there is none.
    for (const kind of AUDITED_KINDS) {
      expect(CARRIER_NOTES[kind], `${kind} note`).toEqual(expect.any(String));
    }
    expect(CARRIER_NOTES.skills).toContain('tool.used.skill');
    expect(CARRIER_NOTES.hooks).toContain('hook.fired');
    expect(CARRIER_NOTES.hooks).toContain('_hook-fired-record.js');
    // The note must keep naming what the carrier CANNOT see: the 24 hooks
    // registered straight in hooks.json never produce a hook.fired row, so
    // their zero is false. A note that drops that number stops warning.
    expect(CARRIER_NOTES.hooks).toContain('24');
    expect(CARRIER_NOTES.hooks).toContain('hooks.json');
  });

  it('fired is null and the reason names the kind', () => {
    const audit = buildExistenceAudit([], { inventory: { commands: ['doctor'] } });
    const [entry] = audit.kinds.commands.entries;
    expect(entry.fired).toBeNull();
    expect(entry.fired).not.toBe(0);
    expect(entry.measured).toBe(false);
    expect(entry.reason).toBe('unmeasured:no-event-carries-command');
  });

  it('hooks now reports carrier-absent, not no-carrier, on an empty ledger', () => {
    // Re-derived for Wave 12: this case used to assert
    // `unmeasured:no-event-carries-hook`. With a carrier present that reason is
    // wrong — the field exists and the ledger simply holds none of its rows,
    // which is a different fact and must keep a different string. `fired` stays
    // null either way, which is the part that protects against deletion.
    const audit = buildExistenceAudit([], { inventory: { hooks: ['runtime-prompt'] } });
    const [entry] = audit.kinds.hooks.entries;
    expect(entry.reason).toBe(CARRIER_ABSENT_REASON);
    expect(entry.reason).toBe('unmeasured:carrier-event-absent-from-ledger');
    expect(entry.reason).not.toBe(noCarrierReason('hooks'));
    expect(entry.fired).toBeNull();
    expect(entry.fired).not.toBe(0);
    expect(entry.measured).toBe(false);
    expect(audit.kinds.hooks.denominator).toBe(0);
  });

  it('the reason string uses the singular kind noun for all four kinds', () => {
    expect(AUDITED_KINDS.map(noCarrierReason)).toEqual([
      'unmeasured:no-event-carries-hook',
      'unmeasured:no-event-carries-command',
      'unmeasured:no-event-carries-skill',
      'unmeasured:no-event-carries-module',
    ]);
    expect(Object.keys(KIND_SINGULAR).sort()).toEqual([...AUDITED_KINDS].sort());
  });

  it('consumers is a literal unmeasured, not a count', () => {
    const audit = buildExistenceAudit([], { inventory: { modules: ['lib/replay/load.js'] } });
    expect(audit.kinds.modules.entries[0].consumers).toBe(CONSUMERS_UNMEASURED);
    expect(CONSUMERS_UNMEASURED).toBe('unmeasured');
  });

  it('a zero denominator never becomes a rate: no percentage field exists', () => {
    const audit = buildExistenceAudit([], { inventory: { skills: ['doctor'] } });
    const entry = audit.kinds.skills.entries[0];
    expect(entry.denominator).toBe(0);
    expect(Object.keys(entry)).not.toContain('rate');
    expect(Object.keys(entry)).not.toContain('percent');
  });
});

describe('an empty ledger and an absent carrier are different zeros', () => {
  it('a carrier over an empty ledger reports its own reason', () => {
    const fold = foldFiredCounts([], HYPOTHETICAL_CARRIER);
    expect(fold).toEqual({ counts: {}, absent: 0, denominator: 0 });
    expect(CARRIER_ABSENT_REASON).not.toBe(noCarrierReason('skills'));
  });

  it('no carrier yields null rather than an empty fold', () => {
    expect(foldFiredCounts([line('tool.used', { tool: 'Bash' })], null)).toBeNull();
    expect(foldFiredCounts([], undefined)).toBeNull();
  });

  it('the summary keeps the received count beside the zeros', () => {
    const events = [line('tool.used', { tool: 'Bash' }), line('phase.started', { segment: 'x' })];
    const audit = buildExistenceAudit(events, { inventory: { hooks: ['a'] } });
    expect(audit.summary.eventsReceived).toBe(2);
    // The entry is unmeasured even though the ledger is not empty. Without
    // eventsReceived those two zeros would be indistinguishable to a reader.
    expect(audit.kinds.hooks.entries[0].denominator).toBe(0);
  });

  it('does not expose the old ledgerLines name, which overstated what it counts', () => {
    const audit = buildExistenceAudit([line('tool.used', { tool: 'Bash' })], { inventory: {} });
    expect(Object.keys(audit.summary)).toContain('eventsReceived');
    expect(Object.keys(audit.summary)).not.toContain('ledgerLines');
  });
});

describe('eventsReceived counts SURVIVORS, not the ledger lines', () => {
  // The misreading the rename exists to prevent: this number is the Existence
  // Audit's denominator, so treating it as the ledger's line count makes every
  // firing rate computed against it read HIGH. Mirrors T-41's
  // `load.test.js` "totals.received counts SURVIVORS" case, one layer up.
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artibot-existence-audit-'));
    resetSeq();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a corrupt line reaches the file but never the audit', () => {
    for (const duration of [0, 1]) {
      appendLedgerEvent(root, {
        event: 'tool.used',
        session_id: 'sess-existence-audit-01',
        source: 'hook',
        mission_id: 'M-20260902-044',
        data: { tool: 'Bash', ok: true, duration_ms: duration },
      });
    }
    appendFileSync(ledgerFilePath(root), '{"v":1,"ts":"broken\n', 'utf-8');

    const rawLines = readFileSync(ledgerFilePath(root), 'utf-8')
      .split('\n').filter((l) => l.trim().length > 0).length;
    // The reader is L5 and this module may not import it, so the TEST plays the
    // caller: read through the real reader, then hand the survivors to the audit.
    const survivors = readAllEvents(root);
    const audit = buildExistenceAudit(survivors, { inventory: { hooks: ['a'] } });

    expect(rawLines).toBe(3);
    expect(audit.summary.eventsReceived).toBe(2);
    // The audit looks internally consistent and says nothing about the lost
    // line, because upstream loss is not observable from here — and without a
    // census handed in, it says so: null, not zero.
    expect(audit.summary.eventsReceived).toBeLessThan(rawLines);
    expect(audit.summary.census).toBeNull();

    // Same read through the census port (F-30): the caller hands the census
    // in beside the survivors and the loss becomes visible at summary.census.
    // `eventsReceived` is unchanged — the census is an extra column, not a new
    // denominator; adopting one is a separate decision.
    const { events, census } = readLedgerCensus(root);
    const counted = buildExistenceAudit(events, { inventory: { hooks: ['a'] }, census });
    expect(counted.summary.eventsReceived).toBe(2);
    expect(counted.summary.census).toBe(census);
    expect(counted.summary.census.lines.nonblank).toBe(rawLines);
    expect(counted.summary.census.dropped.loss.corrupt).toBe(1);
    expect(counted.summary.census.survivors).toBe(counted.summary.eventsReceived);
  });
});

describe('the fold, exercised through a hypothetical carrier', () => {
  const events = [
    line('tool.used', { tool: 'Bash' }),
    line('tool.used', { tool: 'Bash' }),
    line('tool.used', { tool: 'Read' }),
    line('tool.used', {}),
    line('phase.started', { segment: 'build' }),
  ];

  it('counts only the carrier event and reports absent separately', () => {
    expect(foldFiredCounts(events, HYPOTHETICAL_CARRIER)).toEqual({
      counts: { Bash: 2, Read: 1 },
      absent: 1,
      denominator: 4,
    });
  });

  it('rejects a malformed carrier instead of folding nothing', () => {
    expect(() => foldFiredCounts(events, { event: 'tool.used' })).toThrow(/non-empty/);
    expect(() => foldFiredCounts(events, { event: '', field: 'tool' })).toThrow(/non-empty/);
  });

  it('rejects a non-array event list', () => {
    expect(() => foldFiredCounts(null, HYPOTHETICAL_CARRIER)).toThrow(/must be an array/);
    expect(() => buildExistenceAudit('nope', { inventory: {} })).toThrow(/must be an array/);
  });
});

describe('the skills carrier, folded from real tool.used rows', () => {
  // The regime this suite existed to describe as impossible. Wave 11 made it
  // possible, so both halves are pinned: the ledger WITHOUT the carrier event
  // still refuses to say zero, and the ledger WITH it produces per-skill counts.
  const INVENTORY = ['artibot:split', 'artibot:team'];

  it('a ledger holding no tool.used row is unmeasured, never a zero', () => {
    // RED-then-GREEN evidence for the false-zero this module exists to prevent:
    // the carrier is REAL now, so nothing structural stops a `fired: 0` here —
    // only the denominator > 0 branch does.
    const audit = buildExistenceAudit(
      [line('phase.started', { segment: 'build' })],
      { inventory: { skills: INVENTORY } },
    );
    expect(audit.kinds.skills.entries).toHaveLength(2);
    for (const entry of audit.kinds.skills.entries) {
      expect(entry.reason, entry.name).toBe(CARRIER_ABSENT_REASON);
      expect(entry.reason).toBe('unmeasured:carrier-event-absent-from-ledger');
      expect(entry.fired, entry.name).toBeNull();
      expect(entry.fired).not.toBe(0);
      expect(entry.measured, entry.name).toBe(false);
    }
    expect(audit.kinds.skills.denominator).toBe(0);
    // ...and it is NOT the no-carrier reason: the field exists, it saw nothing.
    expect(audit.kinds.skills.entries[0].reason).not.toBe(noCarrierReason('skills'));
    expect(audit.summary.eventsReceived).toBe(1);
  });

  it('counts per skill, with rows that name none counted as absent', () => {
    const events = [
      line('tool.used', { tool: 'Skill', ok: true, duration_ms: null, skill: 'artibot:split' }),
      line('tool.used', { tool: 'Skill', ok: true, duration_ms: null, skill: 'artibot:split' }),
      line('tool.used', { tool: 'Skill', ok: true, duration_ms: null, skill: 'artibot:team' }),
      // A tool.used row for a non-Skill tool: the key is OMITTED, never null.
      line('tool.used', { tool: 'Bash', ok: true, duration_ms: 12 }),
      line('phase.started', { segment: 'build' }),
    ];

    expect(foldFiredCounts(events, CARRIERS.skills)).toEqual({
      counts: { 'artibot:split': 2, 'artibot:team': 1 },
      absent: 1,
      denominator: 4,
    });

    const audit = buildExistenceAudit(events, {
      // The third name is inventoried but never fired. That is now a MEASURED
      // zero, which is the whole point of the carrier existing.
      inventory: { skills: [...INVENTORY, 'artibot:doctor'] },
    });
    const byNameMap = Object.fromEntries(audit.kinds.skills.entries.map((e) => [e.name, e]));
    expect(byNameMap['artibot:split'].fired).toBe(2);
    expect(byNameMap['artibot:team'].fired).toBe(1);
    expect(byNameMap['artibot:doctor'].fired).toBe(0);
    for (const entry of audit.kinds.skills.entries) {
      expect(entry.measured, entry.name).toBe(true);
      expect(entry.reason, entry.name).toBeNull();
      expect(entry.denominator, entry.name).toBe(4);
      // Measured or not, Observe still does not judge.
      expect(entry.candidate, entry.name).toBe(false);
      expect(entry.consumers, entry.name).toBe(CONSUMERS_UNMEASURED);
    }
    expect(audit.kinds.skills.denominator).toBe(4);
    expect(audit.summary.measured).toBe(3);
    // The other kinds are untouched by the skills carrier. `hooks` has its own
    // carrier now, so the assertion is no longer "null" — it is that the two
    // folds do not see each other's rows: there is no hook.fired line here, so
    // hooks stays at denominator 0 while skills counts 4.
    expect(audit.kinds.hooks.carrier).toEqual(CARRIERS.hooks);
    expect(audit.kinds.hooks.denominator).toBe(0);
    expect(audit.kinds.commands.carrier).toBeNull();
    expect(audit.kinds.modules.carrier).toBeNull();
  });

  it('skills and hooks rows in one ledger do not contaminate each other', () => {
    const events = [
      line('tool.used', { tool: 'Skill', ok: true, duration_ms: null, skill: 'artibot:split' }),
      line('hook.fired', {
        slot: 'Stop', hooks: ['stop-recap', 'session-ledger'], failed: [], count: 2,
      }),
      line('hook.fired', {
        slot: 'Stop', hooks: ['stop-recap'], failed: ['stop-recap'], count: 1,
      }),
    ];
    const audit = buildExistenceAudit(events, {
      inventory: { skills: ['artibot:split'], hooks: ['stop-recap', 'session-ledger'] },
    });
    // Two carriers, two independent denominators, from the same three lines.
    expect(audit.kinds.skills.denominator).toBe(1);
    expect(audit.kinds.hooks.denominator).toBe(2);
    expect(audit.kinds.skills.entries[0].fired).toBe(1);
    const hooksByName = Object.fromEntries(audit.kinds.hooks.entries.map((e) => [e.name, e]));
    expect(hooksByName['stop-recap'].fired).toBe(2);
    expect(hooksByName['session-ledger'].fired).toBe(1);
    // A handler that FAILED still fired. `failed` is a separate field and this
    // fold does not read it — reporting a failed dispatch as "never fired"
    // would make a broken hook look like a removal candidate.
    expect(hooksByName['stop-recap'].measured).toBe(true);
  });

  it('a null skill is absent, not a bucket named "null"', () => {
    // The writer must OMIT the key rather than write null (matchesType rejects
    // null for a declared string). If one slips through anyway, countBy treats
    // any non-scalar as absent, so it can never collide with a real skill name.
    const events = [
      line('tool.used', { tool: 'Skill', ok: true, duration_ms: null, skill: null }),
      line('tool.used', { tool: 'Skill', ok: true, duration_ms: null, skill: 'artibot:split' }),
    ];
    const fold = foldFiredCounts(events, CARRIERS.skills);
    expect(fold).toEqual({ counts: { 'artibot:split': 1 }, absent: 1, denominator: 2 });
    expect(Object.keys(fold.counts)).not.toContain('null');
    expect(Object.keys(fold.counts)).not.toContain('undefined');

    const audit = buildExistenceAudit(events, { inventory: { skills: ['null'] } });
    // A skill literally NAMED "null" must not inherit the absent rows.
    expect(audit.kinds.skills.entries[0].fired).toBe(0);
    expect(audit.kinds.skills.entries[0].measured).toBe(true);
  });

  it('an inventory name that does not match the writer reads as a false zero', () => {
    // Not a defect this module can fix — a pin on the hazard so the next reader
    // meets it as a known contract rather than as a surprise deletion. The
    // writer records the host's name for the skill; an inventory built from
    // bare directory names does not match it.
    const events = [
      line('tool.used', { tool: 'Skill', ok: true, duration_ms: null, skill: 'artibot:split' }),
    ];
    const audit = buildExistenceAudit(events, { inventory: { skills: ['split'] } });
    const [entry] = audit.kinds.skills.entries;
    expect(entry.fired).toBe(0);
    expect(entry.measured).toBe(true);
    expect(entry.denominator).toBe(1);
  });
});

describe('the hooks carrier is MULTI-valued: one row, many names', () => {
  // Wave 12 / SH-29, owner decision O8 = a1 (2026-09-17). One `hook.fired` row
  // per dispatcher invocation. The denominator is DISPATCHES, so a rate built
  // on it reads "share of dispatches that reached this handler" and can never
  // exceed 1 — which is the whole reason rows, not names, are counted.

  /** The six handlers a PostToolUse Edit dispatch fanned out to. */
  const PTU_EDIT = Object.freeze([
    'pre-write-guard', 'quality-gate', 'post-edit-format', 'post-edit-recovery',
    'mark-main-agent-edit', 'tool-tracker',
  ]);
  /** A PostToolUse Skill dispatch: a shorter fan-out, sharing one name above. */
  const PTU_SKILL = Object.freeze(['tool-tracker', 'tool-used-record']);
  /** The seven in-process UserPromptSubmit handlers. */
  const UPS = Object.freeze([
    'user-prompt-handler', 'auto-team-trigger', 'runtime-prompt', 'autopilot-nlu-trigger',
    'auto-command-suggest', 'ambiguity-guard', 'git-autopilot-save',
  ]);

  const DISPATCHES = [
    line('hook.fired', {
      slot: 'PostToolUse', tool: 'Edit', hooks: [...PTU_EDIT], failed: [], count: 6,
    }),
    line('hook.fired', {
      slot: 'PostToolUse', tool: 'Skill', hooks: [...PTU_SKILL], failed: [], count: 2,
    }),
    line('hook.fired', { slot: 'UserPromptSubmit', hooks: [...UPS], failed: [], count: 7 }),
  ];

  /**
   * Every handler name the dispatch table declares, deduplicated.
   *
   * Read from the real file rather than restated: a hard-coded list would pass
   * forever after someone adds a handler, which is the drift the existence
   * audit exists to catch. Deduplicated because `memory-tracker` and
   * `session-ledger` each sit in two slots (44 entries, 42 distinct names,
   * measured 2026-09-17) and `buildExistenceAudit` refuses a duplicate name.
   *
   * @returns {string[]} distinct handler names, in first-appearance order.
   */
  function dispatchTableNames() {
    const table = JSON.parse(readFileSync(DISPATCH_TABLE_PATH, 'utf-8'));
    const names = Object.values(table.slots).flatMap((s) => s.handlers.map((h) => h.name));
    expect(names.length, 'dispatch-table handler entries').toBeGreaterThan(0);
    return [...new Set(names)];
  }

  it('counts every element of every row; the denominator stays rows', () => {
    const fold = foldFiredCounts(DISPATCHES, CARRIERS.hooks);
    // 3 rows carrying 15 name occurrences across 14 distinct names. The
    // denominator is 3 — the arithmetic that makes "fired/denominator" a share
    // of dispatches instead of a share of some name total nobody asked for.
    expect(fold.denominator).toBe(3);
    expect(fold.absent).toBe(0);
    expect(fold.counts['tool-tracker']).toBe(2);
    expect(fold.counts['tool-used-record']).toBe(1);
    expect(fold.counts['ambiguity-guard']).toBe(1);
    expect(Object.keys(fold.counts)).toHaveLength(14);
    expect(Object.values(fold.counts).reduce((a, b) => a + b, 0)).toBe(15);
    // Key-sorted, like countBy: the same input must serialise identically.
    expect(Object.keys(fold.counts)).toEqual([...Object.keys(fold.counts)].sort());
  });

  it('an element repeated inside ONE row counts twice (chosen semantics)', () => {
    // The alternative was per-row dedupe. Counting occurrences was chosen
    // because the dispatch table never lists a handler twice in one slot, so a
    // repeat inside a row is a WRITER defect and must stay visible rather than
    // be smoothed into a plausible 1. Pinned so the choice cannot drift
    // silently in either direction.
    const fold = foldFiredCounts(
      [line('hook.fired', { slot: 'Stop', hooks: ['stop-recap', 'stop-recap'], count: 2 })],
      CARRIERS.hooks,
    );
    expect(fold).toEqual({ counts: { 'stop-recap': 2 }, absent: 0, denominator: 1 });
  });

  it('a row whose field is not an array is absent but still counted', () => {
    const rows = [
      line('hook.fired', { slot: 'Stop', hooks: ['stop-recap'], count: 1 }),
      line('hook.fired', { slot: 'Stop', hooks: 'stop-recap', count: 1 }),
      line('hook.fired', { slot: 'Stop', hooks: null, count: 0 }),
      line('hook.fired', { slot: 'Stop', count: 0 }),
    ];
    const fold = foldFiredCounts(rows, CARRIERS.hooks);
    expect(fold.absent).toBe(3);
    // The malformed rows still happened, so they stay in the denominator: a
    // writer that breaks its own field must DEPRESS the rate, never shrink the
    // denominator until the survivors look healthy.
    expect(fold.denominator).toBe(4);
    expect(fold.counts).toEqual({ 'stop-recap': 1 });
    expect(Object.keys(fold.counts)).not.toContain('null');
    expect(Object.keys(fold.counts)).not.toContain('undefined');
    expect(Object.keys(fold.counts)).not.toContain('s');
  });

  it('non-string elements are skipped without dropping their row', () => {
    const fold = foldFiredCounts(
      [line('hook.fired', {
        slot: 'Stop', hooks: ['stop-recap', 42, null, undefined, '', { name: 'x' }, ['y']],
        count: 7,
      })],
      CARRIERS.hooks,
    );
    // The row named a real handler, so it is NOT absent — dropping it would
    // lose a firing that genuinely happened.
    expect(fold).toEqual({ counts: { 'stop-recap': 1 }, absent: 0, denominator: 1 });
    expect(Object.keys(fold.counts)).toEqual(['stop-recap']);
  });

  it('a non-multi carrier is byte-for-byte the old single-value behaviour', () => {
    // The regression guard for the mode switch: `multi` absent or false must
    // leave countBy in charge, or every skills number changes meaning.
    const events = [
      line('tool.used', { tool: 'Skill', skill: 'artibot:split' }),
      line('tool.used', { tool: 'Bash' }),
    ];
    const expected = { counts: { 'artibot:split': 1 }, absent: 1, denominator: 2 };
    expect(foldFiredCounts(events, CARRIERS.skills)).toEqual(expected);
    expect(foldFiredCounts(events, { event: 'tool.used', field: 'skill', multi: false }))
      .toEqual(expected);
    // An ARRAY value under a non-multi carrier is non-scalar, so countBy files
    // it as absent rather than silently counting its elements.
    expect(foldFiredCounts(
      [line('tool.used', { tool: 'Skill', skill: ['a', 'b'] })],
      CARRIERS.skills,
    )).toEqual({ counts: {}, absent: 1, denominator: 1 });
  });

  it('a malformed multi carrier still throws instead of folding nothing', () => {
    expect(() => foldFiredCounts(DISPATCHES, { field: 'hooks', multi: true }))
      .toThrow(/non-empty/);
    expect(() => foldFiredCounts(DISPATCHES, { event: 'hook.fired', field: '', multi: true }))
      .toThrow(/non-empty/);
  });

  it('audits the whole dispatch table: 42 names, 3 dispatches, real counts', () => {
    const inventory = dispatchTableNames();
    const audit = buildExistenceAudit(DISPATCHES, { inventory: { hooks: inventory } });
    const block = audit.kinds.hooks;
    expect(block.entries).toHaveLength(inventory.length);
    expect(block.denominator).toBe(3);

    const byNameMap = Object.fromEntries(block.entries.map((e) => [e.name, e]));
    expect(byNameMap['tool-tracker'].fired).toBe(2);
    expect(byNameMap['tool-used-record'].fired).toBe(1);
    for (const name of UPS) expect(byNameMap[name].fired, name).toBe(1);
    // Inventoried, never dispatched in these three rows: a MEASURED zero, which
    // is the whole point of the carrier existing. It is a real number, not null.
    expect(byNameMap['swarm-download'].fired).toBe(0);
    expect(byNameMap['session-digest'].fired).toBe(0);

    for (const entry of block.entries) {
      expect(entry.measured, entry.name).toBe(true);
      expect(entry.reason, entry.name).toBeNull();
      expect(entry.denominator, entry.name).toBe(3);
      expect(typeof entry.fired, entry.name).toBe('number');
      // Measured or not, Observe still does not judge.
      expect(entry.candidate, entry.name).toBe(false);
      expect(entry.consumers, entry.name).toBe(CONSUMERS_UNMEASURED);
    }
    // Summary agrees with the per-entry verdicts, so a reader cannot get a
    // different answer depending on which level they read.
    expect(audit.summary.entries).toBe(inventory.length);
    expect(audit.summary.measured).toBe(inventory.length);
    expect(audit.summary.unmeasured).toBe(0);
    expect(audit.summary.eventsReceived).toBe(3);
    // The 14 names that appear in the rows fired; the rest are measured zeros.
    expect(block.entries.filter((e) => e.fired > 0)).toHaveLength(14);
  });

  it('a prototype key in the inventory reports a number, never a function', () => {
    // Hygiene (c) of the Wave 11 bundle brief, absorbed 2026-09-17. `counts` is
    // a plain object, so a bare `counts[name]` for these names reaches
    // Object.prototype and hands back a FUNCTION, which `?? 0` would keep. An
    // entry reporting a function where a count belongs corrupts every rollup
    // downstream, and for `__proto__` a plain assignment would have thrown the
    // real count away entirely.
    const PROTO_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
    const rows = [line('hook.fired', { slot: 'Stop', hooks: ['stop-recap'], count: 1 })];
    const audit = buildExistenceAudit(rows, { inventory: { hooks: PROTO_KEYS } });
    for (const entry of audit.kinds.hooks.entries) {
      expect(typeof entry.fired, entry.name).toBe('number');
      expect(entry.fired, entry.name).toBe(0);
      expect(entry.measured, entry.name).toBe(true);
    }

    // ...and when a row DOES name one, it is counted like any other string.
    const named = [
      line('hook.fired', { slot: 'Stop', hooks: ['constructor', '__proto__'], count: 2 }),
    ];
    const fold = foldFiredCounts(named, CARRIERS.hooks);
    expect(Object.hasOwn(fold.counts, 'constructor')).toBe(true);
    expect(Object.hasOwn(fold.counts, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(fold.counts)).toBe(Object.prototype);
    const counted = buildExistenceAudit(named, {
      inventory: { hooks: ['constructor', '__proto__', 'toString'] },
    });
    const map = Object.fromEntries(counted.kinds.hooks.entries.map((e) => [e.name, e.fired]));
    expect(map.constructor).toBe(1);
    expect(map.__proto__).toBe(1);
    expect(map.toString).toBe(0);
  });
});

describe('exempt entries are counted, not skipped', () => {
  it('an exempt name is measured-as-unmeasured and never a candidate', () => {
    const audit = buildExistenceAudit([], {
      inventory: { hooks: ['ambiguity-guard', 'dispatch-table'] },
    });
    for (const entry of audit.kinds.hooks.entries) {
      expect(entry.exempt).toBe(true);
      expect(entry.exemptContract).toBe(entry.name);
      expect(entry.fired).toBeNull();
      expect(entry.candidate).toBe(false);
      expect(entry.candidateReason).toBe(CANDIDATE_BLOCKED_REASON);
    }
    expect(audit.summary.exempt).toBe(2);
  });

  it('an exemption may be declared only by naming a contract on the list', () => {
    expect(resolveExemption('scripts/hooks/pre-tool-use.js', 'PreToolUse 보안 훅'))
      .toBe('PreToolUse 보안 훅');
    expect(resolveExemption('some-hook', undefined)).toBeNull();
  });

  it('a declared exemption outside the allowlist throws', () => {
    expect(() => resolveExemption('x', 'because I said so')).toThrow(/allowlist/);
    expect(() => buildExistenceAudit([], {
      inventory: { skills: [{ name: 'x', exemptAs: 'not-a-contract' }] },
    })).toThrow(/CLAUDE\.md:88/);
  });

  it('candidate is false on every entry, exempt or not', () => {
    const audit = buildExistenceAudit([], {
      inventory: { hooks: ['격리', 'ordinary-hook'], commands: ['doctor'] },
    });
    const all = AUDITED_KINDS.flatMap((k) => audit.kinds[k].entries);
    expect(all).toHaveLength(3);
    expect(all.every((e) => e.candidate === false)).toBe(true);
  });
});

describe('the exempt list agrees with CLAUDE.md:88 (drift gate)', () => {
  /**
   * Parse the 면제 sentence into its items.
   *
   * @returns {string[]} contract names, backticks stripped, in document order.
   */
  function parseExemptSentence() {
    const text = readFileSync(CLAUDE_MD_PATH, 'utf-8').split('\n')[EXEMPT_LINE_NO - 1];
    const match = text.match(/^\*\*면제[^:]*:\s*(.+?)\.\s*정본 목록은/);
    expect(match, `CLAUDE.md:${EXEMPT_LINE_NO} no longer looks like the 면제 sentence`)
      .not.toBeNull();
    return match[1].split(' · ').map((s) => s.replace(/`/g, '').trim());
  }

  it('the line still exists and still parses (fail-closed denominator)', () => {
    const parsed = parseExemptSentence();
    expect(parsed.length).toBeGreaterThan(0);
  });

  it('same count and same items in the same order', () => {
    expect(parseExemptSentence()).toEqual([...EXEMPT_CONTRACTS]);
  });

  it('the constant is frozen and free of duplicates', () => {
    expect(Object.isFrozen(EXEMPT_CONTRACTS)).toBe(true);
    expect(new Set(EXEMPT_CONTRACTS).size).toBe(EXEMPT_CONTRACTS.length);
  });
});

describe('determinism and inventory hygiene', () => {
  const inventory = { hooks: ['zeta', 'alpha', 'mike'], commands: ['b', 'a'] };

  it('two calls on the same input are identical', () => {
    const a = buildExistenceAudit([], { inventory });
    const b = buildExistenceAudit([], { inventory });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('inventory order does not change the output', () => {
    const forward = buildExistenceAudit([], { inventory });
    const reversed = buildExistenceAudit([], {
      inventory: { hooks: ['mike', 'alpha', 'zeta'], commands: ['a', 'b'] },
    });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.kinds.hooks.entries.map((e) => e.name)).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('an absent kind and an empty kind are different answers', () => {
    const audit = buildExistenceAudit([], { inventory: { hooks: [] } });
    expect(audit.kinds.hooks.enumerated).toBe(true);
    expect(audit.kinds.hooks.entries).toEqual([]);
    expect(audit.kinds.commands.enumerated).toBe(false);
    expect(audit.kinds.commands.entries).toEqual([]);
  });

  it('a duplicate name is refused rather than merged', () => {
    expect(() => buildExistenceAudit([], { inventory: { skills: ['dup', 'dup'] } }))
      .toThrow(/twice/);
  });

  it('a missing inventory throws instead of auditing nothing', () => {
    expect(() => buildExistenceAudit([], {})).toThrow(/inventory/);
    expect(() => buildExistenceAudit([], undefined)).toThrow(/inventory/);
    expect(() => buildExistenceAudit([], { inventory: [] })).toThrow(/inventory/);
  });

  it('a malformed inventory item throws', () => {
    expect(() => buildExistenceAudit([], { inventory: { hooks: 'a' } })).toThrow(/must be an array/);
    expect(() => buildExistenceAudit([], { inventory: { hooks: [''] } })).toThrow(/non-empty name/);
    expect(() => buildExistenceAudit([], { inventory: { hooks: [{}] } })).toThrow(/non-empty name/);
  });

  it('measured plus unmeasured partitions the entries; exempt overlaps', () => {
    const audit = buildExistenceAudit([], {
      inventory: { hooks: ['격리', 'plain'], modules: ['lib/replay/replay.js'] },
    });
    const { entries, measured, unmeasured, exempt } = audit.summary;
    expect(entries).toBe(3);
    expect(measured + unmeasured).toBe(entries);
    expect(measured).toBe(0);
    expect(exempt).toBe(1);
  });
});

describe('the module stays pure (source scan)', () => {
  const source = readFileSync(MODULE_PATH, 'utf-8');

  it('the scan actually read a file (fail-closed denominator)', () => {
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain('buildExistenceAudit');
  });

  it('imports no filesystem module', () => {
    expect(source).not.toMatch(/from\s+['"]node:fs['"]/);
    expect(source).not.toMatch(/require\(['"]fs['"]\)/);
  });

  it('reads no clock and no randomness', () => {
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/\bMath\.random\b/);
    expect(source).not.toMatch(/\bperformance\.now\b/);
  });

  it('does not read the process working directory or environment', () => {
    expect(source).not.toMatch(/\bprocess\.cwd\b/);
    expect(source).not.toMatch(/\bprocess\.env\b/);
  });

  it('imports only its sibling read model', () => {
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports).toEqual(['./replay.js']);
  });
});
