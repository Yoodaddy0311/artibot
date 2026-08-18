/**
 * Real-process signal safety for withFileLock (PRD A3).
 *
 * Unit tests cannot establish this: they run in the vitest process, where
 * `process.kill(self)` would take the runner down and where a mocked `node:fs`
 * proves nothing about a real `.lock` file surviving a real signal. Every
 * assertion here observes a genuine child process — its exit status and the
 * lock file it left on disk.
 *
 * Platform note: Windows has no POSIX signal delivery. `child.kill('SIGTERM')`
 * maps to TerminateProcess, which kills unconditionally without running the
 * child's handler, so the OS-delivery case is skipped there and covered by CI's
 * Linux leg. The handler-path case below runs everywhere.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_MODULE = pathToFileURL(
  path.join(HERE, '..', '..', 'lib', 'core', 'file-lock.js'),
).href;

const isWindows = process.platform === 'win32';

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `artibot-locksig-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Write a child script into the temp dir and return its path.
 *
 * @param {string} name
 * @param {string} source
 * @returns {Promise<string>}
 */
async function writeChild(name, source) {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, source, 'utf-8');
  return file;
}

/**
 * Run a child to completion, optionally acting once it signals readiness by
 * creating `readyMarker`.
 *
 * @param {string} script - Child script path.
 * @param {string[]} args - Extra argv.
 * @param {{ readyMarker?: string, onReady?: (child: any) => void }} [opts]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string }>}
 */
function runChild(script, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });

    let poll;
    if (opts.readyMarker && opts.onReady) {
      poll = setInterval(() => {
        if (fsSync.existsSync(opts.readyMarker)) {
          clearInterval(poll);
          poll = undefined;
          opts.onReady(child);
        }
      }, 20);
    }

    child.on('error', (err) => {
      if (poll) clearInterval(poll);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (poll) clearInterval(poll);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('withFileLock signal safety (real process)', () => {
  it.skipIf(isWindows)(
    'releases the lock and dies of the signal when SIGTERM arrives mid-lock',
    async () => {
      const target = path.join(tmpDir, 'state.json');
      const lockPath = `${target}.lock`;
      const ready = path.join(tmpDir, 'ready');

      const script = await writeChild('sigterm-child.mjs', `
import { writeFileSync } from 'node:fs';
import { withFileLock } from ${JSON.stringify(LOCK_MODULE)};

withFileLock(${JSON.stringify(target)}, () => {
  // Announce readiness from *inside* the lock, then stay inside it long
  // enough for the parent's signal to land while the lock is held.
  writeFileSync(${JSON.stringify(ready)}, 'held');
  const until = Date.now() + 2000;
  while (Date.now() < until) { /* the module's own busy-wait shape */ }
});
console.log('lock-released');
setTimeout(() => console.log('SURVIVED'), 1500);
`);

      const result = await runChild(script, [], {
        readyMarker: ready,
        onReady: (child) => setTimeout(() => child.kill('SIGTERM'), 100),
      });

      // The lock file must not outlive the process.
      expect(fsSync.existsSync(lockPath)).toBe(false);
      // The signal must still kill it — swallowing SIGTERM would be a
      // regression, so assert a signal death rather than a normal exit.
      expect(result.signal).toBe('SIGTERM');
      expect(result.code).toBeNull();
      expect(result.stdout).not.toContain('SURVIVED');
    },
    30_000,
  );

  it('handler unlinks a held lock and re-raises rather than exiting cleanly', async () => {
    // Delivers the signal from inside the locked section, which is the only way
    // to reach the handler while the active-lock set is non-empty (the locked
    // body is synchronous, so a real signal is never delivered mid-body). This
    // exercises the handler's unlink branch on every platform, Windows included.
    const target = path.join(tmpDir, 'emit.json');
    const lockPath = `${target}.lock`;

    const script = await writeChild('emit-child.mjs', `
import { existsSync } from 'node:fs';
import { withFileLock } from ${JSON.stringify(LOCK_MODULE)};

withFileLock(${JSON.stringify(target)}, () => {
  if (!existsSync(${JSON.stringify(lockPath)})) {
    console.log('LOCK-MISSING');
    process.exit(9);
  }
  process.emit('SIGTERM');
  // Only reached if the handler failed to re-raise.
  console.log('HANDLER-DID-NOT-KILL');
});
console.log('RETURNED-NORMALLY');
`);

    const result = await runChild(script, []);

    expect(result.stdout).not.toContain('LOCK-MISSING');
    expect(result.stdout).not.toContain('HANDLER-DID-NOT-KILL');
    expect(result.stdout).not.toContain('RETURNED-NORMALLY');
    // The handler removed the lock before re-raising.
    expect(fsSync.existsSync(lockPath)).toBe(false);
    // Whatever the platform maps the re-raise to, it must not be a clean exit.
    expect(result.code).not.toBe(0);
  }, 30_000);

  it('leaves no lock behind on a normal (unsignalled) run', async () => {
    const target = path.join(tmpDir, 'plain.json');
    const script = await writeChild('plain-child.mjs', `
import { withFileLock } from ${JSON.stringify(LOCK_MODULE)};
const v = withFileLock(${JSON.stringify(target)}, () => 'done');
console.log(v);
`);

    const result = await runChild(script, []);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('done');
    expect(fsSync.existsSync(`${target}.lock`)).toBe(false);
  }, 30_000);
});
