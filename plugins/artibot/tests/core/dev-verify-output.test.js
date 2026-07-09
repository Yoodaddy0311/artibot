import { describe, expect, it } from 'vitest';
import {
  buildDevVerifyOutput,
  DEFAULT_DEV_VERIFY_MODE,
  DEV_VERIFY_MODES,
  resolveDevVerifyMode,
} from '../../lib/core/dev-verify-output.js';

/**
 * Regression tests for lib/core/dev-verify-output.js — the mode/version-shaping
 * layer behind the DEV-verify Stop gate (Task #12, 2.1.163 migration).
 *
 * Covers:
 *   - mode resolution precedence (env > config > default)
 *   - malformed/unknown values fall back to the safe default
 *   - enforce mode emits the always-supported block shape
 *   - advisory mode emits the 2.1.163 additionalContext shape
 *   - Stop vs SubagentStop event name is echoed in advisory output
 */

const REASON = 'Run the DEV verify checklist before finalising.';

describe('resolveDevVerifyMode', () => {
  it('defaults to enforce when nothing is set', () => {
    expect(resolveDevVerifyMode({}, {})).toBe('enforce');
    expect(DEFAULT_DEV_VERIFY_MODE).toBe('enforce');
  });

  it('honors config.devProtocol.verifyMode', () => {
    expect(resolveDevVerifyMode({ devProtocol: { verifyMode: 'advisory' } }, {})).toBe('advisory');
    expect(resolveDevVerifyMode({ devProtocol: { verifyMode: 'enforce' } }, {})).toBe('enforce');
  });

  it('lets the env override win over config', () => {
    const config = { devProtocol: { verifyMode: 'enforce' } };
    const env = { ARTIBOT_DEV_VERIFY_MODE: 'advisory' };
    expect(resolveDevVerifyMode(config, env)).toBe('advisory');
  });

  it('falls back to default on unknown env value', () => {
    expect(resolveDevVerifyMode({}, { ARTIBOT_DEV_VERIFY_MODE: 'bogus' })).toBe('enforce');
  });

  it('falls back to default on unknown config value', () => {
    expect(resolveDevVerifyMode({ devProtocol: { verifyMode: 'loud' } }, {})).toBe('enforce');
  });

  it('tolerates missing/garbage inputs defensively', () => {
    expect(resolveDevVerifyMode(undefined, {})).toBe('enforce');
    expect(resolveDevVerifyMode(null, {})).toBe('enforce');
    expect(DEV_VERIFY_MODES).toContain('enforce');
    expect(DEV_VERIFY_MODES).toContain('advisory');
  });
});

describe('buildDevVerifyOutput', () => {
  it('enforce mode (default) emits the always-supported block shape', () => {
    const out = buildDevVerifyOutput(REASON);
    expect(out).toEqual({ decision: 'block', reason: REASON });
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it('enforce mode is explicit-safe', () => {
    const out = buildDevVerifyOutput(REASON, { mode: 'enforce' });
    expect(out.decision).toBe('block');
    expect(out.reason).toBe(REASON);
  });

  it('advisory mode emits non-blocking additionalContext (no decision:block)', () => {
    const out = buildDevVerifyOutput(REASON, { mode: 'advisory' });
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'Stop',
      additionalContext: REASON,
    });
  });

  it('advisory mode suppresses transcript output; enforce mode stays visible', () => {
    expect(buildDevVerifyOutput(REASON, { mode: 'advisory' }).suppressOutput).toBe(true);
    expect(buildDevVerifyOutput(REASON, { mode: 'enforce' }).suppressOutput).toBeUndefined();
  });

  it('advisory mode echoes SubagentStop when provided', () => {
    const out = buildDevVerifyOutput(REASON, { mode: 'advisory', hookEventName: 'SubagentStop' });
    expect(out.hookSpecificOutput.hookEventName).toBe('SubagentStop');
    expect(out.hookSpecificOutput.additionalContext).toBe(REASON);
  });

  it('enforce mode ignores hookEventName (block carries no event envelope)', () => {
    const out = buildDevVerifyOutput(REASON, { mode: 'enforce', hookEventName: 'SubagentStop' });
    expect(out).toEqual({ decision: 'block', reason: REASON });
  });
});
