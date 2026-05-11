/**
 * Phase 4 (VERIFY) MCP-verify integration tests.
 * Confirms backward compatibility (mcp omitted by default) and that
 * `options.mcpVerify === true` attaches a complete MCP directive.
 *
 * @see lib/autopilot/engine.js — runPhase4Verify
 * @see lib/autopilot/mcp-verifier.js — loadAllowList
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getStatus,
  runPhase4Verify,
  startAutopilot,
} from '../../lib/autopilot/index.js';
import { deleteSession } from '../../lib/autopilot/session-store.js';

const cleanup = [];
afterEach(() => {
  for (const sid of cleanup) {
    try { deleteSession(sid); } catch { /* ignore */ }
  }
  cleanup.length = 0;
});

describe('runPhase4Verify with mcpVerify', () => {
  it('default (no mcpVerify): instruction omits mcp field (backward compat)', async () => {
    const r = await startAutopilot({ task: 'no mcp', mode: 'plan' });
    cleanup.push(r.sessionId);
    const state = await getStatus(r.sessionId);
    const inst = runPhase4Verify(state);
    expect(inst.type).toBe('verify');
    expect(inst.command).toBe('npm run ci');
    expect(inst.mcp).toBeUndefined();
  });

  it('mcpVerify=true: instruction includes mcp field with allowList', async () => {
    const r = await startAutopilot({
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
    const r = await startAutopilot({
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
    const r1 = await startAutopilot({ task: 'no mcp', mode: 'plan' });
    cleanup.push(r1.sessionId);
    const r2 = await startAutopilot({
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
