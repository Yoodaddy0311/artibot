/**
 * Unit tests for lib/autopilot/safety.js
 * Covers classifyRisk, parseDuration, shouldPause.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyRisk,
  parseDuration,
  shouldPause,
  pauseReason,
} from '../../lib/autopilot/safety.js';

describe('classifyRisk', () => {
  it('flags git push --force as danger', () => {
    const r = classifyRisk('git push --force origin main');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('git-force-push');
  });

  it('flags SQL DROP TABLE as danger', () => {
    const r = classifyRisk({ command: 'DROP TABLE users;' });
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('sql-drop-table');
  });

  it('returns safe for benign ls command', () => {
    const r = classifyRisk('ls -la /tmp');
    expect(r.level).toBe('safe');
  });

  it('flags curl http external as caution', () => {
    const r = classifyRisk('curl https://api.example.com/data');
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('curl-external');
  });

  it('flags rm -rf with broad glob as danger', () => {
    const r = classifyRisk('rm -rf *');
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe('rm-rf-broad');
  });
});

describe('parseDuration', () => {
  it('parses 4h as 4 hours in ms', () => {
    expect(parseDuration('4h')).toBe(4 * 3_600_000);
  });

  it('parses 30m as 30 minutes in ms', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
  });

  it('parses 2h as 2 hours in ms', () => {
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
  });

  it('returns null for unparseable input', () => {
    expect(parseDuration('hello')).toBeNull();
  });
});

describe('shouldPause', () => {
  it('triggers when buildFailures >= 3', () => {
    const state = { counters: { buildFailures: 3, testFailures: 0 } };
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('build-failures-threshold');
  });

  it('does not trigger at buildFailures 2', () => {
    const state = { counters: { buildFailures: 2, testFailures: 0 } };
    expect(shouldPause(state)).toBe(false);
  });

  it('triggers when testFailures >= 5', () => {
    const state = { counters: { buildFailures: 0, testFailures: 5 } };
    expect(shouldPause(state)).toBe(true);
    expect(pauseReason(state)).toBe('test-failures-threshold');
  });

  it('does not trigger at testFailures 4', () => {
    const state = { counters: { buildFailures: 0, testFailures: 4 } };
    expect(shouldPause(state)).toBe(false);
  });
});
