import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  extractToolName,
  isMainEntry,
  mergeResults,
  parseHookStdout,
} from '../../scripts/hooks/_dispatcher-utils.js';
import { extractToolName as extractToolNameFromCore } from '../../lib/core/hook-utils.js';

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

  // v4.8.0 H-2: same function must back both import paths.
  it('is the same function as lib/core/hook-utils#extractToolName', () => {
    expect(extractToolName).toBe(extractToolNameFromCore);
  });

  it.each([
    [{ tool_name: 'Edit' }, 'Edit'],
    [{ tool: 'Bash' }, 'Bash'],
    [{ toolName: 'Write' }, 'Write'],
    [{ toolUse: { name: 'Read' } }, 'Read'],
    [{ tool_use: { name: 'Grep' } }, 'Grep'],
    [{}, null],
    [null, null],
  ])('both import paths produce identical result for %j', (input, expected) => {
    expect(extractToolName(input)).toBe(expected);
    expect(extractToolNameFromCore(input)).toBe(expected);
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

// ---------------------------------------------------------------------------
// isMainEntry — percent-encoding regression.
//
// Every dispatcher gates its main() on this helper, so a false negative here is
// not a wrong boolean: it is five dispatchers silently doing nothing when Claude
// Code spawns them. The old implementation compared `new URL(url).pathname` (a
// percent-ENCODED string) against `process.argv[1]` (a raw filesystem path), so
// it broke on any install path containing a space, a non-ASCII character, `~`
// (Windows 8.3 short names) or `#`.
//
// These cases run the helper in a REAL child process under a real directory of
// each shape, because that is the only way argv[1] and import.meta.url are
// produced the way production produces them. Constructing the two strings by
// hand in-process would test the test, not the hook.
// ---------------------------------------------------------------------------
describe('isMainEntry (path-encoding)', () => {
  // A long-form base: the OS temp dir is `…\HEECHA~1\…` on Windows, whose tilde
  // would itself trigger the bug and mask which case is under test.
  const BASE = path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'artibot-ime-test');

  const PROBE = [
    "import { isMainEntry } from %DUTILS%;",
    'process.stdout.write(JSON.stringify({ main: isMainEntry(import.meta.url) }));',
  ].join('\n');

  const DUTILS = pathToFileURL(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'scripts', 'hooks', '_dispatcher-utils.js',
  )).href;

  /** Write the probe into `<BASE>/<dirName>/probe.mjs`, run it, return its verdict. */
  function runProbeIn(dirName) {
    const dir = path.join(BASE, dirName);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'probe.mjs');
    writeFileSync(file, PROBE.replace('%DUTILS%', JSON.stringify(DUTILS)), 'utf8');
    const out = execFileSync(process.execPath, [file], { encoding: 'utf8' });
    return JSON.parse(out).main;
  }

  afterAll(() => rmSync(BASE, { recursive: true, force: true }));

  it.each([
    ['plain', 'plain'],
    ['a space', 'with space'],
    ['non-ASCII (Korean)', '바탕 화면'],
    ['a tilde (8.3 short name)', 'tilde~name'],
    ['a hash (URL fragment)', 'hash#tag'],
    ['parentheses', 'paren(1)'],
  ])('resolves true when the path contains %s', (_label, dirName) => {
    expect(runProbeIn(dirName)).toBe(true);
  });

  it('stays false when argv[1] is a different file in the same directory', () => {
    // The helper must not degrade into "same folder" matching while fixing the
    // encoding: identity is still the contract.
    const dir = path.join(BASE, 'with space');
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, 'other-entry.mjs');
    writeFileSync(probe, PROBE.replace('%DUTILS%', JSON.stringify(DUTILS)), 'utf8');
    const sibling = path.join(dir, 'sibling.mjs');
    writeFileSync(sibling, `await import(${JSON.stringify(pathToFileURL(probe).href)});`, 'utf8');

    const out = execFileSync(process.execPath, [sibling], { encoding: 'utf8' });
    expect(JSON.parse(out).main).toBe(false);
  });

  it('returns false rather than throwing on a malformed url', () => {
    expect(isMainEntry('not-a-url')).toBe(false);
    expect(isMainEntry(undefined)).toBe(false);
  });
});
