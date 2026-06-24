import { describe, expect, it } from 'vitest';
import { claudeHasText, contentText, slimLines, slimRaw } from '../../lib/learning/ledger/slim.js';

// JSONL line builders mirroring the claude-code transcript schema.
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const asstLine = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolLine = () =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] } });
const thinkingLine = () =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', text: 'reasoning' }] } });
const metaLine = (text) => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: text } });

describe('slim — conversation denoise (F-02)', () => {
  it('keeps user/assistant text lines verbatim', () => {
    const lines = [userLine('hello'), asstLine('hi there')];
    expect(slimLines(lines)).toEqual(lines);
  });

  it('AC1: excludes tool_use and thinking lines', () => {
    const lines = [userLine('q'), toolLine(), thinkingLine(), asstLine('a')];
    expect(slimLines(lines)).toEqual([userLine('q'), asstLine('a')]);
  });

  it('AC2: excludes isMeta lines (e.g. /context dumps)', () => {
    const lines = [userLine('real'), metaLine('/context huge dump')];
    expect(slimLines(lines)).toEqual([userLine('real')]);
  });

  it('AC3: returns empty (no verbatim fallback) when no conversation line', () => {
    expect(slimLines([toolLine(), thinkingLine()])).toEqual([]);
    expect(slimRaw('not json\n{bad')).toEqual([]);
  });

  it('skips blank and unparseable lines', () => {
    expect(slimLines(['', '  ', 'xxx', userLine('ok')])).toEqual([userLine('ok')]);
  });

  it('contentText extracts text blocks only', () => {
    expect(contentText('plain')).toBe('plain');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(contentText([{ type: 'tool_use' }])).toBe('');
  });

  it('claudeHasText rejects non-conversation objects', () => {
    expect(claudeHasText({ type: 'system' })).toBe(false);
    expect(claudeHasText({ type: 'user', isMeta: true, message: { content: 'x' } })).toBe(false);
    expect(claudeHasText(null)).toBe(false);
    expect(claudeHasText({ type: 'user', message: { content: '' } })).toBe(false);
  });

  it('slimLines tolerates non-array / non-string input', () => {
    expect(slimLines(null)).toEqual([]);
    expect(slimLines([42, userLine('ok')])).toEqual([userLine('ok')]);
    expect(slimRaw('')).toEqual([]);
  });
});
