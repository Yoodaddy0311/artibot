/**
 * Unit contract for `scripts/bench/routebench-corpus.mjs` — the scrub, and the
 * four corpora it has already written.
 *
 * WHY THIS FILE EXISTS
 *
 *   1. `scripts/hooks/stop-review-gate.js#checkMissingTests` flags a changed
 *      source file with no `tests/**\/<stem>.test.*` sibling, so the extractor
 *      needs a file at exactly this path or every edit to it trips Stop.
 *   2. The scrub is the only thing standing between a person's run ledger and
 *      four tracked files. Its failure mode is silent in both directions: drop
 *      too much and the corpus stops discriminating anything, drop too little
 *      and session ids land in git history where deleting them later does not
 *      unpublish them. Neither shows up as a crash.
 *
 * THE POST-CONDITION IS ASSERTED ON THE SHIPPED BYTES, NOT ONLY ON A SYNTHETIC
 * ROW. A scrub that is correct on a hand-written event and wrong on the ledger
 * shape it actually met would pass a purely synthetic suite. So the four files
 * under `tests/evals/fixtures/routebench/corpus/` are read and re-checked here.
 *
 * WHAT A GREEN RUN HERE DOES NOT MEAN — read before quoting it
 *
 *   - **Not that the corpora are anonymous.** The post-condition is a
 *     structural one: named keys absent, no hex run longer than the 8-character
 *     hashes, ASCII only, no filesystem path. Anyone holding the original
 *     ledger can still re-derive which session a row came from by hashing their
 *     own ids. "Safe to track in this repository" is the claim; "safe to
 *     publish" is not, and no test here would distinguish them.
 *   - **Not that the row counts mean anything.** 21/80/45/6 is what one
 *     repository happened to run over four days. Nothing here samples,
 *     stratifies, or checks that a count is large enough to support a
 *     conclusion. The doc-updater corpus is 6 rows.
 *   - **Not that the extractor read the ledger correctly.** No test here opens
 *     a real ledger; `readLedgerCensus` is never called. The agent-name
 *     derivation is checked against the KEY FORMAT documented in
 *     `scripts/hooks/route-observe-pre.js#receiptKey`, not against live data,
 *     so a change to how that hook mints keys would break extraction while
 *     leaving this file green.
 *   - **Nothing about scoring.** This file scores no baseline and imports no
 *     resolver. Whether `scripts/bench/routebench.mjs` accepts these corpora is
 *     that runner's own suite's question.
 *
 * @module tests/bench/routebench-corpus
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import {
  agentFromKey,
  CORPUS_SCHEMA,
  dayOf,
  DEFAULT_OUT_DIR,
  DROPPED_FIELDS,
  extractCorpus,
  FORBIDDEN_CORPUS_KEYS,
  hashId,
  MAX_REASON_LENGTH,
  parseArgs,
  postconditionViolations,
  PREDICTED_DECIMALS,
  RAW_HEX_RUN,
  resolvePairs,
  roundValue,
  scrubReason,
  scrubRow,
  serializeCorpus,
  summaryLine,
  tierOf,
} from '../../scripts/bench/routebench-corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** plugins/artibot/tests/bench -> plugins/artibot */
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

const EXTRACTOR_PATH = path.join(PLUGIN_ROOT, 'scripts', 'bench', 'routebench-corpus.mjs');
const RUNNER_PATH = path.join(PLUGIN_ROOT, 'scripts', 'bench', 'routebench.mjs');
const CORPUS_DIR = path.join(
  PLUGIN_ROOT, 'tests', 'evals', 'fixtures', 'routebench', 'corpus',
);

/** The four corpora this limb landed, with the agent each was extracted for. */
const SHIPPED = Object.freeze({
  'live-investigator-explore': 'investigator',
  'live-tdd-guide-implement': 'tdd-guide',
  'live-code-reviewer-review': 'code-reviewer',
  'live-doc-updater-edit-routine': 'doc-updater',
});

/**
 * One synthetic `route.selected` envelope carrying every field the scrub is
 * supposed to remove, plus recognisable values for the ones it keeps.
 *
 * Written by hand rather than copied from the ledger so the DROP side can be
 * asserted positively: each identifier below is a unique string that must not
 * appear in the output. A real event would have to be trusted to contain them.
 *
 * @returns {object}
 */
function syntheticEvent() {
  return {
    v: 1,
    ts: '2026-09-10T01:02:03.456Z',
    event: 'route.selected',
    session_id: 'sess-DROPME-1',
    source: 'route-observe-pre',
    pid: 4242,
    seq: 17,
    mission_id: 'miss-DROPME-2',
    routing_epoch_id: 'epoch-DROPME-3',
    action_id: 'act-DROPME-4',
    idempotency_key: 'route.pre:tu-DROPME-5:pr-DROPME-6:artibot:investigator',
    data: {
      schema_version: 'DROPME-7',
      route_receipt_id: 'rcpt-DROPME-8',
      mission_id: 'miss-DROPME-2',
      session_id: 'sess-DROPME-1',
      execution_profile_version: 'DROPME-9',
      timestamp: '2026-09-10T01:02:03.456Z',
      shadow_of: 'shadow-DROPME-10',
      routing_epoch_id: 'epoch-DROPME-3',
      action: {
        type: 'explore', phase: 'build', complexity: 0.1, uncertainty: 0, risk: 0,
      },
      models: {
        current: null,
        recommended: { provider: 'anthropic', family: 'DROPME-11', tier: 'opus', model_id: 'DROPME-12' },
        selected: { provider: 'anthropic', family: 'DROPME-13', tier: 'fable', model_id: 'DROPME-14' },
      },
      decision: { type: 'route' },
      predicted: {
        success: 0.76, cost: 0, latency: 8000, retry_probability: 0.19999999999999996,
      },
      transition: { from: 'DROPME-15' },
      terms: { raw: 'DROPME-16' },
      actionsSinceSwitch: 3,
      reason: ['class:agent', 'route:opus', 'policy:fable', 'divergence'],
      source: 'DROPME-17',
    },
  };
}

const LABELS = Object.freeze({ scenarioId: 'live-investigator-explore', agentType: 'investigator' });

// ---------------------------------------------------------------------------

describe('hashId() — truncated sha256 of a raw identifier', () => {
  it('returns exactly eight lowercase hex characters', () => {
    expect(hashId('sess-abc')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic across calls', () => {
    expect(hashId('sess-abc')).toBe(hashId('sess-abc'));
  });

  it('separates two different identifiers', () => {
    // Without this the whole `session`/`mission`/`epoch` triple could be a
    // constant and every other assertion here would still pass.
    expect(hashId('sess-abc')).not.toBe(hashId('sess-abd'));
  });

  it('never reproduces its own input', () => {
    expect(hashId('sess-abc')).not.toContain('sess');
  });

  it('returns null rather than hashing a missing id', () => {
    // Hashing `undefined` would mint one stable value shared by every row that
    // lacked the field, which reads as "these rows are related" — the exact
    // false signal the hash exists to carry truthfully.
    expect(hashId(undefined)).toBeNull();
    expect(hashId(null)).toBeNull();
    expect(hashId('')).toBeNull();
    expect(hashId(42)).toBeNull();
  });

  it('emits a hash short enough to clear the raw-hex-run rule', () => {
    expect(RAW_HEX_RUN.test(hashId('sess-abc'))).toBe(false);
  });
});

describe('agentFromKey() — agent class from the ENVELOPE idempotency key', () => {
  it('takes the fourth segment of a route.pre key', () => {
    expect(agentFromKey('route.pre:tu-1:pr-2:tdd-guide')).toBe('tdd-guide');
  });

  it('strips a leading artibot namespace so both spellings name one class', () => {
    expect(agentFromKey('route.pre:tu-1:pr-2:artibot:code-reviewer')).toBe('code-reviewer');
  });

  it('rejoins a subagent type that itself contains a colon', () => {
    // `slice(3).join(':')` rather than `parts[3]`: a naive index would silently
    // truncate `vendor:agent` to `vendor` and merge two classes into one.
    expect(agentFromKey('route.pre:tu-1:pr-2:vendor:agent')).toBe('vendor:agent');
  });

  it('returns null for a key with too few segments to carry a type', () => {
    expect(agentFromKey('route.pre:tu-1:pr-2')).toBeNull();
    expect(agentFromKey('route.pre')).toBeNull();
  });

  it('returns null for a trailing-colon key rather than an empty agent name', () => {
    expect(agentFromKey('route.pre:tu-1:pr-2:')).toBeNull();
  });

  it('returns null for a non-string key', () => {
    expect(agentFromKey(undefined)).toBeNull();
    expect(agentFromKey(null)).toBeNull();
    expect(agentFromKey(7)).toBeNull();
  });
});

describe('roundValue() — float noise is a scrub step, not cosmetics', () => {
  it('collapses IEEE-754 noise that would read as a long hex run', () => {
    // 0.19999999999999996 is a 17-digit run; digits are hex characters, so the
    // literal is indistinguishable from a leaked id to any text-level scan.
    expect(RAW_HEX_RUN.test('0.19999999999999996')).toBe(true);
    expect(roundValue(0.19999999999999996)).toBe(0.2);
    expect(RAW_HEX_RUN.test(String(roundValue(0.19999999999999996)))).toBe(false);
  });

  it('keeps a repeating value to the declared precision', () => {
    expect(roundValue(0.33333333333333326)).toBe(0.333333);
    expect(PREDICTED_DECIMALS).toBe(6);
  });

  it('leaves an already-short value untouched', () => {
    expect(roundValue(0.76)).toBe(0.76);
    expect(roundValue(0)).toBe(0);
    expect(roundValue(8000)).toBe(8000);
  });

  it('returns null for anything that is not a finite number', () => {
    expect(roundValue(Number.NaN)).toBeNull();
    expect(roundValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(roundValue('0.5')).toBeNull();
    expect(roundValue(undefined)).toBeNull();
  });
});

describe('dayOf() — the truncation that makes the output clock-free', () => {
  it('keeps the calendar day and drops the time', () => {
    expect(dayOf('2026-09-10T01:02:03.456Z')).toBe('2026-09-10');
  });

  it('does not reformat, so two extractions agree byte for byte', () => {
    const once = dayOf('2026-09-10T01:02:03.456Z');
    const twice = dayOf('2026-09-10T01:02:03.456Z');
    expect(once).toBe(twice);
    expect(once).toHaveLength(10);
  });

  it('returns null for a timestamp that is not ISO-shaped', () => {
    expect(dayOf('10/09/2026')).toBeNull();
    expect(dayOf(1757462523456)).toBeNull();
    expect(dayOf(undefined)).toBeNull();
  });
});

describe('scrubReason() — an allowlist of short tags', () => {
  it('keeps every short tag and reports no drops', () => {
    const out = scrubReason(['class:agent', 'policy:fable']);
    expect(out).toEqual({ reason: ['class:agent', 'policy:fable'], dropped: 0 });
  });

  it('drops an entry carrying a hex run and counts it', () => {
    const out = scrubReason(['class:agent', 'trace:deadbeef123']);
    expect(out.reason).toEqual(['class:agent']);
    expect(out.dropped).toBe(1);
  });

  it('drops an over-long entry, which has not been reviewed for what it embeds', () => {
    const out = scrubReason(['x'.repeat(MAX_REASON_LENGTH + 1)]);
    expect(out.reason).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  it('keeps an entry of exactly the maximum length (boundary is inclusive)', () => {
    const out = scrubReason(['x'.repeat(MAX_REASON_LENGTH)]);
    expect(out.reason).toHaveLength(1);
    expect(out.dropped).toBe(0);
  });

  it('drops a non-string entry rather than serializing it', () => {
    const out = scrubReason(['class:agent', { nested: 'object' }, 42, null]);
    expect(out.reason).toEqual(['class:agent']);
    expect(out.dropped).toBe(3);
  });

  it('returns an empty result for a missing or non-array reason', () => {
    expect(scrubReason(undefined)).toEqual({ reason: [], dropped: 0 });
    expect(scrubReason('class:agent')).toEqual({ reason: [], dropped: 0 });
  });
});

describe('tierOf() — the comparable half of a models slot', () => {
  it('keeps the tier and nothing else', () => {
    expect(tierOf({ provider: 'anthropic', tier: 'opus', model_id: 'x' })).toEqual({ tier: 'opus' });
  });

  it('returns null for an absent slot', () => {
    // `models.current` was null on every event measured 2026-09-14, which is
    // why the documented row shape shows null there.
    expect(tierOf(null)).toBeNull();
    expect(tierOf(undefined)).toBeNull();
  });

  it('reports a slot that exists without a tier as a null tier, not an absent slot', () => {
    expect(tierOf({ provider: 'anthropic' })).toEqual({ tier: null });
  });
});

describe('scrubRow() — every dropped field is actually gone', () => {
  const { row, droppedReasons } = scrubRow(syntheticEvent(), LABELS);
  const text = JSON.stringify(row);

  it('carries the schema tag and the two labels', () => {
    expect(row.schema).toBe(CORPUS_SCHEMA);
    expect(row.scenario_id).toBe('live-investigator-explore');
    expect(row.agentType).toBe('investigator');
  });

  it('leaves no trace of any identifier the source event carried', () => {
    // Every dropped value in the synthetic event is spelled DROPME-<n>, so one
    // assertion covers all seventeen and a newly-kept field cannot slip past by
    // being unlisted here.
    expect(text).not.toContain('DROPME');
  });

  it('spells no forbidden key anywhere in the row', () => {
    for (const key of FORBIDDEN_CORPUS_KEYS) {
      expect(text, key).not.toContain(`"${key}"`);
    }
  });

  it('replaces the three ids with 8-character hashes', () => {
    expect(row.session).toMatch(/^[0-9a-f]{8}$/);
    expect(row.mission).toMatch(/^[0-9a-f]{8}$/);
    expect(row.epoch).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set([row.session, row.mission, row.epoch]).size).toBe(3);
  });

  it('keeps the routing decision the benchmark exists to compare', () => {
    expect(row.action).toEqual({
      type: 'explore', phase: 'build', complexity: 0.1, uncertainty: 0, risk: 0,
    });
    expect(row.models).toEqual({
      recommended: { tier: 'opus' }, selected: { tier: 'fable' }, current: null,
    });
    expect(row.decision).toEqual({ type: 'route' });
    expect(row.reason).toEqual(['class:agent', 'route:opus', 'policy:fable', 'divergence']);
    expect(droppedReasons).toBe(0);
  });

  it('rounds the predicted block so no float artifact survives', () => {
    expect(row.predicted).toEqual({
      success: 0.76, cost: 0, latency: 8000, retry_probability: 0.2,
    });
  });

  it('keeps only the day of the timestamp', () => {
    expect(row.ts_day).toBe('2026-09-10');
  });

  it('ignores a field the ledger grows later (allowlist by construction)', () => {
    // The scrub builds a fresh literal instead of spreading the event, so a new
    // field is dropped without anyone editing a denylist. This is the property
    // that makes the design fail-CLOSED, and it is worth a direct test.
    const event = syntheticEvent();
    event.data.some_future_field = 'DROPME-FUTURE';
    event.some_future_envelope_field = 'DROPME-FUTURE-2';
    expect(JSON.stringify(scrubRow(event, LABELS).row)).not.toContain('DROPME');
  });

  it('produces the same bytes twice for the same event', () => {
    expect(JSON.stringify(scrubRow(syntheticEvent(), LABELS).row)).toBe(text);
  });

  it('survives an event missing data entirely, with nulls rather than a throw', () => {
    const row2 = scrubRow({ event: 'route.selected' }, LABELS).row;
    expect(row2.ts_day).toBeNull();
    expect(row2.session).toBeNull();
    expect(row2.models).toEqual({ recommended: null, selected: null, current: null });
    expect(row2.reason).toEqual([]);
  });
});

describe('DROPPED_FIELDS — the drop list is documentation, and it is honest', () => {
  it('names a reason for every listed field', () => {
    for (const [field, why] of Object.entries(DROPPED_FIELDS)) {
      expect(typeof why, field).toBe('string');
      expect(why.length, field).toBeGreaterThan(10);
    }
  });

  it('is frozen so it cannot be edited at runtime', () => {
    expect(Object.isFrozen(DROPPED_FIELDS)).toBe(true);
  });

  it('actually drops every non-wildcard field it claims to drop', () => {
    // A drop list that had drifted from the code would be worse than none:
    // a reviewer would cite it. Wildcard entries (`models.*.model_id`) are
    // covered by the DROPME assertions above, so only concrete paths are
    // walked here.
    const { row } = scrubRow(syntheticEvent(), LABELS);
    const text = JSON.stringify(row);
    for (const field of Object.keys(DROPPED_FIELDS)) {
      if (field.includes('*')) continue;
      const leaf = field.split('.').pop();
      expect(text, field).not.toContain(`"${leaf}":`);
    }
  });
});

describe('postconditionViolations() — the gate, and controls proving it discriminates', () => {
  const clean = JSON.stringify(scrubRow(syntheticEvent(), LABELS).row);

  it('passes a scrubbed row', () => {
    expect(postconditionViolations(clean)).toEqual([]);
  });

  it('catches a raw hex run', () => {
    expect(postconditionViolations('{"x":"deadbeef123"}')).toContain('raw-hex-run:deadbeef123');
  });

  it('catches every forbidden key by name', () => {
    for (const key of FORBIDDEN_CORPUS_KEYS) {
      expect(postconditionViolations(`{"${key}":1}`), key).toContain(`forbidden-key:${key}`);
    }
  });

  it('catches a Windows and a POSIX filesystem path', () => {
    expect(postconditionViolations('{"p":"C:\\\\Users"}')).toContainEqual(
      expect.stringContaining('forbidden-substring'),
    );
    expect(postconditionViolations('{"p":"/Users/someone"}')).toContainEqual(
      expect.stringContaining('forbidden-substring'),
    );
  });

  it('catches non-ASCII, which the shipped corpora must not contain', () => {
    expect(postconditionViolations('{"t":"\uD55C\uAE00"}')).toContain('non-ascii');
  });

  it('catches a float artifact, which the parsed-value scan cannot see', () => {
    // This is the case that makes the text-level reading stricter than the
    // runner's `corpusViolations`: a bare number is not a string, so a walk of
    // the parsed value never tests it.
    expect(postconditionViolations('{"p":0.19999999999999996}')).toContainEqual(
      expect.stringContaining('raw-hex-run'),
    );
  });

  it('accepts an 8-character hash, so the rule is not just "no hex"', () => {
    expect(postconditionViolations('{"session":"c58ea3e3"}')).toEqual([]);
  });

  it('treats an empty input as clean rather than throwing', () => {
    expect(postconditionViolations('')).toEqual([]);
    expect(postconditionViolations(undefined)).toEqual([]);
  });

  it('catches every control byte except LF, so the gate is not "anything goes"', () => {
    // LF is the only control character a corpus may contain: the extractor
    // writes one per row and nothing else. Each of these is asserted on its own
    // so that widening the class later shows up here rather than silently.
    for (const code of [0x09, 0x00, 0x1b, 0x0b, 0x0c]) {
      const ch = String.fromCharCode(code);
      expect(postconditionViolations(`{"a":1}${ch}`), `0x${code.toString(16)}`)
        .toContain('non-ascii');
    }
    expect(postconditionViolations('{"a":1}\n')).toEqual([]);
  });

  it('REJECTS a CR, which is why the corpora carry -text in .gitattributes', () => {
    // This is a deliberate strictness, not an oversight, and it is the assertion
    // that failed on Windows CI on 2026-09-14: `actions/checkout` with
    // core.autocrlf=true rewrote the LF-only blobs to CRLF, and the gate fired
    // on bytes the blob never contained. The fix is at the checkout, not here -
    // `.gitattributes` marks the corpus glob `-text`, the same treatment the
    // repo already gives reports/SPLIT ndjson and the UserPromptSubmit fixture.
    //
    // Loosening this predicate to tolerate CR would have made CI green by
    // deleting the only check that can tell a mangled checkout from an intact
    // one, and the corpus is EVIDENCE: a re-extraction must compare byte for
    // byte against the tracked file. Note the runner's `corpusViolations`
    // legitimately tolerates CRLF - it splits on /\r?\n/ and asserts on parsed
    // values, a different contract from this byte-level post-condition.
    // A two-row corpus rendered the way an autocrlf checkout renders it. `clean`
    // is one line with no newline of its own, so the file body is built first
    // and only then re-rendered - replacing on `clean` alone would be a no-op
    // and the assertion would prove nothing.
    const body = `${clean}\n${clean}\n`;
    expect(postconditionViolations(body)).toEqual([]);
    expect(postconditionViolations(body.replace(/\n/g, '\r\n'))).toEqual(['non-ascii']);
    expect(postconditionViolations(`${clean}\r\n`)).toEqual(['non-ascii']);
  });
});

describe('extractCorpus() — filtering, ordering and the denominator', () => {
  const events = [
    { ...syntheticEvent(), idempotency_key: 'route.pre:a:b:investigator', ts: '2026-09-10T01:00:00Z' },
    { ...syntheticEvent(), idempotency_key: 'route.pre:a:b:tdd-guide', ts: '2026-09-11T01:00:00Z' },
    { ...syntheticEvent(), idempotency_key: 'route.pre:a:b:investigator', ts: '2026-09-12T01:00:00Z' },
    { ...syntheticEvent(), event: 'route.bound', idempotency_key: 'route.pre:a:b:investigator' },
    { ...syntheticEvent(), event: 'usage.receipt', idempotency_key: 'route.pre:a:b:investigator' },
  ];
  const spec = { agent: 'investigator', scenarioId: 'live-investigator-explore' };

  it('keeps only the requested agent', () => {
    expect(extractCorpus(events, spec).rows).toHaveLength(2);
  });

  it('reports the route.selected denominator across ALL agents, not the kept count', () => {
    // A row count quoted without its denominator says nothing about reach, and
    // a denominator that silently equalled the numerator would hide that.
    const out = extractCorpus(events, spec);
    expect(out.total).toBe(3);
    expect(out.rows.length).toBeLessThan(out.total);
  });

  it('never emits a route.bound row, whose data.agent_type names split windows', () => {
    const days = extractCorpus(events, spec).rows.map((row) => row.ts_day);
    expect(days).toEqual(['2026-09-10', '2026-09-12']);
  });

  it('preserves ledger order', () => {
    const days = extractCorpus(events, spec).rows.map((row) => row.ts_day);
    expect(days).toEqual([...days].sort());
  });

  it('labels every row with the requested scenario and agent', () => {
    for (const row of extractCorpus(events, spec).rows) {
      expect(row.scenario_id).toBe('live-investigator-explore');
      expect(row.agentType).toBe('investigator');
    }
  });

  it('returns an empty corpus for an agent that never appears', () => {
    const out = extractCorpus(events, { agent: 'nobody', scenarioId: 'x' });
    expect(out.rows).toEqual([]);
    expect(out.total).toBe(3);
  });

  it('tolerates a missing or empty event list', () => {
    expect(extractCorpus(undefined, spec)).toEqual({ rows: [], droppedReasons: 0, total: 0 });
    expect(extractCorpus([], spec).total).toBe(0);
  });
});

describe('serializeCorpus() — a caller cannot write an unscrubbed corpus', () => {
  it('emits one JSON object per line with a trailing newline', () => {
    const { rows } = extractCorpus(
      [syntheticEvent()], { agent: 'investigator', scenarioId: 'live-investigator-explore' },
    );
    const text = serializeCorpus(rows);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(() => JSON.parse(text.trim())).not.toThrow();
  });

  it('is byte-identical across two runs over the same events', () => {
    const spec = { agent: 'investigator', scenarioId: 'live-investigator-explore' };
    const first = serializeCorpus(extractCorpus([syntheticEvent()], spec).rows);
    const second = serializeCorpus(extractCorpus([syntheticEvent()], spec).rows);
    expect(first).toBe(second);
  });

  it('throws rather than returning text that fails the post-condition', () => {
    // The caller writes whatever it gets back, so a returned-violations design
    // would be a scrub anyone could bypass by ignoring a value.
    expect(() => serializeCorpus([{ session_id: 'raw' }]))
      .toThrow(/post-condition failed.*forbidden-key:session_id/);
  });

  it('emits an empty string for no rows, with no stray newline', () => {
    expect(serializeCorpus([])).toBe('');
  });
});

describe('resolvePairs() / parseArgs() — ambiguity is refused, not guessed', () => {
  it('reads a repeatable agent=id map', () => {
    expect(resolvePairs({ agents: [], scenarioId: null, map: ['a=one', 'b=two'] }))
      .toEqual([{ agent: 'a', scenarioId: 'one' }, { agent: 'b', scenarioId: 'two' }]);
  });

  it('pairs a single --agent with --scenario-id', () => {
    expect(resolvePairs({ agents: ['a'], scenarioId: 'one', map: [] }))
      .toEqual([{ agent: 'a', scenarioId: 'one' }]);
  });

  it('refuses several agents with one scenario id instead of fanning it out', () => {
    expect(() => resolvePairs({ agents: ['a', 'b'], scenarioId: 'one', map: [] }))
      .toThrow(/use --map/);
  });

  it('refuses an agent with no scenario id', () => {
    expect(() => resolvePairs({ agents: ['a'], scenarioId: null, map: [] })).toThrow(/--map/);
  });

  it('refuses a malformed map entry rather than writing to a blank filename', () => {
    for (const bad of ['noequals', '=one', 'a=']) {
      expect(() => resolvePairs({ agents: [], scenarioId: null, map: [bad] }), bad)
        .toThrow(/--map expects/);
    }
  });

  it('refuses an empty request', () => {
    expect(() => resolvePairs({ agents: [], scenarioId: null, map: [] })).toThrow(/nothing to extract/);
  });

  it('parses flags, splits a comma agent list and defaults the out dir', () => {
    const opts = parseArgs(['--project-root', '/root', '--map', 'a=one', '--dry-run']);
    expect(opts.projectRoot).toBe('/root');
    expect(opts.dryRun).toBe(true);
    expect(opts.outDir).toBe(DEFAULT_OUT_DIR);
    expect(DEFAULT_OUT_DIR.endsWith(path.join('routebench', 'corpus'))).toBe(true);
  });

  it('splits a comma agent list, and so refuses a two-agent list with one id', () => {
    // `--agent a,b` really does become two agents rather than one oddly named
    // one; the refusal below is the observable proof, since a single agent
    // called "a,b" plus --scenario-id would have been accepted.
    expect(parseArgs(['--agent', 'a', '--scenario-id', 'one', '--map', 'b=two']).pairs)
      .toEqual([{ agent: 'b', scenarioId: 'two' }, { agent: 'a', scenarioId: 'one' }]);
    expect(() => parseArgs(['--agent', 'a,b', '--scenario-id', 'one'])).toThrow(/use --map/);
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    // A silently ignored `--out-dur` typo would write the corpus somewhere
    // nobody looks and print a summary saying it succeeded.
    expect(() => parseArgs(['--out-dur', '/x', '--map', 'a=one'])).toThrow(/unknown flag/);
  });

  it('rejects a value-taking flag given last with no value', () => {
    expect(() => parseArgs(['--map'])).toThrow(/needs a value/);
  });
});

describe('summaryLine() — a count never travels without its denominator', () => {
  it('prints rows, the route.selected total, drops and the measurement time', () => {
    expect(summaryLine({
      agent: 'investigator',
      scenarioId: 'live-investigator-explore',
      rows: 21,
      total: 185,
      droppedReasons: 0,
      measuredAt: '2026-09-14T06:15:53.430Z',
    })).toBe(
      'agent=investigator scenario=live-investigator-explore rows=21'
      + ' of route.selected N=185 reason_entries_dropped=0'
      + ' measured_at=2026-09-14T06:15:53.430Z',
    );
  });
});

describe('FORBIDDEN_CORPUS_KEYS — two independent spellings that must agree', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(FORBIDDEN_CORPUS_KEYS)).toBe(true);
  });

  it('matches the runner gate character for character', async () => {
    // The extractor and `scripts/bench/routebench.mjs` are owned by different
    // limbs and deliberately do not import from each other: the runner must be
    // able to refuse a corpus written by an extractor it never saw, which an
    // import would turn into a tautology. That makes drift possible, so the
    // agreement is asserted here rather than assumed.
    const runner = await import('../../scripts/bench/routebench.mjs');
    expect([...runner.FORBIDDEN_CORPUS_KEYS]).toEqual([...FORBIDDEN_CORPUS_KEYS]);
  });
});

describe('the four shipped corpora', () => {
  it('exists on disk for every declared scenario id', () => {
    for (const id of Object.keys(SHIPPED)) {
      expect(existsSync(path.join(CORPUS_DIR, `${id}.jsonl`)), id).toBe(true);
    }
  });

  it('passes the post-condition on its actual committed bytes', async () => {
    // The claim that matters. A scrub correct on a synthetic event and wrong on
    // the shape the ledger really had would pass every test above this one.
    for (const id of Object.keys(SHIPPED)) {
       
      const text = await readFile(path.join(CORPUS_DIR, `${id}.jsonl`), 'utf-8');
      expect(postconditionViolations(text), id).toEqual([]);
    }
  });

  it('holds at least one parseable row per file, every row an object', async () => {
    for (const id of Object.keys(SHIPPED)) {
       
      const text = await readFile(path.join(CORPUS_DIR, `${id}.jsonl`), 'utf-8');
      const rows = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      expect(rows.length, id).toBeGreaterThan(0);
      for (const row of rows) expect(typeof row, id).toBe('object');
    }
  });

  it('labels every row with its own scenario id, agent and schema tag', async () => {
    for (const [id, agent] of Object.entries(SHIPPED)) {
       
      const text = await readFile(path.join(CORPUS_DIR, `${id}.jsonl`), 'utf-8');
      const rows = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      expect([...new Set(rows.map((r) => r.scenario_id))], id).toEqual([id]);
      expect([...new Set(rows.map((r) => r.agentType))], id).toEqual([agent]);
      expect([...new Set(rows.map((r) => r.schema))], id).toEqual([CORPUS_SCHEMA]);
    }
  });

  it('carries no outcome field, which is why B6 still refuses', async () => {
    for (const id of Object.keys(SHIPPED)) {
       
      const text = await readFile(path.join(CORPUS_DIR, `${id}.jsonl`), 'utf-8');
      expect(text, id).not.toContain('"outcome"');
    }
  });

  it('shows the investigator corpus diverging and the other three agreeing', async () => {
    // The reason four scenarios were extracted rather than one. If every class
    // agreed, B2/B3/B4 would be indistinguishable on this corpus and adding it
    // would have bought nothing — so the divergence is asserted, not assumed.
    const tiers = {};
    for (const id of Object.keys(SHIPPED)) {
       
      const text = await readFile(path.join(CORPUS_DIR, `${id}.jsonl`), 'utf-8');
      const rows = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      tiers[id] = [...new Set(rows.map(
        (r) => `${r.models.recommended.tier}->${r.models.selected.tier}`,
      ))];
    }
    expect(tiers['live-investigator-explore']).toEqual(['opus->fable']);
    expect(tiers['live-tdd-guide-implement']).toEqual(['opus->opus']);
    expect(tiers['live-code-reviewer-review']).toEqual(['fable->fable']);
    expect(tiers['live-doc-updater-edit-routine']).toEqual(['opus->opus']);
  });
});

describe('extractor source hygiene', () => {
  /** Assembled at runtime so this file cannot be mistaken for a violator. */
  const NETWORK_TOKENS = [
    `node:${'http'}`, `node:${'https'}`, `node:${'net'}`, `node:${'dns'}`, `node:${'tls'}`,
    `node:${'child_process'}`, 'undici', `node-${'fetch'}`, 'axios', `${'fetch'}(`,
    `XML${'HttpRequest'}`, `Web${'Socket'}`,
  ];

  it('reads the ledger only through readLedgerCensus, never its own file reader', async () => {
    // A hand-rolled JSONL reader would have to know the on-disk format and
    // would drift from `lib/runtime/ledger.js` the first time it changed —
    // silently, since a corpus with fewer rows still looks like a corpus.
    const src = await readFile(EXTRACTOR_PATH, 'utf-8');
    expect(src).not.toContain(`read${'FileSync'}`);
    expect(src).toContain('readLedgerCensus');
  });

  it('names no network module or client', async () => {
    const src = await readFile(EXTRACTOR_PATH, 'utf-8');
    for (const token of NETWORK_TOKENS) expect(src, token).not.toContain(token);
  });

  it('is ASCII only', async () => {
    const src = await readFile(EXTRACTOR_PATH, 'utf-8');
    const offenders = [...src].filter((ch) => ch.charCodeAt(0) > 126);
    expect(offenders).toEqual([]);
  });

  it('calls main() from exactly one site, behind the isMainEntry guard', async () => {
    const src = await readFile(EXTRACTOR_PATH, 'utf-8');
    const calls = [...src.matchAll(/(?<!function\s)(?<![\w.$])main\(\)/g)];
    expect(calls).toHaveLength(1);
    const guardAt = src.indexOf('if (isMainEntry(import.meta.url))');
    expect(guardAt).toBeGreaterThan(-1);
    expect(calls[0].index).toBeGreaterThan(guardAt);
  });

  it('leaves process.exitCode unset on import', () => {
    expect(process.exitCode).toBeUndefined();
  });

  it('sits next to the runner it feeds, which it does not import', async () => {
    expect(existsSync(RUNNER_PATH)).toBe(true);
    const src = await readFile(EXTRACTOR_PATH, 'utf-8');
    expect(src).not.toContain(`./${'routebench'}.mjs`);
  });
});
