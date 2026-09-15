/**
 * Unit contract for the shared bounded ledger tail read.
 *
 * Every case runs against a REAL file under a fresh `os.tmpdir()` directory,
 * never a mock and never this repository's own ledger: the module's whole
 * subject is byte offsets inside a real file, and a mocked fs would let the
 * offset arithmetic be wrong while the suite stayed green. The fixture path is
 * resolved through `ledger.js#ledgerFilePath` rather than hard-coded, so the
 * test keeps agreeing with the module when the configured ledger location
 * moves. A temp root has no `.git`, so that resolves to
 * `<root>/<configured rel>` with no git-common-dir branch involved.
 *
 * FIXTURE SIZES ARE REAL. The window-boundary cases do not assert a 128 KB cap
 * with a 300-byte file — that would prove nothing (rules §9). Two shapes are
 * measured instead: a small window passed via `tailBytes` with the start offset
 * arithmetically placed INSIDE a line, and a >128 KB file read at the real
 * default so the shipped bound is the one actually exercised.
 *
 * ── WHAT THIS SUITE CANNOT SEE ──────────────────────────────────────────────
 *   - CONCURRENT APPEND. Every case reads a file nobody is writing. A tail read
 *     racing a real append (the live case) is untested here.
 *   - A REAL SHORT READ. The short-read cases below FAKE one by capping
 *     `readSync` (the only mocked thing in this file). A genuine partial read
 *     needs a slow pipe or a signal mid-syscall; nothing here proves the
 *     kernel ever returns short on the files this module actually reads, only
 *     that the module survives it when it happens.
 *   - COST. Latency on a live ledger is a separate measurement, recorded in
 *     `scripts/hooks/subagent-handler.js#RECEIPT_TAIL_BYTES`.
 *
 * @module tests/runtime/ledger-tail
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { DEFAULT_TAIL_BYTES, readLedgerTail, readNdjsonTail } from '../../lib/runtime/ledger-tail.js';

/**
 * Control for the short-read probe below. Hoisted because `vi.mock` factories
 * run before module bodies and cannot close over an ordinary `let`.
 * `cap === null` means "pass through untouched", which is every other test in
 * this file — the mock must be inert unless a case explicitly arms it.
 */
const shortRead = vi.hoisted(() => ({ cap: null }));

// The ONLY mocked thing in this suite. Everything else spreads through from the
// real `node:fs`, including the fs calls this test file makes for its own
// fixtures, because a suite about byte offsets that fakes the filesystem is
// measuring its own mock. `readSync` is faked for one reason: a genuine short
// read needs a slow pipe or a signal mid-syscall, neither of which is
// reproducible on demand in-process.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: actual.default,
    readSync: (fd, buf, offset, length, position) => {
      const want = shortRead.cap === null ? length : Math.min(length, shortRead.cap);
      return actual.readSync(fd, buf, offset, want, position);
    },
  };
});

let root;
let ledger;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-ledger-tail-'));
  ledger = ledgerFilePath(root);
  mkdirSync(path.dirname(ledger), { recursive: true });
});

afterEach(() => {
  shortRead.cap = null;
  rmSync(root, { recursive: true, force: true });
});

/** Write the ledger fixture verbatim. @param {string} text */
function writeLedger(text) {
  writeFileSync(ledger, text, 'utf8');
}

/**
 * One JSON line padded to an EXACT byte width, so the test can compute where a
 * byte offset lands instead of hoping.
 * @param {number} n @param {number} width bytes, excluding the newline
 * @returns {string}
 */
function fixedLine(n, width) {
  const head = `{"n":${n},"pad":"`;
  const tail = '"}';
  const padLen = width - head.length - tail.length;
  if (padLen < 0) throw new Error(`width ${width} too small for n=${n}`);
  return `${head}${'a'.repeat(padLen)}${tail}`;
}

describe('readLedgerTail — unreadable inputs yield []', () => {
  it('returns [] when the ledger file does not exist', () => {
    expect(readLedgerTail(root)).toEqual([]);
  });

  it('returns [] for an empty ledger file', () => {
    writeLedger('');
    expect(readLedgerTail(root)).toEqual([]);
  });

  it('returns [] for a whitespace-only ledger file', () => {
    writeLedger('\n\n   \n');
    expect(readLedgerTail(root)).toEqual([]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { root: '/tmp' }],
    ['the empty string', ''],
  ])('returns [] when projectRoot is %s', (_label, value) => {
    expect(readLedgerTail(value)).toEqual([]);
  });

  it('does not throw when the ledger path is a directory', () => {
    mkdirSync(ledger, { recursive: true });
    expect(() => readLedgerTail(root)).not.toThrow();
    expect(readLedgerTail(root)).toEqual([]);
  });
});

describe('readLedgerTail — whole-file reads', () => {
  it('returns every line, in append order, when the file is smaller than the window', () => {
    writeLedger(['{"n":0}', '{"n":1}', '{"n":2}'].join('\n') + '\n');
    expect(readLedgerTail(root)).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
  });

  it('keeps the first line when the read starts at offset 0', () => {
    writeLedger('{"n":0}\n{"n":1}\n');
    // The partial-line drop is conditional on start > 0. A file that fits the
    // window starts at 0, so nothing may be discarded.
    expect(readLedgerTail(root)[0]).toEqual({ n: 0 });
  });

  it('tolerates a missing trailing newline on the last line', () => {
    writeLedger('{"n":0}\n{"n":1}');
    expect(readLedgerTail(root)).toEqual([{ n: 0 }, { n: 1 }]);
  });
});

describe('readLedgerTail — line filtering', () => {
  it('skips a corrupt line without losing the lines around it', () => {
    writeLedger('{"n":0}\n{"n":1,,,broken\n{"n":2}\n');
    expect(readLedgerTail(root)).toEqual([{ n: 0 }, { n: 2 }]);
  });

  it('skips blank lines between records', () => {
    writeLedger('{"n":0}\n\n   \n{"n":1}\n');
    expect(readLedgerTail(root)).toEqual([{ n: 0 }, { n: 1 }]);
  });

  it.each([
    ['a number', '42'],
    ['a string', '"hello"'],
    ['a boolean', 'true'],
    ['null', 'null'],
  ])('skips a line that parses to %s', (_label, literal) => {
    writeLedger(`{"n":0}\n${literal}\n{"n":1}\n`);
    expect(readLedgerTail(root)).toEqual([{ n: 0 }, { n: 1 }]);
  });

  it('KEEPS a line that parses to an array (pinning current behavior)', () => {
    // `typeof [] === 'object'`, so the extracted filter admits arrays. This is
    // the behavior the hook has always had and the extraction did not change
    // it; the pin exists so a future narrowing to plain objects is a decision
    // someone makes on purpose, not a silent drift. Consumers already tolerate
    // it: they read named fields, and an array has none of them.
    writeLedger('{"n":0}\n[1,2,3]\n');
    expect(readLedgerTail(root)).toEqual([{ n: 0 }, [1, 2, 3]]);
  });
});

describe('readLedgerTail — the window boundary', () => {
  it('drops the partial first line and keeps everything after it', () => {
    const WIDTH = 100;            // bytes per line, newline excluded
    const STRIDE = WIDTH + 1;     // with the newline
    const COUNT = 20;
    writeLedger(Array.from({ length: COUNT }, (_, n) => fixedLine(n, WIDTH)).join('\n') + '\n');

    const size = STRIDE * COUNT;  // 2020
    const tailBytes = 350;
    const start = size - tailBytes;            // 1670
    const cutLine = Math.floor(start / STRIDE); // 16
    // The offset must land strictly INSIDE a line, otherwise this test is
    // asserting the drop of a line that was whole anyway.
    expect(start % STRIDE).not.toBe(0);
    expect(cutLine).toBe(16);

    const out = readLedgerTail(root, { tailBytes });
    expect(out.map((r) => r.n)).toEqual([17, 18, 19]);
    expect(out.map((r) => r.n)).not.toContain(cutLine);
    expect(out.at(-1).n).toBe(COUNT - 1);
  });

  it('keeps the final line when the window starts mid-line', () => {
    writeLedger(Array.from({ length: 12 }, (_, n) => fixedLine(n, 60)).join('\n') + '\n');
    const out = readLedgerTail(root, { tailBytes: 150 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.at(-1).n).toBe(11);
  });

  it('bounds a >128 KB ledger at the real default window', () => {
    // A real-size fixture: 4,000 lines x 128 B = 512,000 B, four times the
    // shipped window. Reading this at the default is the only way to show the
    // default itself bounds anything.
    const WIDTH = 127;
    const STRIDE = WIDTH + 1;
    const COUNT = 4000;
    const size = STRIDE * COUNT;
    expect(size).toBeGreaterThan(DEFAULT_TAIL_BYTES * 3);
    writeLedger(Array.from({ length: COUNT }, (_, n) => fixedLine(n, WIDTH)).join('\n') + '\n');

    const out = readLedgerTail(root);
    // At most one line per stride fits the window, minus the discarded partial.
    const maxLines = Math.ceil(DEFAULT_TAIL_BYTES / STRIDE);
    expect(out.length).toBeLessThanOrEqual(maxLines);
    expect(out.length).toBeGreaterThanOrEqual(maxLines - 2);
    expect(out.at(-1).n).toBe(COUNT - 1);
    expect(out[0].n).toBeGreaterThan(COUNT - maxLines - 2);
    // Append order survives the window, and no line is duplicated.
    const ns = out.map((r) => r.n);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
    expect(new Set(ns).size).toBe(ns.length);
  });
});

describe('readLedgerTail — the tailBytes option', () => {
  it('defaults to DEFAULT_TAIL_BYTES, which is 128 KB', () => {
    expect(DEFAULT_TAIL_BYTES).toBe(131072);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '4096'],
  ])('falls back to the default window when tailBytes is %s', (_label, tailBytes) => {
    // The fallback is observable: a 512,000 B file read with a nonsense budget
    // must still be bounded, never read whole.
    const WIDTH = 127;
    const COUNT = 4000;
    writeLedger(Array.from({ length: COUNT }, (_, n) => fixedLine(n, WIDTH)).join('\n') + '\n');

    const out = readLedgerTail(root, { tailBytes });
    expect(out.length).toBeLessThanOrEqual(Math.ceil(DEFAULT_TAIL_BYTES / (WIDTH + 1)));
    expect(out.length).toBeGreaterThan(0);
    expect(out.at(-1).n).toBe(COUNT - 1);
  });

  it('accepts an explicitly smaller window', () => {
    writeLedger(Array.from({ length: 50 }, (_, n) => fixedLine(n, 80)).join('\n') + '\n');
    const wide = readLedgerTail(root, { tailBytes: 2000 });
    const narrow = readLedgerTail(root, { tailBytes: 400 });
    expect(narrow.length).toBeLessThan(wide.length);
    expect(narrow.at(-1)).toEqual(wide.at(-1));
  });

  it('accepts an omitted options object', () => {
    writeLedger('{"n":0}\n');
    expect(readLedgerTail(root)).toEqual([{ n: 0 }]);
    expect(readLedgerTail(root, {})).toEqual([{ n: 0 }]);
  });
});

describe('readNdjsonTail — the path-taking form', () => {
  /**
   * An NDJSON file that is NOT a ledger and is not under any ledger path, so
   * the case cannot pass by accidentally hitting the resolver.
   * @param {string} text @returns {string} the file path
   */
  function writeStream(text) {
    const file = path.join(root, 'transcript.jsonl');
    writeFileSync(file, text, 'utf8');
    return file;
  }

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['an object', { path: '/tmp/x.jsonl' }],
    ['an array', ['/tmp/x.jsonl']],
    ['the empty string', ''],
  ])('returns [] when filePath is %s', (_label, value) => {
    expect(readNdjsonTail(value)).toEqual([]);
  });

  it('returns [] for a path that does not exist', () => {
    expect(readNdjsonTail(path.join(root, 'absent', 'nope.jsonl'))).toEqual([]);
  });

  it('returns [] for an empty file and does not throw on a directory', () => {
    expect(readNdjsonTail(writeStream(''))).toEqual([]);
    expect(() => readNdjsonTail(root)).not.toThrow();
    expect(readNdjsonTail(root)).toEqual([]);
  });

  it('reads a file with no ledger in sight, in append order', () => {
    const file = writeStream('{"type":"user"}\n{"type":"assistant"}\n');
    expect(readNdjsonTail(file)).toEqual([{ type: 'user' }, { type: 'assistant' }]);
  });

  it('drops the partial first line at a window boundary it lands inside', () => {
    const WIDTH = 100;
    const STRIDE = WIDTH + 1;
    const COUNT = 20;
    const file = writeStream(
      Array.from({ length: COUNT }, (_, n) => fixedLine(n, WIDTH)).join('\n') + '\n',
    );
    const start = STRIDE * COUNT - 350;        // 1670
    expect(start % STRIDE).not.toBe(0);        // precondition: truly mid-line
    expect(readNdjsonTail(file, { tailBytes: 350 }).map((r) => r.n)).toEqual([17, 18, 19]);
  });

  it('bounds a >128 KB file at the default window', () => {
    const WIDTH = 127;
    const COUNT = 4000;
    const file = writeStream(
      Array.from({ length: COUNT }, (_, n) => fixedLine(n, WIDTH)).join('\n') + '\n',
    );
    const out = readNdjsonTail(file);
    expect(out.length).toBeLessThanOrEqual(Math.ceil(DEFAULT_TAIL_BYTES / (WIDTH + 1)));
    expect(out.at(-1).n).toBe(COUNT - 1);
  });

  it('skips corrupt and non-object lines the same way the ledger form does', () => {
    const file = writeStream('{"n":0}\nnot json\n42\n{"n":1}\n');
    expect(readNdjsonTail(file)).toEqual([{ n: 0 }, { n: 1 }]);
  });

  it('keeps working when nothing arms the short-read mock', () => {
    // Guards the mock itself: if the pass-through branch ever broke, every
    // other case in this file would be reading through a fake and the suite
    // would still be green. Arming is opt-in and `cap` resets in afterEach.
    expect(shortRead.cap).toBeNull();
    expect(readNdjsonTail(writeStream('{"n":0}\n{"n":1}\n'))).toEqual([{ n: 0 }, { n: 1 }]);
  });

  it('is the function readLedgerTail delegates to — same bytes, same result', () => {
    // Resolve the ledger path the module resolves, then read it BOTH ways.
    // If the wrapper ever grew a second rule, these two would diverge.
    writeLedger(['{"n":0}', '{"n":1}', '{"n":2}'].join('\n') + '\n');
    expect(readLedgerTail(root)).toEqual(readNdjsonTail(ledgerFilePath(root)));
    expect(readLedgerTail(root, { tailBytes: 12 }))
      .toEqual(readNdjsonTail(ledgerFilePath(root), { tailBytes: 12 }));
  });
});

describe('readNdjsonTail — short reads', () => {
  const WIDTH = 100;
  const STRIDE = WIDTH + 1;
  const COUNT = 10;
  /** Records 0..COUNT-1, each exactly STRIDE bytes including its newline. */
  const BODY = Array.from({ length: COUNT }, (_, n) => fixedLine(n, WIDTH)).join('\n') + '\n';

  /** @param {string} text @returns {string} the file path */
  function writeStream(text) {
    const file = path.join(root, 'short.jsonl');
    writeFileSync(file, text, 'utf8');
    return file;
  }

  it('the mock really does short-read (precondition — a probe that cannot show red proves nothing)', () => {
    const file = writeStream(BODY);
    const full = readNdjsonTail(file).length;
    shortRead.cap = STRIDE * 3;
    expect(readNdjsonTail(file).length).toBeLessThan(full);
  });

  it('does not lose the last COMPLETE record when the read stops just before its newline', () => {
    // The exact alignment that used to lose data: the syscall returns k*STRIDE-1
    // bytes, so the buffer holds records 0..k-1 with the final newline NOT read.
    // Decoding the REQUESTED length left (length - n) zero bytes appended
    // straight onto record k-1, and a NUL is not whitespace to `trim`, so that
    // record failed JSON.parse and vanished. Slicing to the RETURNED count is
    // what keeps it.
    const file = writeStream(BODY);
    const k = 4;
    shortRead.cap = STRIDE * k - 1;

    const out = readNdjsonTail(file);
    expect(out.map((r) => r.n)).toEqual([0, 1, 2, 3]);
    expect(out.at(-1).n).toBe(k - 1);
  });

  it('adds no phantom record from the unread remainder of the buffer', () => {
    const file = writeStream(BODY);
    shortRead.cap = STRIDE * 5;
    const out = readNdjsonTail(file);
    // Exactly five whole records; nothing extra, and every entry is a real one.
    expect(out).toHaveLength(5);
    for (const rec of out) expect(typeof rec.n).toBe('number');
  });

  it('still drops a genuinely truncated record rather than inventing one', () => {
    const file = writeStream(BODY);
    shortRead.cap = STRIDE * 2 + 40;   // lands INSIDE record 2's JSON
    const out = readNdjsonTail(file);
    expect(out.map((r) => r.n)).toEqual([0, 1]);
  });

  it('loses nothing when the read stops exactly ON a newline', () => {
    // The mirror of the k*STRIDE-1 case. Here the last element after the split
    // is the empty string, which the blank-line skip eats. Popping the trailing
    // element unconditionally would be harmless HERE and destructive one byte
    // earlier — which is why the code discriminates by JSON.parse, not by
    // position.
    const file = writeStream(BODY);
    shortRead.cap = STRIDE * 4;
    expect(readNdjsonTail(file).map((r) => r.n)).toEqual([0, 1, 2, 3]);
  });

  it('returns EXACTLY the records whose bytes arrived, at every cut point', () => {
    // Sweeps all 303 byte offsets across three records instead of trusting one
    // hand-picked alignment.
    //
    // THE COUNT IS THE ASSERTION THAT BITES. "no partial object" and "no gap"
    // are both true of the UNFIXED code as well — measured: over these same 303
    // caps the unfixed decode violates neither, it just silently returns fewer
    // records. An exact expected count is what separates them, and it does:
    // the formula below matches the fixed decode at 303/303 caps and the
    // unfixed one at 300/303 (measured 2026-09-15). Record i occupies
    // [i*STRIDE, i*STRIDE+WIDTH) with its newline at i*STRIDE+WIDTH, so it is
    // fully present as soon as `cap` reaches the end of its CONTENT — the
    // newline is a separator, not part of the record.
    const expected = (cap) => (cap < WIDTH ? 0 : Math.floor((cap - WIDTH) / STRIDE) + 1);
    const file = writeStream(BODY);
    for (let cap = 1; cap <= STRIDE * 3; cap += 1) {
      shortRead.cap = cap;
      const out = readNdjsonTail(file);
      expect({ cap, n: out.length }).toEqual({ cap, n: expected(cap) });
      for (const rec of out) {
        // A truncated record would be missing `pad` or carry a short one.
        expect(rec.pad).toBe('a'.repeat(WIDTH - `{"n":${rec.n},"pad":"`.length - 2));
      }
      // Whatever came back is a PREFIX of the full sequence, never a gap.
      expect(out.map((r) => r.n)).toEqual(Array.from({ length: out.length }, (_, i) => i));
    }
  });

  it('returns [] when the read delivers nothing at all', () => {
    const file = writeStream(BODY);
    shortRead.cap = 0;
    expect(readNdjsonTail(file)).toEqual([]);
  });

  it('drops the leading partial line AND handles a short read in the same call', () => {
    const file = writeStream(BODY);
    // Window starts mid-record (offset 350 into a 1010-byte file), and the read
    // then comes up short. Both trims must apply: head partial dropped by the
    // shift, tail bounded by the returned byte count.
    shortRead.cap = STRIDE * 3 - 1;
    const out = readNdjsonTail(file, { tailBytes: 660 });
    expect(out.length).toBeGreaterThan(0);
    for (const rec of out) expect(typeof rec.n).toBe('number');
    expect(out.map((r) => r.n)).toEqual([...out.map((r) => r.n)].sort((a, b) => a - b));
  });
});
