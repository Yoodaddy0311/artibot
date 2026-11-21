import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateAgentIndex } from '../../scripts/generate-agent-index.js';

/**
 * scripts/generate-agent-index.js#generateAgentIndex — the write outcome.
 *
 * `scripts/utils/index.js#atomicWriteSync` stopped throwing in the 2026-11-21
 * review (M4) and answers false instead. The generator ignored the return value,
 * so a write that never landed still printed "wrote N agents" (xcA LOW). These
 * cases pin that a false answer is reported as "failed:" and the function
 * answers false.
 *
 * What this does NOT see: the CLI's exit code (main() always exits 0, the same
 * as before — a soft-fail script by design) and the real agents/INDEX.md (the
 * outPath override keeps the shared tree untouched). The registry read is real.
 */

let dir;
let out;
let err;
let outSpy;
let errSpy;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'artibot-agent-index-'));
  out = [];
  err = [];
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err.push(String(c)); return true; });
});

afterEach(() => {
  outSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('generateAgentIndex', () => {
  it('writes the index and reports "wrote" when the destination is writable', async () => {
    const outPath = path.join(dir, 'agents', 'INDEX.md');

    const ok = await generateAgentIndex({ outPath });

    expect(ok).toBe(true);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8')).toMatch(/^# Artibot Agent Index/);
    expect(out.join('')).toMatch(/\[generate-agent-index\] wrote \d+ agents to /);
    expect(err.join('')).not.toContain('failed:');
  });

  it('reports "failed:" and answers false when the write does not land (destination is a directory)', async () => {
    // A directory at the destination makes the final rename fail on every
    // platform, so atomicWriteSync answers false after its retries.
    const outPath = path.join(dir, 'INDEX.md');
    mkdirSync(outPath);

    const ok = await generateAgentIndex({ outPath });

    expect(ok).toBe(false);
    expect(err.join('')).toContain('[generate-agent-index] failed:');
    expect(out.join('')).not.toContain('wrote');
  });
});
