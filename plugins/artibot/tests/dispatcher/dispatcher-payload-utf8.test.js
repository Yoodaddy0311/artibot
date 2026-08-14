import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * scripts/hooks/_dispatcher-utils.js#readPayload — UTF-8 across the stdin
 * chunk boundary.
 *
 * A piped stdin stream hands out Buffers of at most the default pipe
 * highWaterMark (65,536 B). Accumulating them with `buf += chunk` stringifies
 * each Buffer in ISOLATION, so a multi-byte character straddling a boundary
 * loses its tail and both halves decode to U+FFFD. `setEncoding` (or a single
 * decode of the concatenated Buffer) carries the partial sequence across.
 *
 * This costs more here than in one hook: the dispatcher re-serializes the
 * payload it read to EVERY child in the slot (`spawnHook`, :170), so a single
 * bad decode fans out to all of them even though each child reads its own
 * stdin correctly.
 *
 * FIXTURE SIZE IS THE WHOLE TEST — see rules/verification-discipline.md §9.
 * A prior fold round-trip suite in this repo used a few-hundred-byte fixture
 * against a 16 KB cap; it passed, proved nothing, and the real payload was
 * 31,900 B. So the fixture here is asserted to exceed 65,536 B, AND a naive
 * reader is run against the very same bytes as a negative control. If the
 * control stops corrupting, the fixture no longer reaches the failure regime
 * and every other assertion below has gone vacuous — that is a failure, not a
 * pass. Korean is used because it is this repo's working language and its
 * 3-byte code points cannot align with a 2^n boundary.
 *
 * Measured on a real pipe, 2026-08-14 (this machine, Node process.version):
 *   payloadBytes= 64,513  naive U+FFFD=0   readPayload U+FFFD=0
 *   payloadBytes= 66,013  naive U+FFFD=2   readPayload U+FFFD=0
 *   payloadBytes=180,013  naive U+FFFD=2   readPayload U+FFFD=0
 *
 * What this file does NOT see:
 *   - Hooks that read stdin themselves rather than through readPayload. They
 *     go via lib/core/io.js#readStdin, which closes the same gap with
 *     `setEncoding`; that path is not exercised here.
 *   - Payloads arriving on a non-pipe stdin (file redirect, tty). The chunk
 *     size differs and the boundary lands elsewhere.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DISPATCHER_UTILS = pathToFileURL(
  path.resolve(HERE, '..', '..', 'scripts', 'hooks', '_dispatcher-utils.js'),
).href;

const PIPE_CHUNK_BYTES = 65536;

/**
 * Korean body large enough to span several pipe chunks, and arranged so the
 * straddle is arithmetic rather than luck.
 *
 * Every character here is 3 bytes — no spaces, no punctuation. `JSON.stringify`
 * emits `{"prompt":"` first, exactly 11 ASCII bytes, so character k occupies
 * bytes 11+3k … 13+3k. Byte 65,536 is therefore (65536-11) mod 3 = 2 bytes into
 * character 21,841: the chunk boundary lands strictly INSIDE a code point.
 * An earlier draft of this fixture mixed in ASCII spaces, which shifted the
 * offset onto a character start — the naive control below reported 0
 * replacement chars and the whole file went vacuously green. That is the §9
 * failure caught in the act, and it is why the control is not optional.
 */
const BODY = '한글청크경계'.repeat(11000);
const PAYLOAD = JSON.stringify({ prompt: BODY, hook_event_name: 'UserPromptSubmit' });
const PAYLOAD_BYTES = Buffer.byteLength(PAYLOAD, 'utf8');

let TMP;

/** Write a probe module and return its absolute path. */
function probe(name, src) {
  const file = path.join(TMP, name);
  writeFileSync(file, src, 'utf8');
  return file;
}

/**
 * Pipe PAYLOAD into a child process and return its parsed stdout.
 *
 * A real child on a real pipe is the only way to reproduce the chunking:
 * calling readPayload() in-process against a synthetic stream would let the
 * test choose the chunk sizes, which is the bug under test.
 */
function pipeInto(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`probe exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`unparseable probe stdout (${out.slice(0, 200)}): ${e.message}`));
      }
    });
    child.stdin.end(PAYLOAD, 'utf8');
  });
}

// Reports character count, replacement-char count and an exact-match flag, so
// a failure says whether bytes were lost or merely reshuffled.
const REPORT = `
  const fffd = (text.match(/\\uFFFD/g) || []).length;
  process.stdout.write(JSON.stringify({
    chars: text.length,
    fffd,
    exact: text === EXPECTED,
  }));
`;

const EXPECTED_DECL = 'const EXPECTED = JSON.parse(require("node:fs").readFileSync(process.env.ARTIBOT_FIXTURE, "utf8")).prompt;';

beforeAll(() => {
  TMP = mkdtempSync(path.join(os.tmpdir(), 'artibot-payload-utf8-'));
  // The expected body is handed over as a file, not inlined into the probe
  // source: a 180 KB string literal in a generated module is its own decode
  // path and would muddy what the assertion is measuring.
  writeFileSync(path.join(TMP, 'fixture.json'), PAYLOAD, 'utf8');
  process.env.ARTIBOT_FIXTURE = path.join(TMP, 'fixture.json');
});

afterAll(() => {
  delete process.env.ARTIBOT_FIXTURE;
  rmSync(TMP, { recursive: true, force: true });
});

describe('readPayload — UTF-8 across the 64 KB stdin chunk boundary', () => {
  it('uses a fixture that actually crosses the pipe chunk boundary', () => {
    // Guards the guard. If someone shrinks the fixture, this fails here rather
    // than turning the rest of the file into a green that means nothing.
    expect(PAYLOAD_BYTES).toBeGreaterThan(PIPE_CHUNK_BYTES);
    expect(PAYLOAD_BYTES).toBeGreaterThan(150000); // several boundaries, not one

    // Uniformly 3 bytes per character, so the straddle is computed, not hoped
    // for. Mixing in ASCII shifts every later offset and can land the boundary
    // on a character start.
    expect(Buffer.byteLength(BODY, 'utf8')).toBe(BODY.length * 3);
    // …and the boundary is provably interior to a character.
    expect((PIPE_CHUNK_BYTES - PAYLOAD.indexOf(BODY[0])) % 3).not.toBe(0);
  });

  it('NEGATIVE CONTROL: a `buf += chunk` reader corrupts these exact bytes', async () => {
    // The proof that this fixture reaches the failure regime. If this ever
    // reports 0, do NOT relax it — the payload has stopped straddling a
    // boundary (fixture changed, or the pipe highWaterMark did), and the
    // regression assertion below has silently become untested.
    const p = probe('naive.mjs', [
      "const { createRequire } = await import('node:module');",
      'const require = createRequire(import.meta.url);',
      EXPECTED_DECL,
      "let raw = '';",
      'for await (const chunk of process.stdin) raw += chunk;',
      // U+FFFD is a legal JSON string character, so the parse still succeeds —
      // which is precisely why this corruption is silent in production.
      'const text = JSON.parse(raw).prompt;',
      REPORT,
    ].join('\n'));

    const res = await pipeInto(p);
    expect(res.fffd).toBeGreaterThan(0);
    expect(res.exact).toBe(false);
  }, 20000);

  it('round-trips a >64 KB Korean payload with no replacement characters', async () => {
    const p = probe('read-payload.mjs', [
      "const { createRequire } = await import('node:module');",
      'const require = createRequire(import.meta.url);',
      EXPECTED_DECL,
      `const { readPayload } = await import(${JSON.stringify(DISPATCHER_UTILS)});`,
      'const payload = await readPayload();',
      "const text = payload.prompt ?? '';",
      REPORT,
    ].join('\n'));

    const res = await pipeInto(p);
    expect(res.fffd).toBe(0);
    expect(res.exact).toBe(true);
    expect(res.chars).toBe(BODY.length);
  }, 20000);

  it('keeps the payload intact through spawnHook into a child hook', async () => {
    // The production path end to end: dispatcher reads its own stdin, then
    // re-serializes to every hook in the slot. Corruption at either hop shows
    // up here, and only here.
    const grandchild = probe('grandchild.mjs', [
      "const { createRequire } = await import('node:module');",
      'const require = createRequire(import.meta.url);',
      EXPECTED_DECL,
      `const { readPayload } = await import(${JSON.stringify(DISPATCHER_UTILS)});`,
      'const payload = await readPayload();',
      "const text = payload.prompt ?? '';",
      REPORT,
    ].join('\n'));

    const p = probe('dispatcher.mjs', [
      `const { readPayload, spawnHook } = await import(${JSON.stringify(DISPATCHER_UTILS)});`,
      'const payload = await readPayload();',
      `const r = await spawnHook(${JSON.stringify(grandchild)}, payload, { timeoutMs: 15000, name: 'probe' });`,
      'process.stdout.write(r.stdout);',
    ].join('\n'));

    const res = await pipeInto(p);
    expect(res.fffd).toBe(0);
    expect(res.exact).toBe(true);
  }, 30000);
});

describe('readPayload — degenerate stdin', () => {
  /** Same harness, but with the given bytes instead of the large fixture. */
  function pipeRaw(scriptPath, input) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', () => resolve(out));
      child.stdin.end(input, 'utf8');
    });
  }

  const ECHO = [
    `const { readPayload } = await import(${JSON.stringify(DISPATCHER_UTILS)});`,
    'process.stdout.write(JSON.stringify(await readPayload()));',
  ].join('\n');

  it('returns {} for empty stdin', async () => {
    const out = await pipeRaw(probe('empty.mjs', ECHO), '');
    expect(JSON.parse(out)).toEqual({});
  }, 20000);

  it('returns {} for unparseable stdin rather than throwing', async () => {
    const out = await pipeRaw(probe('garbage.mjs', ECHO), '{"unterminated":');
    expect(JSON.parse(out)).toEqual({});
  }, 20000);
});
