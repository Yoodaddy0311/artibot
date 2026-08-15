import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fallbackStdioLoop } from '../../bin/artibot-mcp.mjs';

/**
 * bin/artibot-mcp.mjs#fallbackStdioLoop — UTF-8 across a stdin chunk boundary.
 *
 * Same defect class as `_dispatcher-utils.js#readPayload`
 * (tests/dispatcher/dispatcher-payload-utf8.test.js), reached by a different
 * route. A Buffer chunk stringified in ISOLATION loses the tail of any
 * multi-byte character that straddles the chunk edge, and both halves decode
 * to U+FFFD. The loop must carry the partial sequence into the next chunk —
 * whether by `setEncoding`, a `StringDecoder`, or anything else.
 *
 * **What is pinned here is the observable result, not the mechanism.** The two
 * code paths in this file already decode differently (`createStdioTransport`
 * uses `setEncoding`), so a fix that spells it a third way is fine. What may
 * never happen is a request coming back with a mangled id.
 *
 * This one has an axis `readPayload` did not: it is a STREAMING LINE PARSER,
 * not a read-it-all. So decoding can be correct while framing slips — lines
 * merged, split, reordered, or dropped at the chunk seam. Every test below
 * therefore checks ids AND count AND order, not just the absence of U+FFFD.
 *
 * FIXTURE SIZE IS THE WHOLE TEST — rules/verification-discipline.md §9.
 * A prior fixture in this repo was 198 KB and still proved nothing, because
 * ASCII padding shifted the boundary onto a character START and the negative
 * control quietly reported 0 replacement characters. So: ids are built from
 * 3-byte Korean only, the straddle is asserted as arithmetic, and a naive
 * reader is run over the identical bytes as a control. If the control stops
 * corrupting, the fixture has left the failure regime and every other
 * assertion here has gone vacuous — that is a failure, not a pass.
 *
 * Measured 2026-08-15 on this machine, real pipe (Node v22.19.0):
 *   payloadBytes=72,300   bigIdBytes=72,000   bigIdStart=23
 *   (65536-23) % 3 = 2 -> byte 65,536 sits 2 bytes into a character
 *   stdin chunks delivered: 65,536 B + 6,764 B
 *   pre-fix loop -> id back 24,001 chars (want 24,000), U+FFFD=2 at char 21,837
 *   fixed loop   -> id back 24,000 chars, U+FFFD=0
 *
 * What this file does NOT see:
 *   - `createStdioTransport` (bin/artibot-mcp.mjs:~309), the other line
 *     splitter in this file. It has its own decode path.
 *   - Payloads arriving on a non-pipe stdin (file redirect, tty), where the
 *     chunk size differs and the boundary lands elsewhere.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(HERE, '..', '..', 'bin', 'artibot-mcp.mjs');
const CLI_URL = pathToFileURL(CLI_PATH).href;

const PIPE_CHUNK_BYTES = 65536;

/** JSON-RPC line whose id is the given string. `ping` echoes the id verbatim. */
const line = (id) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`;

// The first id is long enough that byte 65,536 of the whole payload lands
// inside it, so the corruption (if any) shows up in something that is echoed
// back. Padding the bulk into `params` instead would be useless: U+FFFD is a
// legal JSON string character, so a mangled `params` still parses and still
// produces a correct-looking response.
const BIG_ID = '한글경계시험'.repeat(4000);
const SMALL_IDS = ['첫번째', '두번째', '세번째', '네번째', '다섯번째'];
const IDS = [BIG_ID, ...SMALL_IDS];
const PAYLOAD = IDS.map(line).join('');
const PAYLOAD_BYTES = Buffer.byteLength(PAYLOAD, 'utf8');

/** Byte offset at which the big id's first character starts. */
const BIG_ID_START = Buffer.byteLength(PAYLOAD.slice(0, PAYLOAD.indexOf(BIG_ID)), 'utf8');

let TMP;

beforeAll(() => { TMP = mkdtempSync(path.join(os.tmpdir(), 'artibot-mcp-utf8-')); });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Collect the `id` of every JSON-RPC response line on stdout. */
function parseResponseIds(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l).id);
}

/**
 * The pre-fix reader, verbatim in shape: one isolated `toString('utf-8')` per
 * chunk. Used only as a control — it must corrupt, or the fixture is useless.
 */
function naiveLineLoop(chunks) {
  let buf = '';
  const out = [];
  for (const chunk of chunks) {
    buf += chunk.toString('utf-8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (l) out.push(JSON.parse(l).id);
    }
  }
  return out;
}

/** Feed `chunks` to the real loop through a PassThrough and collect stdout. */
async function runLoop(chunks) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  stdout.on('data', (c) => { out += c; });
  stderr.resume(); // the loop writes a warning banner; drain it

  const done = fallbackStdioLoop(stdin, stdout, stderr);
  for (const chunk of chunks) stdin.write(chunk);
  stdin.end();
  await done;
  return out;
}

/** Pipe the payload into a child that runs the real loop on a real stdin. */
function pipeIntoChild(probeSrc) {
  const file = path.join(TMP, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, probeSrc, 'utf8');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    // setEncoding on OUR side too. The response echoes a ~72 KB Korean id, so
    // the reply crosses a 64 KB pipe boundary on the way back and `out += c`
    // would reproduce the exact defect under test inside the harness — making
    // the child look broken no matter what it does. Caught 2026-08-15 doing
    // precisely that: the loop was already fixed and this test still failed.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`probe exited ${code}: ${err}`));
        return;
      }
      resolvePromise(out);
    });
    child.stdin.end(PAYLOAD, 'utf8');
  });
}

describe('fallbackStdioLoop — fixture reaches the failure regime', () => {
  it('crosses the pipe chunk boundary inside a multi-byte character', () => {
    // Guards the guard. Shrink the fixture or mix in ASCII and this fails here
    // rather than turning the rest of the file into a meaningless green.
    expect(PAYLOAD_BYTES).toBeGreaterThan(PIPE_CHUNK_BYTES);

    // Ids are uniformly 3 bytes per character, so the straddle is computed.
    for (const id of IDS) {
      expect(Buffer.byteLength(id, 'utf8')).toBe(id.length * 3);
    }

    // Byte 65,536 falls strictly INSIDE the big id — and inside a character,
    // not on its first byte.
    expect(BIG_ID_START).toBeLessThan(PIPE_CHUNK_BYTES);
    expect(BIG_ID_START + Buffer.byteLength(BIG_ID, 'utf8')).toBeGreaterThan(PIPE_CHUNK_BYTES);
    expect((PIPE_CHUNK_BYTES - BIG_ID_START) % 3).not.toBe(0);
  });

  it('NEGATIVE CONTROL: a per-chunk toString() reader corrupts these exact bytes', () => {
    // The proof. If this ever reports no corruption, do NOT relax it — the
    // fixture has stopped straddling and the assertions below are untested.
    const buf = Buffer.from(PAYLOAD, 'utf8');
    const ids = naiveLineLoop([
      buf.subarray(0, PIPE_CHUNK_BYTES),
      buf.subarray(PIPE_CHUNK_BYTES),
    ]);
    expect(ids[0]).not.toBe(BIG_ID);
    expect(ids[0]).toMatch(/�/);
  });
});

describe('fallbackStdioLoop — decoding across the chunk boundary', () => {
  it('returns every id intact when split at the pipe chunk size', async () => {
    const buf = Buffer.from(PAYLOAD, 'utf8');
    const out = await runLoop([
      buf.subarray(0, PIPE_CHUNK_BYTES),
      buf.subarray(PIPE_CHUNK_BYTES),
    ]);
    const ids = parseResponseIds(out);
    expect(ids).toEqual(IDS); // exact values, exact count, exact order
    expect(out).not.toMatch(/�/);
  });

  it('returns every id intact when split one byte into a character', async () => {
    // The worst case, chosen rather than hoped for: cut so a 3-byte character
    // has exactly one byte in the first chunk and two in the second.
    const buf = Buffer.from(PAYLOAD, 'utf8');
    const cut = BIG_ID_START + 1; // one byte into the big id's first character
    expect((cut - BIG_ID_START) % 3).not.toBe(0);
    const out = await runLoop([buf.subarray(0, cut), buf.subarray(cut)]);
    expect(parseResponseIds(out)).toEqual(IDS);
  });

  it('returns every id intact over a real pipe to a real child process', async () => {
    // A PassThrough lets the test choose the chunk sizes, which is the thing
    // under test. Only a real pipe produces production's own chunking.
    const out = await pipeIntoChild([
      `const { fallbackStdioLoop } = await import(${JSON.stringify(CLI_URL)});`,
      'await fallbackStdioLoop(process.stdin, process.stdout, process.stderr);',
    ].join('\n'));
    expect(parseResponseIds(out)).toEqual(IDS);
    expect(out).not.toMatch(/�/);
  }, 30000);

  it('NEGATIVE CONTROL: the pre-fix loop corrupts over that same real pipe', async () => {
    // Proves the real 64 KB boundary — not just the synthetic one above —
    // lands inside a character for this payload.
    const out = await pipeIntoChild([
      "let buf = '';",
      'const ids = [];',
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk.toString('utf-8');",
      '  let idx;',
      "  while ((idx = buf.indexOf('\\n')) >= 0) {",
      '    const line = buf.slice(0, idx).trim();',
      '    buf = buf.slice(idx + 1);',
      '    if (line) ids.push(JSON.parse(line).id);',
      '  }',
      '});',
      "process.stdin.on('end', () => {",
      '  process.stdout.write(JSON.stringify({',
      '    firstIdCorrupt: /\\uFFFD/.test(ids[0] ?? ""),',
      '    count: ids.length,',
      '  }));',
      '});',
    ].join('\n'));
    const res = JSON.parse(out);
    expect(res.count).toBe(IDS.length);
    expect(res.firstIdCorrupt).toBe(true);
  }, 30000);
});

describe('fallbackStdioLoop — JSON-RPC line framing', () => {
  // Decoding can be correct while framing slips. These hold the seam behaviour
  // independently of the encoding fix.
  it('keeps one response per request, in order, when a line is split mid-line', async () => {
    const buf = Buffer.from(PAYLOAD, 'utf8');
    // Cut inside the LAST small line, well past any multi-byte concern, so a
    // failure here is framing and not decoding.
    const cut = PAYLOAD_BYTES - 12;
    const out = await runLoop([buf.subarray(0, cut), buf.subarray(cut)]);
    expect(parseResponseIds(out)).toEqual(IDS);
  });

  it('emits nothing for a trailing line that never gets its newline', async () => {
    // A half-delivered line must be held, not guessed at. Dropping the newline
    // from the last request means that request is incomplete.
    const complete = SMALL_IDS.map(line).join('');
    const truncated = `${complete}${JSON.stringify({ jsonrpc: '2.0', id: '미완성', method: 'ping' })}`;
    const out = await runLoop([Buffer.from(truncated, 'utf8')]);
    expect(parseResponseIds(out)).toEqual(SMALL_IDS);
  });

  it('splits correctly when the newline itself lands on the chunk edge', async () => {
    const first = `${line('앞줄')}`;
    const rest = SMALL_IDS.map(line).join('');
    const buf = Buffer.from(first + rest, 'utf8');
    const cut = Buffer.byteLength(first, 'utf8'); // exactly after the newline
    const out = await runLoop([buf.subarray(0, cut), buf.subarray(cut)]);
    expect(parseResponseIds(out)).toEqual(['앞줄', ...SMALL_IDS]);
  });
});
