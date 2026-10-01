import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assistantEntryText,
  readLastAssistantEntry,
  reviewerModel,
  TRANSCRIPT_TAIL_BYTES,
} from '../../lib/review/stop-transcript.js';

/**
 * `lib/review/stop-transcript.js` — the reviewer's final answer from a bounded
 * transcript tail. MOVED VERBATIM out of `scripts/hooks/_review-stop-record.js` (which
 * stood at 798 of 800 lines); the hook's own suites
 * (`tests/hooks/subagent-handler-review-writer.test.js`, sections 8-9) still drive it
 * through a real child process. Those runs are not instrumented, so this file
 * exercises the module in-process, one behaviour per case, and pins the parts the
 * move must not have changed: a LAST-of-a-KIND scan, a window that drops the line
 * it cuts, and a reader that never throws.
 *
 * WHAT GREEN HERE DOES NOT PROVE: that a real host transcript has these line shapes
 * (the fixtures are the ones the hook suites use), or how long a read of a transcript
 * near the window size takes on a real disk.
 */

let tmp;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-stop-transcript-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

const assistant = (content, model = 'claude-opus-5-5') => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', content, ...(model === null ? {} : { model }) },
});
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
function transcript(lines, name = 't.jsonl') {
  const file = path.join(tmp, name);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
}

describe('TRANSCRIPT_TAIL_BYTES', () => {
  it('is 8 MiB, the bound the hook suites restate on purpose', () => {
    expect(TRANSCRIPT_TAIL_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('readLastAssistantEntry', () => {
  it('returns the LAST assistant entry, not the last line', () => {
    const file = transcript([
      user('go'),
      assistant([{ type: 'text', text: 'first' }]),
      assistant([{ type: 'text', text: 'final' }]),
      JSON.stringify({ type: 'summary', summary: 'done' }),
      user('thanks'),
    ]);
    expect(assistantEntryText(readLastAssistantEntry(file))).toBe('final');
  });

  it('skips a torn trailing line and an assistant line with no message', () => {
    const file = transcript([
      assistant([{ type: 'text', text: 'whole' }]),
      JSON.stringify({ type: 'assistant' }),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"tor',
    ]);
    expect(assistantEntryText(readLastAssistantEntry(file))).toBe('whole');
  });

  it.each([
    ['a missing file', () => path.join(tmp, 'nope.jsonl')],
    ['an empty path', () => ''],
    ['a path that is not a string', () => undefined],
    ['an empty file', () => { const f = path.join(tmp, 'empty.jsonl'); writeFileSync(f, '', 'utf-8'); return f; }],
    ['garbage', () => transcript(['not json', '{"type":"assistant"', '[1,2]'], 'garbage.jsonl')],
    ['a DIRECTORY', () => tmp],
  ])('never throws, and finds nothing in %s', (_label, make) => {
    expect(readLastAssistantEntry(make())).toBeNull();
  });

  it('reads a transcript larger than the window from its tail and still finds the last answer', () => {
    const pad = user('x'.repeat(1024 * 1024));
    const file = transcript([
      ...Array.from({ length: 9 }, () => pad),
      assistant([{ type: 'text', text: 'tail answer' }]),
      JSON.stringify({ type: 'summary', summary: 'done' }),
    ], 'big.jsonl');
    expect(assistantEntryText(readLastAssistantEntry(file))).toBe('tail answer');
  });

  it('drops the window\'s truncated first line even when that fragment parses as an assistant entry', () => {
    // The window's FIRST BYTE is the `{` that opens a decoy assistant object at the end of a longer line.
    const decoy = assistant([{ type: 'text', text: 'decoy' }]);
    const padLine = `${'y'.repeat(2000)}${decoy}`;
    // From the decoy's `{` to the end of the file: decoy + "\n" + rest + "\n" = exactly one window.
    const overhead = Buffer.byteLength(user(''));
    const rest = user('z'.repeat(TRANSCRIPT_TAIL_BYTES - Buffer.byteLength(decoy) - 2 - overhead));
    const file = transcript([padLine, rest], 'decoy.jsonl');
    expect(readLastAssistantEntry(file)).toBeNull();
  });
});

describe('assistantEntryText', () => {
  it.each([
    ['a string content', { message: { content: 'plain' } }, 'plain'],
    ['text blocks joined with a newline', { message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }, 'a\nb'],
    ['tool and thinking blocks dropped', { message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'thinking', thinking: 'x' }, { type: 'text', text: 'ok' }] } }, 'ok'],
  ])('%s', (_label, entry, expected) => {
    expect(assistantEntryText(entry)).toBe(expected);
  });

  it.each([
    [null], [undefined], [{}], [{ message: {} }], [{ message: { content: '   ' } }],
    [{ message: { content: [] } }], [{ message: { content: [{ type: 'text', text: '  ' }] } }],
    [{ message: { content: [{ type: 'tool_use' }] } }], [{ message: { content: 7 } }],
  ])('%j carries no answer -> null', (entry) => {
    expect(assistantEntryText(entry)).toBeNull();
  });
});

describe('reviewerModel', () => {
  it.each([
    [{ message: { model: 'claude-opus-5-5' } }, 'claude-opus-5-5'],
    [{ message: { model: '  ' } }, null],
    [{ message: { model: 7 } }, null],
    [{ message: {} }, null],
    [null, null],
  ])('%j -> %s', (entry, expected) => {
    expect(reviewerModel(entry)).toBe(expected);
  });
});
