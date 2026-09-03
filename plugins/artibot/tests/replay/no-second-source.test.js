/**
 * Firewall: `lib/replay/` is a read model, and stays one.
 *
 * Three properties are load-bearing and none of them is visible in ordinary
 * unit tests, because each is about what the code DOESN'T do:
 *
 *  1. NOTHING IN THE DIRECTORY WRITES. Design §8.3-2 conceded the author's
 *     independent Replay Store and made Replay "원장의 읽기 모델(재생성 가능
 *     인덱스). 정본은 ledger.jsonl 하나" (ARTIBOT-5.0-DESIGN.md §8.3-2). A
 *     projection with a persistence API acquires a home and becomes the second
 *     source of truth that ruling excluded. A behavioural test cannot show the
 *     absence of a file write, so this one reads the source.
 *  2. NOTHING IN THE DIRECTORY IMPORTS L5. `lib/replay` is L2; the ledger is
 *     L5. eslint's L2 block already forbids it, but eslint is a separate run
 *     that a `--no-eslint` shortcut or a disable comment can bypass, so the
 *     property is asserted here too.
 *  3. THE TWO RESTATED CONTRACTS AGREE WITH THEIR ORIGINALS. `dedupeKey` and
 *     `REQUIRED_ENVELOPE_KEYS` are copies — of `ledger.js#dedupeEvents`'s key
 *     and of `schemas/ledger-envelope.schema.json#/required` — made necessary
 *     by the layer rule and by purity. A copy nobody compares is a copy that
 *     drifts.
 *
 * ── WHAT THIS GATE CANNOT SEE (repo rules §9-§10) ───────────────────────────
 *   - IT IS A TEXT SCAN, NOT A TAINT ANALYSIS. A write reached indirectly —
 *     through a caller-supplied callback, `globalThis`, or a string fed to a
 *     dynamic import — passes. It closes the accidental path, not a determined
 *     one.
 *   - IT DOES NOT PROVE ESLINT RUNS. It reads source text. That the L2 layer
 *     rule is actually applied is `npm run lint`'s business, and that the
 *     directory is REGISTERED at all is
 *     `tests/firewall/layer-registration-coverage.test.js`'s.
 *   - THE ENVELOPE COMPARISON IS PRESENCE-ONLY. It checks that the local key
 *     list matches the schema's `required` array. It does not check that the
 *     local screening enforces each key's TYPE the way the schema's patterns
 *     do — and it deliberately cannot, because the module screens primitives
 *     while the schema constrains formats.
 *
 * @module tests/replay/no-second-source
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeEvents } from '../../lib/runtime/ledger.js';
import { dedupeKey, REQUIRED_ENVELOPE_KEYS } from '../../lib/replay/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const REPLAY_DIR = join(PLUGIN_ROOT, 'lib', 'replay');

/** Lower bound so an empty scan cannot pass as "no violations". */
const MIN_SOURCE_FILES = 3;

/**
 * Every `.js` file directly under `lib/replay/`, as `[name, source]`.
 *
 * @returns {Array<[string, string]>} file name and its text.
 */
function replaySources() {
  return readdirSync(REPLAY_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => [name, readFileSync(join(REPLAY_DIR, name), 'utf-8')]);
}

/**
 * Match `re` against each source file, reporting `file:line`.
 *
 * @param {RegExp} re - global-flagged pattern.
 * @returns {string[]} human-readable hits.
 */
function scan(re) {
  const hits = [];
  for (const [name, text] of replaySources()) {
    text.split('\n').forEach((lineText, i) => {
      if (new RegExp(re.source).test(lineText)) hits.push(`${name}:${i + 1}: ${lineText.trim()}`);
    });
  }
  return hits;
}

describe('lib/replay writes nothing (design §8.3-2)', () => {
  it('the scan actually found files (fail-closed denominator)', () => {
    // Zero violations over zero files is not a pass; it is a broken scan.
    const files = replaySources();
    expect(files.length).toBeGreaterThanOrEqual(MIN_SOURCE_FILES);
    expect(files.map(([name]) => name)).toContain('replay.js');
    expect(files.map(([name]) => name)).toContain('load.js');
    expect(files.map(([name]) => name)).toContain('index.js');
  });

  it('no filesystem write API appears anywhere in the directory', () => {
    expect(
      scan(/\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|createWriteStream|rmSync|renameSync)\b/g),
      'lib/replay must not write: the index is a regenerable projection, and a '
      + 'persisted projection becomes a second source of truth (design §8.3-2). '
      + 'serializeIndex returns a string; the CALLER decides where it goes.',
    ).toEqual([]);
  });

  it('no filesystem module is imported anywhere in the directory', () => {
    // Purity (design §1-8, L2): no filesystem at all, not even for reading.
    // Reading the ledger arrives as an injected port in load.js.
    expect(scan(/from\s+['"]node:fs['"]|require\(['"]fs['"]\)/g)).toEqual([]);
  });

  it('no clock or randomness (purity, design §1-8)', () => {
    expect(scan(/\bDate\.now\b|\bMath\.random\b|\bprocess\.cwd\b/g)).toEqual([]);
  });

  it('does not import the L5 runtime layer', () => {
    // `lib/replay` is L2; `lib/runtime` is L5. eslint's L2 block forbids this,
    // and so does this gate — a disable comment silences one, not both.
    expect(
      scan(/from\s+['"][^'"]*runtime\/[^'"]*['"]/g),
      'Layer violation: L2 must not import L5. Take the reader as an injected '
      + 'port instead (design §1-8: "L2 → L5 ... ledger 는 전부 주입 포트").',
    ).toEqual([]);
  });

  it('exposes no export whose name suggests persistence', () => {
    expect(scan(/export\s+(async\s+)?function\s+\w*(save|persist|write|flush|store)\w*/gi))
      .toEqual([]);
  });

  it('no source file contains a RAW NUL byte (use the escape instead)', () => {
    // A literal NUL makes byte-oriented tools classify the file as binary:
    // ripgrep stops at that offset and reports "Binary file ... matches", so a
    // later grep for anything BELOW that line silently returns nothing. The
    // failure is invisible — the search succeeds and finds less than it should.
    //
    // Measured 2026-09-02: `lib/replay/replay.js` and `tests/replay/replay.test.js`
    // each carried a raw NUL as the key separator and truncated two of this
    // task's own searches before a repo sweep caught them. `'\0'` is the
    // identical byte at runtime, so the escape costs nothing.
    //
    // Covers BOTH directories, unlike `scan()` which reads lib/replay only.
    const RAW_NUL = String.fromCharCode(0);
    const offenders = [];
    for (const dir of [REPLAY_DIR, join(PLUGIN_ROOT, 'tests', 'replay')]) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
        const text = readFileSync(join(dir, name), 'utf-8');
        const count = text.split(RAW_NUL).length - 1;
        if (count > 0) offenders.push(`${name}: ${count} raw NUL byte(s)`);
      }
    }
    expect(
      offenders,
      String.raw`Write the separator as '\0', not as a literal NUL byte.`,
    ).toEqual([]);
  });

  it('gate self-check: the NUL detector fires on a string that has one', () => {
    // Without this, "no offenders" and "the detector never matches" look alike.
    const RAW_NUL = String.fromCharCode(0);
    expect(`a${RAW_NUL}b`.split(RAW_NUL).length - 1).toBe(1);
    expect(String.raw`a\0b`.split(RAW_NUL).length - 1).toBe(0);
  });
});

/**
 * One ledger line, with the identity terms overridable.
 *
 * @param {object} over - fields to override.
 * @returns {object} envelope-shaped line.
 */
function ln(over) {
  return {
    v: 1,
    ts: '2026-09-02T10:00:00.000Z',
    event: 'tool.used',
    mission_id: 'M-20260902-041',
    session_id: 's1',
    source: 'hook',
    pid: 1,
    seq: 0,
    ...over,
  };
}

describe('the restated contracts agree with their originals', () => {
  it('dedupeKey agrees with ledger.js#dedupeEvents within one session', () => {
    // Inside a single session the two keys are equivalent: the extra
    // `session_id` term is constant and cannot separate anything.
    const events = [
      ln({}),
      ln({ event: 'review.requested' }),
      ln({ seq: 1 }),
      ln({ source: 'gate' }),
      ln({ pid: 2 }),
    ];
    expect(new Set(events.map(dedupeKey)).size).toBe(dedupeEvents(events).length);
    expect(dedupeEvents(events)).toHaveLength(4);
  });

  it('never collapses MORE lines than the ledger (the safe direction)', () => {
    // Holds before and after T-20 adds `session_id`, so it is the invariant to
    // assert while the two sides differ. Replay keeping a line the ledger would
    // merge is at worst a visible duplicate; the reverse is silent data loss.
    const events = [
      ln({}),
      ln({ session_id: 's2' }),
      ln({ session_id: 's2', seq: 1 }),
      ln({ source: 'gate' }),
    ];
    expect(new Set(events.map(dedupeKey)).size)
      .toBeGreaterThanOrEqual(dedupeEvents(events).length);
  });

  it('keeps two sessions that share a pid and a seq as two distinct lines', () => {
    // The hazard the session term exists for: on a (source, pid, seq) key these
    // two collide and one is dropped as a duplicate — data loss wearing the
    // costume of successful dedupe.
    //
    // History: this assertion replaced a TRIPWIRE that pinned the window in
    // which this module keyed on 4 terms and `ledger.js` still keyed on 3. The
    // tripwire was written to go RED the moment T-20 landed, and it did so at
    // 17:58 (measured: ledger.js mtime moved 16:46 → 17:51 mid-task). Both
    // sides now key on (session_id, source, pid, seq) with the same NUL
    // separator, so the divergence is closed and the tripwire is retired rather
    // than left behind as a fossil asserting a state that no longer exists.
    const shared = [ln({}), ln({ session_id: 's2' })];
    expect(dedupeEvents(shared)).toHaveLength(2);
    expect(new Set(shared.map(dedupeKey)).size).toBe(2);
  });

  it('dedupeKey and dedupeEvents disagree on nothing across field-boundary cases', () => {
    // ('a',1,23) vs ('a',12,3) collide under a naive concatenation. If either
    // side ever adopts one, this pair separates them.
    const events = [ln({ pid: 1, seq: 23 }), ln({ pid: 12, seq: 3 })];
    expect(dedupeEvents(events)).toHaveLength(2);
    expect(new Set(events.map(dedupeKey)).size).toBe(2);
  });

  it('REQUIRED_ENVELOPE_KEYS matches the schema\'s required array exactly', () => {
    const schema = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, 'schemas', 'ledger-envelope.schema.json'), 'utf-8'),
    );
    // Same members AND same order — the constant claims to be verbatim.
    expect([...REQUIRED_ENVELOPE_KEYS]).toEqual(schema.required);
  });

  it('every required envelope key is one the schema actually declares', () => {
    const schema = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, 'schemas', 'ledger-envelope.schema.json'), 'utf-8'),
    );
    for (const key of REQUIRED_ENVELOPE_KEYS) {
      expect(Object.keys(schema.properties), `${key} is not a schema property`).toContain(key);
    }
  });
});

describe('gate self-verification (negative control)', () => {
  it('the scanner reports a hit when one exists', () => {
    // Without this, "no violations" and "the scanner is dead" look identical.
    // `export` appears in every file here, so a match proves the scan runs.
    expect(scan(/\bexport\b/g).length).toBeGreaterThan(0);
  });

  it('the scanner reports nothing for a token that is genuinely absent', () => {
    expect(scan(/\bzzz_definitely_not_present_zzz\b/g)).toEqual([]);
  });
});
