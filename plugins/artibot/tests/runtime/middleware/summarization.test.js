import { describe, expect, it } from 'vitest';
import { createSummarizationMiddleware } from '../../../lib/runtime/middleware/summarization.js';

function makeState(prompt = 'short prompt') {
  return {
    userPrompt: prompt,
    context: {},
    messageParts: [],
  };
}

describe('middleware/summarization', () => {
  it('짧은 프롬프트 → shouldCompact=false', async () => {
    const mw = createSummarizationMiddleware();
    const state = makeState('fix typo');
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(false);
    expect(result.context.summarization.promptLength).toBe('fix typo'.length);
    expect(result.context.summarization.compactThresholdChars).toBe(1800);
    expect(result.messageParts).not.toContain('compact=1');
  });

  it('긴 프롬프트 → shouldCompact=true', async () => {
    const longPrompt = 'x'.repeat(2000);
    const mw = createSummarizationMiddleware();
    const state = makeState(longPrompt);
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(true);
    expect(result.context.summarization.promptLength).toBe(2000);
    expect(result.messageParts).toContain('compact=1');
  });

  it('커스텀 threshold 적용', async () => {
    const mw = createSummarizationMiddleware({ compactThresholdChars: 10 });
    const state = makeState('short but over 10');
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(true);
    expect(result.context.summarization.compactThresholdChars).toBe(10);
  });

  it('threshold 경계값 (정확히 threshold 길이)', async () => {
    const mw = createSummarizationMiddleware({ compactThresholdChars: 5 });
    const state = makeState('12345');
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(true);
  });

  it('threshold - 1 길이 → shouldCompact=false', async () => {
    const mw = createSummarizationMiddleware({ compactThresholdChars: 5 });
    const state = makeState('1234');
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(false);
  });

  it('빈 프롬프트', async () => {
    const mw = createSummarizationMiddleware();
    const state = makeState('');
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(false);
    expect(result.context.summarization.promptLength).toBe(0);
  });
});
