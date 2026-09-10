/**
 * Unit tests for lib/autopilot/safety.js
 * Covers classifyRisk, parseDuration, shouldPause.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRisk,
  parseDuration,
  pauseReason,
  shouldPause,
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

describe('classifyRisk — L1 parity for discard-class git commands', () => {
  it.each([
    ['git checkout .', 'git-checkout-discard'],
    ['git checkout -- .', 'git-checkout-discard'],
    ['git checkout . && npm test', 'git-checkout-discard'],
    ['git restore .', 'git-restore-discard'],
    ['git restore -- .', 'git-restore-discard'],
    ['git stash drop', 'git-stash-drop'],
    ['git stash drop stash@{0}', 'git-stash-drop'],
    ['git stash clear', 'git-stash-drop'],
  ])('grades %s as danger via %s', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(matchedId);
  });

  it.each([
    'git checkout main',
    'git checkout -b feat/x',
    'git checkout ./src/file.js',
    'git restore --staged file.js',
    'git restore src/file.js',
    'git stash list',
    'git stash pop',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });
});

describe('classifyRisk — scoped recursive delete is caution', () => {
  it.each([
    'rm -rf ./build',
    'rm -rf build',
    'rm -fr dist',
    'rm -rf node_modules/.cache',
    'rm -rfv dist',
    'rm -r -f dist',
    'rm -f -r dist',
    'rm --recursive --force dist',
    'rm -rf -- build',
  ])('grades %s as caution via rm-rf-path', (command) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('caution');
    expect(r.matchedId).toBe('rm-rf-path');
  });

  it.each([
    'rm -f file.txt',
    'rm -r dir',
    'rm -rv dir',
    'rm --recursive dir',
    'rm --force file.txt',
    'rm -f /',
    'rm /tmp/file.txt',
    'ls -la /tmp',
  ])('leaves %s safe', (command) => {
    expect(classifyRisk(command).level).toBe('safe');
  });

  it.each([
    ['rm -rf /', 'rm-rf-root'],
    ['rm -rf ~/x', 'rm-rf-root'],
    ['rm -rf $HOME/x', 'rm-rf-root'],
    ['rm -fr /', 'rm-rf-root'],
    ['rm -r /', 'rm-rf-root'],
    ['rm -rfv /', 'rm-rf-root'],
    ['rm -r -f /', 'rm-rf-root'],
    ['rm -f -r /', 'rm-rf-root'],
    ['rm --recursive --force /', 'rm-rf-root'],
    ['rm -rf -- /', 'rm-rf-root'],
    ['rm -rv /', 'rm-rf-root'],
    ['rm -rfv ~/x', 'rm-rf-root'],
    ['rm -r -f $HOME', 'rm-rf-root'],
    ['rm -rf *', 'rm-rf-broad'],
    ['rm -fr *', 'rm-rf-broad'],
    ['rm -rfv *', 'rm-rf-broad'],
    ['rm -r -f *', 'rm-rf-broad'],
    ['rm --recursive --force *', 'rm-rf-broad'],
  ])('keeps %s at danger via %s (root/glob rules win over rm-rf-path)', (command, matchedId) => {
    const r = classifyRisk(command);
    expect(r.level).toBe('danger');
    expect(r.matchedId).toBe(matchedId);
  });
});

describe('classifyRisk — option-run scanning is linear', () => {
  /** @param {string} command @returns {number} elapsed ms */
  function timeClassify(command) {
    const started = performance.now();
    classifyRisk(command);
    return performance.now() - started;
  }

  // The rm rules scan an option run before the target. If a run of long
  // options can be split more than one way, a non-matching tail costs 2^n.
  // bash-risk-guard.js runs inside a 5s PreToolUse hook, so a blow-up here
  // silently deletes the L2 verdict instead of failing loudly.
  it('stays linear on long option runs', () => {
    // 26 first: it is the largest size the exponential form still finishes
    // fast enough to report a failure rather than hang the suite.
    expect(timeClassify(`rm ${'--opt '.repeat(26)}x`)).toBeLessThan(50);
    expect(timeClassify(`rm ${'--opt '.repeat(40)}x`)).toBeLessThan(50);
    expect(timeClassify(`rm ${'--opt '.repeat(2000)}/`)).toBeLessThan(50);
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
