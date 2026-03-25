import { describe, expect, it } from 'vitest';
import {
  createSummarizationMiddleware,
  _estimateTokens,
  _splitSegments,
  _partitionSegments,
  _summarizeSegments,
  _rebuildPrompt,
  _calcCompactionStats,
} from '../../../lib/runtime/middleware/summarization.js';

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
    expect(result.context.summarization.maxTokens).toBe(50000);
    expect(result.messageParts).toHaveLength(0);
  });

  it('긴 프롬프트 → shouldCompact=true with compaction', async () => {
    const mw = createSummarizationMiddleware({ compactThresholdChars: 100 });
    const segments = Array.from({ length: 10 }, (_, i) => `Segment ${i}: ${'x'.repeat(30)}`);
    const longPrompt = segments.join('\n\n');
    const state = makeState(longPrompt);
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(true);
    expect(result.context.summarization.compacted).toBe(true);
    expect(result.context.summarization.segmentsTotal).toBe(10);
    expect(result.context.summarization.segmentsPreserved).toBe(5);
    expect(result.context.summarization.segmentsSummarized).toBe(5);
    expect(result.messageParts.some((p) => p.startsWith('compact='))).toBe(true);
  });

  it('커스텀 compactThresholdChars 적용', async () => {
    const mw = createSummarizationMiddleware({ compactThresholdChars: 10 });
    const state = makeState('short but over 10');
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(true);
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

  it('maxTokens 기반 트리거 (charsPerToken 곱)', async () => {
    const mw = createSummarizationMiddleware({ maxTokens: 10, charsPerToken: 2 });
    // 10 tokens * 2 chars/token = 20 chars threshold
    const state = makeState('x'.repeat(20));
    const result = await mw(state);

    expect(result.context.summarization.shouldCompact).toBe(true);
  });

  it('preserveRecent 설정 적용', async () => {
    const segments = Array.from({ length: 8 }, (_, i) => `Segment ${i}: content`);
    const prompt = segments.join('\n\n');
    const mw = createSummarizationMiddleware({
      compactThresholdChars: 10,
      preserveRecent: 3,
    });
    const state = makeState(prompt);
    const result = await mw(state);

    expect(result.context.summarization.segmentsPreserved).toBe(3);
    expect(result.context.summarization.segmentsSummarized).toBe(5);
  });

  it('summaryRatio 설정 적용', async () => {
    const segments = Array.from({ length: 10 }, (_, i) => `Segment ${i}. Detail here.`);
    const prompt = segments.join('\n\n');
    const mw = createSummarizationMiddleware({
      compactThresholdChars: 10,
      summaryRatio: 0.5,
      preserveRecent: 2,
    });
    const state = makeState(prompt);
    const result = await mw(state);

    expect(result.context.summarization.compacted).toBe(true);
    expect(result.userPrompt).toContain('[Context summary]');
  });

  it('compaction reduces prompt length', async () => {
    const segments = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}: ${'word '.repeat(50)}`);
    const prompt = segments.join('\n\n');
    const mw = createSummarizationMiddleware({ compactThresholdChars: 100 });
    const state = makeState(prompt);
    await mw(state);

    expect(state.userPrompt.length).toBeLessThan(prompt.length);
    expect(state.context.summarization.savedTokens).toBeGreaterThan(0);
    expect(state.context.summarization.reductionPercent).toBeGreaterThan(0);
  });
});

describe('summarization helpers', () => {
  it('estimateTokens: basic estimation', () => {
    expect(_estimateTokens('12345678', 4)).toBe(2);
    expect(_estimateTokens('', 4)).toBe(0);
    expect(_estimateTokens(null, 4)).toBe(0);
  });

  it('splitSegments: splits on double newlines', () => {
    const result = _splitSegments('a\n\nb\n\nc');
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('splitSegments: empty input', () => {
    expect(_splitSegments('')).toEqual([]);
    expect(_splitSegments(null)).toEqual([]);
  });

  it('partitionSegments: all recent when fewer than preserveRecent', () => {
    const result = _partitionSegments(['a', 'b'], 5);
    expect(result.older).toEqual([]);
    expect(result.recent).toEqual(['a', 'b']);
  });

  it('partitionSegments: splits correctly', () => {
    const result = _partitionSegments(['a', 'b', 'c', 'd', 'e'], 2);
    expect(result.older).toEqual(['a', 'b', 'c']);
    expect(result.recent).toEqual(['d', 'e']);
  });

  it('summarizeSegments: empty array', () => {
    expect(_summarizeSegments([], 0.3)).toBe('');
  });

  it('summarizeSegments: extracts first sentences', () => {
    const result = _summarizeSegments(['First sentence. More text.', 'Another. Details.'], 1.0);
    expect(result).toContain('[Context summary]');
    expect(result).toContain('First sentence');
    expect(result).toContain('Another');
  });

  it('rebuildPrompt: joins summary and recent', () => {
    const result = _rebuildPrompt('[summary]', ['recent1', 'recent2']);
    expect(result).toBe('[summary]\n\nrecent1\n\nrecent2');
  });

  it('rebuildPrompt: no summary', () => {
    const result = _rebuildPrompt('', ['a', 'b']);
    expect(result).toBe('a\n\nb');
  });

  it('calcCompactionStats: correct calculation', () => {
    const stats = _calcCompactionStats(100, 60);
    expect(stats.savedTokens).toBe(40);
    expect(stats.reductionPercent).toBe(40);
  });

  it('calcCompactionStats: zero original', () => {
    const stats = _calcCompactionStats(0, 0);
    expect(stats.savedTokens).toBe(0);
    expect(stats.reductionPercent).toBe(0);
  });
});
