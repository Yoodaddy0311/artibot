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
 *   1. A KIND WITH NO CARRIER REPORTS null, NOT 0. No registered event carries
 *      a hook/command/skill/module name (measured 2026-09-02 across all 36
 *      events in `schemas/ledger-events.allowlist.json`), so today every entry
 *      is unmeasured. `fired: 0` there would be a number nobody measured.
 *   2. A CARRIER WITH AN EMPTY LEDGER IS ALSO null, and carries a DIFFERENT
 *      reason string than case 1. "The field does not exist" and "the field
 *      exists and saw nothing" are different facts about the world.
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
 *   - NO LIVE LEDGER. `.artibot/runtime/ledger.jsonl` does not exist in this
 *     repository (measured 2026-09-02). Every fixture below is hand-built and
 *     tiny; passing here says the arithmetic is right, not that it survives
 *     real traffic, real volume, or a real inventory. The survivors case does
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
  it('every kind has a null carrier today, which is the finding', () => {
    // If someone adds a carrier, this fails on purpose: the module header states
    // the measurement, and a new carrier makes that statement stale.
    for (const kind of AUDITED_KINDS) {
      expect(CARRIERS[kind], `${kind} carrier`).toBeNull();
      expect(CARRIER_NOTES[kind]).toEqual(expect.any(String));
    }
  });

  it('fired is null and the reason names the kind', () => {
    const audit = buildExistenceAudit([], { inventory: { hooks: ['runtime-prompt'] } });
    const [entry] = audit.kinds.hooks.entries;
    expect(entry.fired).toBeNull();
    expect(entry.fired).not.toBe(0);
    expect(entry.measured).toBe(false);
    expect(entry.reason).toBe('unmeasured:no-event-carries-hook');
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
