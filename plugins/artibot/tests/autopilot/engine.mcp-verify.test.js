/**
 * Phase 4 (VERIFY) MCP-verify integration tests.
 * Confirms backward compatibility (mcp omitted by default) and that
 * `options.mcpVerify === true` attaches a complete MCP directive.
 *
 * @see lib/autopilot/engine.js — runPhase4Verify
 * @see lib/autopilot/mcp-verifier.js — loadAllowList
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getStatus,
  runPhase4Verify,
  startAutopilot,
} from '../../lib/autopilot/index.js';
import { deleteSession } from '../../lib/autopilot/session-store.js';

// ARTIFACT ISOLATION CONTRACT: startAutopilot writes a PRD under
// <projectRoot>/docs/PRD/. Without options.projectRoot that is the operator's
// real checkout. See engine.test.js for the same guard.
let ARTIFACT_ROOT = '';

beforeAll(() => {
  ARTIFACT_ROOT = mkdtempSync(path.join(os.tmpdir(), 'artibot-mcpverify-artifacts-'));
});

afterAll(() => {
  try { rmSync(ARTIFACT_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * startAutopilot with the artifact-isolation override applied.
 * @param {object} args - Same shape as startAutopilot.
 * @returns {Promise<object>}
 */
function start(args) {
  return startAutopilot({
    ...args,
    options: { ...(args.options || {}), projectRoot: ARTIFACT_ROOT },
  });
}

const cleanup = [];
afterEach(() => {
  for (const sid of cleanup) {
    try { deleteSession(sid); } catch { /* ignore */ }
  }
  cleanup.length = 0;
});

describe('runPhase4Verify with mcpVerify', () => {
  it('default (no mcpVerify): instruction omits mcp field (backward compat)', async () => {
    const r = await start({ task: 'no mcp', mode: 'plan' });
    cleanup.push(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase4Verify(state);
    expect(inst.type).toBe('verify');
    expect(inst.command).toBe('npm run ci');
    expect(inst.mcp).toBeUndefined();
  });

  it('mcpVerify=true: instruction includes mcp field with allowList', async () => {
    const r = await start({
      task: 'with mcp',
      mode: 'plan',
      options: { mcpVerify: true },
    });
    cleanup.push(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase4Verify(state);
    expect(inst.mcp).toBeTruthy();
    expect(inst.mcp.enabled).toBe(true);
    expect(Array.isArray(inst.mcp.allowList)).toBe(true);
    expect(inst.mcp.allowedPrefix).toBe('plugin:artibot:');
  });

  it('mcpVerify=true: state.verifyResult.mcp slot initialized', async () => {
    const r = await start({
      task: 'verify slot',
      mode: 'plan',
      options: { mcpVerify: true },
    });
    cleanup.push(r.sessionId);
    const state = await getStatus(r.sessionId);
    runPhase4Verify(state);
    // Phase 4 mutates state in-memory then session-store writes to disk.
    // Under full-suite Windows worker saturation that file write can lag
    // the JS turn that re-reads via getStatus (1/11 reproduction in the
    // v4.5.10 verification matrix). Poll until disk reflects the write.
    // v4.5.11 hotfix.
    await vi.waitFor(
      async () => {
        const after = await getStatus(r.sessionId);
        expect(after.verifyResult).toBeTruthy();
        expect(after.verifyResult.mcp).toBeDefined();
        expect(after.verifyResult.mcp.violations).toEqual([]);
      },
      { timeout: 3000, interval: 50 },
    );
  });

  it('npm run ci command unchanged regardless of mcpVerify (backward compat)', async () => {
    const r1 = await start({ task: 'no mcp', mode: 'plan' });
    cleanup.push(r1.sessionId);
    const r2 = await start({
      task: 'with mcp',
      mode: 'plan',
      options: { mcpVerify: true },
    });
    cleanup.push(r2.sessionId);
    const i1 = runPhase4Verify(await getStatus(r1.sessionId));
    const i2 = runPhase4Verify(await getStatus(r2.sessionId));
    expect(i1.command).toBe(i2.command);
    expect(i1.command).toBe('npm run ci');
  });
});
