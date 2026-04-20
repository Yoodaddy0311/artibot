import { describe, expect, it } from 'vitest';
import { matchesAllowEntry } from '../../scripts/hooks/permission-auto-approve.js';

describe('matchesAllowEntry/edge cases', () => {
  it('null entry → false', () => {
    expect(matchesAllowEntry(null, 'Bash', {})).toBe(false);
  });

  it('non-object entry → false', () => {
    expect(matchesAllowEntry('Bash', 'Bash', {})).toBe(false);
    expect(matchesAllowEntry(42, 'Bash', {})).toBe(false);
  });

  it('빈 entry {} → 모두 매치 (와일드카드)', () => {
    expect(matchesAllowEntry({}, 'Bash', {})).toBe(true);
    expect(matchesAllowEntry({}, 'Edit', { file_path: '/tmp/x' })).toBe(true);
  });
});

describe('matchesAllowEntry/tool matching', () => {
  it('정확한 tool 매치', () => {
    expect(matchesAllowEntry({ tool: 'Bash' }, 'Bash', {})).toBe(true);
    expect(matchesAllowEntry({ tool: 'Bash' }, 'Edit', {})).toBe(false);
  });

  it('와일드카드 tool=*', () => {
    expect(matchesAllowEntry({ tool: '*' }, 'Bash', {})).toBe(true);
    expect(matchesAllowEntry({ tool: '*' }, 'Read', {})).toBe(true);
  });
});

describe('matchesAllowEntry/regex command match', () => {
  it('regex 매치 → true', () => {
    const e = { tool: 'Bash', commandPattern: '^npm (install|test)' };
    expect(matchesAllowEntry(e, 'Bash', { command: 'npm test' })).toBe(true);
    expect(matchesAllowEntry(e, 'Bash', { command: 'npm install' })).toBe(true);
  });

  it('regex 미매치 → false', () => {
    const e = { tool: 'Bash', commandPattern: '^npm test$' };
    expect(matchesAllowEntry(e, 'Bash', { command: 'rm -rf /' })).toBe(false);
  });

  it('Edit 도구는 file_path로 매치', () => {
    const e = { tool: 'Edit', commandPattern: '\\.test\\.js$' };
    expect(matchesAllowEntry(e, 'Edit', { file_path: 'x.test.js' })).toBe(true);
    expect(matchesAllowEntry(e, 'Edit', { file_path: 'x.js' })).toBe(false);
  });

  it('잘못된 regex 패턴 → false (안전 fallback)', () => {
    const e = { tool: 'Bash', commandPattern: '[invalid(' };
    expect(matchesAllowEntry(e, 'Bash', { command: 'anything' })).toBe(false);
  });

  it('command/file_path 둘 다 없음 → 빈 문자열로 처리, 패턴 미매치', () => {
    const e = { tool: 'Bash', commandPattern: '.+' };
    expect(matchesAllowEntry(e, 'Bash', {})).toBe(false);
  });

  it('non-string command → false', () => {
    const e = { tool: 'Bash', commandPattern: '.+' };
    expect(matchesAllowEntry(e, 'Bash', { command: 123 })).toBe(false);
  });
});
