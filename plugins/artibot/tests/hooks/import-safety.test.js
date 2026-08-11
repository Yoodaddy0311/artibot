import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Import-safety: importing a hook module must never run the hook.
 *
 * A hook is spawned per event with its payload on stdin. Its top level must
 * therefore be inert on import, because tests (and sibling hooks reusing an
 * export) import these modules directly. When that invariant broke, the whole
 * suite hung: main() sat in readStdin() waiting for an EOF that never came, and
 * for the git hooks it also drove real commits. Hence the direct-run guards.
 *
 * This harness is fail-CLOSED — every ambiguous outcome is a failure:
 *
 *   marker + natural exit 0   import finished, nothing ran   PASS
 *   marker + timeout          module still holds the event   FAIL
 *                             loop (stdin/timer pending)
 *   no marker                 module exited or threw during  FAIL
 *                             evaluation
 *   exit != 0 after marker    module set a failing exit code FAIL
 *   stdout                    module printed on import       FAIL — a hook's
 *                                                  stdout is parsed as JSON by
 *                                                  the dispatcher, so any byte
 *                                                  here corrupts a real event
 *
 * The marker-and-natural-exit sentinel replaced an `import(...).then(() =>
 * process.exit(7))` one on 2026-08-11, and the difference is the whole point.
 * Every hook runs `main()` from the top level WITHOUT awaiting it. Exiting the
 * moment module evaluation finished therefore killed the process before the
 * unawaited main() could be seen holding stdin — so the old probe passed
 * `pre-bash.js` with its direct-run guard deleted, which is precisely the
 * regression this file exists to catch. Letting the process end on its own
 * instead means a module that leaves stdin pending keeps the event loop alive
 * and times out. The `unawaited top-level main()` fixture below pins this.
 *
 * The load-bearing detail is that stdin is an OPEN pipe that is never written
 * to and never closed. With `stdin: 'ignore'` (or a closed pipe) a module that
 * reads stdin sees instant EOF, returns, and PASSES — the harness would then
 * certify exactly the defect it exists to catch. The self-verification block at
 * the bottom pins that this discrimination actually works, so a future edit
 * that quietly makes the probe fail-open turns this file red.
 *
 * Design credit: the exit-code sentinel and the stdout-pollution check come
 * from the independent cross-check harness written during the 2026-08-10 guard
 * rollout.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(HERE, '..', '..', 'scripts', 'hooks');
/** The shipped guard, so the self-verification fixture exercises the real one. */
const MAIN_ENTRY_URL = pathToFileURL(path.join(HOOKS_DIR, '_main-entry.js')).href;
const TIMEOUT_MS = 15000;
/** Written to stderr once the dynamic import resolves. stdout stays reserved
 *  for the pollution check, so the signal cannot live there. */
const OK_MARK = '__ARTIBOT_IMPORT_COMPLETE__';

/** Temp dirs created for the self-verification fixtures. */
const scratch = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * Import one module in a child process and classify the outcome.
 *
 * @param {string} moduleFile Absolute path to the module under test.
 * @param {number} [timeoutMs] Budget before a still-running child counts as
 *   blocked. The real-hook sweep keeps the generous default so a loaded CI box
 *   cannot manufacture a timeout verdict; the self-verification fixtures pass a
 *   short one, because there the block is deliberate and waiting the full
 *   budget proves nothing it has not already proven.
 * @returns {Promise<{verdict: 'PASS'|'FAIL', detail: string}>}
 */
function probeImport(moduleFile, timeoutMs = TIMEOUT_MS) {
  const url = pathToFileURL(moduleFile).href;
  // Deliberately never calls process.exit — see the header. The child must be
  // allowed to end on its own so a pending stdin read shows up as a timeout.
  const code = `import(${JSON.stringify(url)}).then(`
    + `() => process.stderr.write(${JSON.stringify(OK_MARK)}),`
    + '(e) => { process.stderr.write(String((e && e.stack) || e)); process.exitCode = 3; })';

  // A throwaway HOME so a module-scope disk read cannot reach the real
  // learning store, and a write (if one ever appears) cannot corrupt it.
  const home = mkdtempSync(path.join(tmpdir(), 'import-safety-'));
  scratch.push(home);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['pipe', 'pipe', 'pipe'], // stdin stays OPEN and silent — see header
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });

    let out = '';
    let err = '';
    let settled = false;

    const finish = (verdict, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      resolve({ verdict, detail });
    };

    const timer = setTimeout(
      () => finish('FAIL', err.includes(OK_MARK)
        ? `timeout after ${timeoutMs}ms — import finished but the module still holds the event `
          + 'loop, most likely an unawaited top-level main() reading stdin'
        : `timeout after ${timeoutMs}ms — blocked during module evaluation`),
      timeoutMs,
    );

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish('FAIL', `spawn error: ${e.message}`));
    child.on('close', (exitCode) => {
      if (out.length > 0) {
        finish('FAIL', `wrote ${out.length}B to stdout on import: ${JSON.stringify(out.slice(0, 80))}`);
        return;
      }
      if (!err.includes(OK_MARK)) {
        const first = (err.trim().split('\n')[0] || 'no stderr').slice(0, 200);
        finish('FAIL', `exit ${exitCode} without completing import — ${first}`);
        return;
      }
      if (exitCode !== 0) {
        finish('FAIL', `exit ${exitCode} after import completed`);
        return;
      }
      finish('PASS', '');
    });
  });
}

describe('hook modules are import-safe', () => {
  // `.mjs` counts. It was excluded until 2026-08-11, which hid 4 of the 6 .mjs
  // hooks running main() from the top level with no guard at all — invisible
  // twice over, since the old probe could not have flagged them either. (The
  // other 2, nightly-*.mjs, carried a correct guard under a different name.)
  const files = readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
    .sort();

  it('discovers the hook directory (guards against a vacuous pass)', () => {
    // Without this, a moved directory or a bad glob would make the sweep below
    // iterate nothing and report success.
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('session-end.js');
    expect(files).toContain('_posttooluse-dispatcher.js');
    expect(files).toContain('session-ledger.mjs');
  });

  it('imports every hook without running it', async () => {
    const failures = [];
    for (const file of files) {
      // Serial on purpose: N parallel node processes starve each other on CI
      // and produce timeout verdicts that are load artefacts, not defects.
      const { verdict, detail } = await probeImport(path.join(HOOKS_DIR, file));
      if (verdict === 'FAIL') failures.push(`${file} — ${detail}`);
    }
    expect(failures).toEqual([]);
  }, 300000);
});

// ---------------------------------------------------------------------------
// Self-verification (§10: a gate that cannot fail is not a gate).
//
// Each fixture below is a module carrying exactly one of the violations this
// harness claims to catch. If the probe ever stops detecting one of them, these
// tests go red here rather than silently certifying a broken hook directory.
// ---------------------------------------------------------------------------
describe('the harness detects each violation it claims to catch', () => {
  const fixtures = mkdtempSync(path.join(tmpdir(), 'import-safety-fixtures-'));
  scratch.push(fixtures);

  /** Write a fixture module and return its absolute path. */
  function fixture(name, source) {
    const dir = path.join(fixtures, name);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mod.mjs');
    writeFileSync(file, source, 'utf8');
    return file;
  }

  const CASES = [
    [
      'blocks on stdin (the original hang)',
      'await new Promise((resolve) => { process.stdin.on("end", resolve); process.stdin.resume(); });',
      /timeout after \d+ms/,
    ],
    [
      'calls process.exit on import',
      'process.exit(0);',
      /^exit 0 without completing import —/,
    ],
    [
      'throws on import',
      'throw new Error("boom during module evaluation");',
      /^exit 3 without completing import — Error: boom during module evaluation/,
    ],
    [
      'writes to stdout on import',
      'process.stdout.write("{\\"decision\\":\\"block\\"}");',
      /wrote \d+B to stdout on import/,
    ],
    [
      'runs an unawaited top-level main() that reads stdin',
      // THE shape every hook uses, and the one the previous `process.exit(7)`
      // sentinel could not see: module evaluation completes immediately while
      // main() keeps reading stdin in the background. Deleting any hook's
      // direct-run guard produces exactly this module, so if this case ever
      // goes green the harness has stopped guarding the thing it is for.
      [
        'async function main() {',
        '  await new Promise((resolve) => { process.stdin.on("end", resolve); process.stdin.resume(); });',
        '}',
        'main().catch(() => {});',
      ].join('\n'),
      /import finished but the module still holds the event loop/,
    ],
  ];

  /** Deliberate blocks resolve immediately in principle — 2.5s is ample proof. */
  const FIXTURE_TIMEOUT_MS = 2500;

  it.each(CASES)('flags a module that %s', async (label, source, expected) => {
    const file = fixture(label.replace(/[^a-z0-9]+/gi, '-'), source);
    const { verdict, detail } = await probeImport(file, FIXTURE_TIMEOUT_MS);
    expect(verdict).toBe('FAIL');
    expect(detail).toMatch(expected);
  }, 60000);

  it('passes a module that is genuinely inert', async () => {
    // The control: without it, a probe that failed everything would satisfy
    // every case above and still be useless.
    const file = fixture('inert', 'export const noop = () => {};\n');
    const { verdict, detail } = await probeImport(file);
    expect(detail).toBe('');
    expect(verdict).toBe('PASS');
  }, 60000);

  it('passes a module whose main() is behind a direct-run guard', async () => {
    // The control for the case above, and the exact shape the hooks now use:
    // the SHIPPED helper, and main() left unawaited. Both details matter — a
    // fixture that inlined its own guard would keep passing after the real
    // helper broke, and one that wrote `await main()` would be a module shape
    // no hook has, which is how the previous version of this fixture managed
    // to certify a probe that could not see the production shape at all.
    const file = fixture('guarded', [
      `import { isMainEntry } from ${JSON.stringify(MAIN_ENTRY_URL)};`,
      'export async function main() {',
      '  await new Promise((resolve) => { process.stdin.on("end", resolve); process.stdin.resume(); });',
      '}',
      'if (isMainEntry(import.meta.url)) { main().catch(() => {}); }',
    ].join('\n'));
    const { verdict } = await probeImport(file);
    expect(verdict).toBe('PASS');
  }, 60000);
});
