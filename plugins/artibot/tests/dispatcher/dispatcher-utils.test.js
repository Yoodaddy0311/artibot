import { describe, expect, it } from 'vitest';
import {
  extractToolName,
  mergeResults,
  parseHookStdout,
} from '../../scripts/hooks/_dispatcher-utils.js';

describe('parseHookStdout', () => {
  it('returns null for empty / whitespace input', () => {
    expect(parseHookStdout('')).toBeNull();
    expect(parseHookStdout('   ')).toBeNull();
    expect(parseHookStdout('\n\n')).toBeNull();
  });

  it('returns null for unparseable JSON (never throws)', () => {
    expect(parseHookStdout('not json')).toBeNull();
    expect(parseHookStdout('{"unterminated":')).toBeNull();
  });

  it('parses valid JSON object', () => {
    expect(parseHookStdout('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('extractToolName', () => {
  it('reads .tool', () => {
    expect(extractToolName({ tool: 'Bash' })).toBe('Bash');
  });

  it('reads .tool_name as fallback', () => {
    expect(extractToolName({ tool_name: 'Edit' })).toBe('Edit');
  });

  it('reads .toolName camelCase as fallback', () => {
    expect(extractToolName({ toolName: 'Write' })).toBe('Write');
  });

  it('reads toolUse.name nested', () => {
    expect(extractToolName({ toolUse: { name: 'Read' } })).toBe('Read');
  });

  it('reads tool_use.name nested', () => {
    expect(extractToolName({ tool_use: { name: 'Grep' } })).toBe('Grep');
  });

  it('returns null for empty / non-object payloads', () => {
    expect(extractToolName(null)).toBeNull();
    expect(extractToolName(undefined)).toBeNull();
    expect(extractToolName('string')).toBeNull();
    expect(extractToolName({})).toBeNull();
  });
});

describe('mergeResults', () => {
  it('returns null for empty / all-null inputs', () => {
    expect(mergeResults([], 'X')).toBeNull();
    expect(mergeResults([null, null], 'X')).toBeNull();
    expect(mergeResults([undefined, 0, false], 'X')).toBeNull();
  });

  it('concatenates additionalContext from multiple hooks in order', () => {
    const merged = mergeResults(
      [
        { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'A' } },
        null,
        { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'B' } },
      ],
      'SessionStart',
    );
    expect(merged).not.toBeNull();
    expect(merged.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(merged.hookSpecificOutput.additionalContext).toBe('A\n\nB');
  });

  it('joins multiple message strings with newlines', () => {
    const merged = mergeResults(
      [{ message: 'one' }, { message: 'two' }],
      'SessionStart',
    );
    expect(merged.message).toBe('one\ntwo');
  });

  it('surfaces first decision=block with its reason', () => {
    const merged = mergeResults(
      [
        { decision: 'block', reason: 'first blocker' },
        { decision: 'block', reason: 'second blocker (should be ignored)' },
      ],
      'PostToolUse',
    );
    expect(merged.decision).toBe('block');
    expect(merged.reason).toBe('first blocker');
  });

  it('shallow-merges other top-level fields (last write wins)', () => {
    const merged = mergeResults(
      [{ continue: true, foo: 1 }, { foo: 2, bar: 3 }],
      'Stop',
    );
    expect(merged.continue).toBe(true);
    expect(merged.foo).toBe(2);
    expect(merged.bar).toBe(3);
  });

  it('skips non-object entries without crashing', () => {
    const merged = mergeResults(
      ['string', 42, null, { message: 'ok' }],
      'X',
    );
    expect(merged.message).toBe('ok');
  });

  it('ignores empty-string additionalContext (does not add blank separator)', () => {
    const merged = mergeResults(
      [
        { hookSpecificOutput: { hookEventName: 'X', additionalContext: '' } },
        { hookSpecificOutput: { hookEventName: 'X', additionalContext: 'real' } },
      ],
      'X',
    );
    expect(merged.hookSpecificOutput.additionalContext).toBe('real');
  });

  it('returns null when only blocker reason is empty and nothing else', () => {
    // Block result without reason still surfaces the decision.
    const merged = mergeResults([{ decision: 'block' }], 'X');
    expect(merged.decision).toBe('block');
    expect(typeof merged.reason).toBe('string');
  });
});
