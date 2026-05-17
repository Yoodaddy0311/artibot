/**
 * Unit tests for lib/autopilot/_engine-helpers.js — preflight integration.
 *
 * Covers buildPreflightInstruction (ok/warn/error branches) and
 * renderPreflightSummary (GFM table form).
 */

import { describe, expect, it } from 'vitest';
import {
  buildPreflightInstruction,
  renderPreflightSummary,
} from '../../lib/autopilot/_engine-helpers.js';

describe('buildPreflightInstruction', () => {
  it('returns null when result is ok with no warnings', () => {
    const r = buildPreflightInstruction({ ok: true, errors: [], warnings: [], checks: [] });
    expect(r).toBeNull();
  });

  it('returns null when input is undefined or malformed', () => {
    expect(buildPreflightInstruction(undefined)).toBeNull();
    expect(buildPreflightInstruction(null)).toBeNull();
    expect(buildPreflightInstruction('not-an-object')).toBeNull();
  });

  it('returns blocking PushNotification when errors exist', () => {
    const result = {
      ok: false,
      errors: [
        { check: 'lockFree', severity: 'error', message: 'held by pid=99' },
        { check: 'diskSpace', severity: 'error', message: '100MB free' },
      ],
      warnings: [],
      checks: [],
    };
    const r = buildPreflightInstruction(result);
    expect(r.tool).toBe('PushNotification');
    expect(r.abort).toBe(true);
    expect(r.suppress).toBe(false);
    expect(r.params.title).toMatch(/pre-flight/i);
    expect(r.params.message).toMatch(/lockFree/);
    expect(r.params.message).toMatch(/diskSpace/);
    expect(r.summary).toMatch(/2 hard fail/);
  });

  it('returns suppressed notice when only warnings exist', () => {
    const result = {
      ok: true,
      errors: [],
      warnings: [{ check: 'gitClean', severity: 'warn', message: '3 dirty paths' }],
      checks: [],
    };
    const r = buildPreflightInstruction(result);
    expect(r.tool).toBeNull();
    expect(r.suppress).toBe(true);
    expect(r.abort).toBe(false);
    expect(r.summary).toMatch(/1 warning/);
    expect(r.summary).toMatch(/gitClean/);
  });

  it('tolerates missing arrays', () => {
    const r = buildPreflightInstruction({ ok: false });
    // No errors array → falls through to warnings-only path with empty checks list.
    // But ok=false AND no errors AND no warnings → first branch returns null only when ok=true.
    // Since ok=false, errors=[] (defaulted), warnings=[] (defaulted): error branch is skipped,
    // and we enter warnings-only path producing an empty-checks notice.
    expect(r).not.toBeNull();
    expect(r.tool).toBeNull();
    expect(r.suppress).toBe(true);
  });
});

describe('renderPreflightSummary', () => {
  it('renders a GFM pipe table with 3 columns', () => {
    const out = renderPreflightSummary({
      checks: [
        { name: 'gitClean', status: 'pass' },
        { name: 'lockFree', status: 'fail', detail: 'held by pid=12' },
      ],
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('| Check | Status | Detail |');
    expect(lines[1]).toBe('| --- | --- | --- |');
    expect(lines[2]).toBe('| gitClean | pass |  |');
    expect(lines[3]).toBe('| lockFree | fail | held by pid=12 |');
  });

  it('renders a placeholder row when checks array is empty', () => {
    const out = renderPreflightSummary({ checks: [] });
    expect(out).toMatch(/no checks/);
  });

  it('escapes pipe characters in detail strings', () => {
    const out = renderPreflightSummary({
      checks: [{ name: 'gitClean', status: 'warn', detail: 'a|b|c' }],
    });
    expect(out).toContain('a\\|b\\|c');
  });

  it('handles malformed input gracefully', () => {
    const out = renderPreflightSummary({});
    expect(out).toMatch(/no checks/);
    const out2 = renderPreflightSummary(null);
    expect(out2).toMatch(/no checks/);
  });
});
