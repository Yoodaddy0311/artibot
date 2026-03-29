import { describe, expect, it } from 'vitest';
import { ContextRecovery } from '../../lib/core/context-recovery.js';

describe('ContextRecovery', () => {
  // ─── detectOverflow() ──────────────────────────────────────────

  describe('detectOverflow', () => {
    it('returns overflow: false when below threshold', () => {
      const cr = new ContextRecovery();
      const result = cr.detectOverflow(80_000, 200_000, 0.9);

      expect(result.overflow).toBe(false);
      expect(result.usage).toBe(0.4);
      expect(result.remaining).toBe(120_000);
    });

    it('returns overflow: true when at threshold', () => {
      const cr = new ContextRecovery();
      const result = cr.detectOverflow(180_000, 200_000, 0.9);

      expect(result.overflow).toBe(true);
      expect(result.usage).toBe(0.9);
    });

    it('returns overflow: true when above threshold', () => {
      const cr = new ContextRecovery();
      const result = cr.detectOverflow(195_000, 200_000, 0.9);

      expect(result.overflow).toBe(true);
      expect(result.remaining).toBe(5_000);
    });

    it('uses default threshold of 0.9', () => {
      const cr = new ContextRecovery();
      const result = cr.detectOverflow(180_000, 200_000);

      expect(result.overflow).toBe(true);
    });

    it('handles zero maxTokens', () => {
      const cr = new ContextRecovery();
      const result = cr.detectOverflow(0, 0);

      expect(result.overflow).toBe(true);
      expect(result.usage).toBe(0);
      expect(result.remaining).toBe(0);
    });

    it('returns frozen result', () => {
      const cr = new ContextRecovery();
      const result = cr.detectOverflow(100, 200);

      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // ─── suggestTruncation() ───────────────────────────────────────

  describe('suggestTruncation', () => {
    it('returns empty array for non-array input', () => {
      const cr = new ContextRecovery();

      expect(cr.suggestTruncation(null)).toEqual([]);
      expect(cr.suggestTruncation(undefined)).toEqual([]);
    });

    it('sorts outputs by estimated tokens descending', () => {
      const cr = new ContextRecovery();
      const outputs = [
        { id: 'small', content: 'hi' },
        { id: 'large', content: 'a'.repeat(400) },
        { id: 'medium', content: 'b'.repeat(100) },
      ];

      const result = cr.suggestTruncation(outputs);

      expect(result[0].id).toBe('large');
      expect(result[1].id).toBe('medium');
      expect(result[2].id).toBe('small');
    });

    it('adds estimatedTokens field to each output', () => {
      const cr = new ContextRecovery();
      const result = cr.suggestTruncation([{ content: 'a'.repeat(80) }]);

      expect(result[0].estimatedTokens).toBe(20);
    });

    it('handles outputs with missing content', () => {
      const cr = new ContextRecovery();
      const result = cr.suggestTruncation([{ id: 'empty' }]);

      expect(result[0].estimatedTokens).toBe(0);
    });
  });

  // ─── truncateOutput() ─────────────────────────────────────────

  describe('truncateOutput', () => {
    it('returns unchanged output when within budget', () => {
      const cr = new ContextRecovery();
      const output = { id: 'ok', content: 'short text' };
      const result = cr.truncateOutput(output, 1000);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe('short text');
    });

    it('truncates output exceeding budget with head+tail preservation', () => {
      const cr = new ContextRecovery();
      const content = 'a'.repeat(2000);
      const output = { id: 'big', content };
      const result = cr.truncateOutput(output, 100);

      expect(result.truncated).toBe(true);
      expect(result.content).toContain('... [truncated] ...');
      expect(result.content.length).toBeLessThan(content.length);
    });

    it('preserves head (60%) and tail (40%) ratio', () => {
      const cr = new ContextRecovery();
      const content = 'H'.repeat(500) + 'M'.repeat(500) + 'T'.repeat(500);
      const result = cr.truncateOutput({ content }, 100);

      // Head should start with 'H's, tail should end with 'T's
      expect(result.content.startsWith('H')).toBe(true);
      expect(result.content.endsWith('T')).toBe(true);
    });

    it('includes originalTokens in result', () => {
      const cr = new ContextRecovery();
      const result = cr.truncateOutput({ content: 'a'.repeat(800) }, 100);

      expect(result.originalTokens).toBe(200);
    });

    it('returns frozen result', () => {
      const cr = new ContextRecovery();
      const result = cr.truncateOutput({ content: 'x' }, 100);

      expect(Object.isFrozen(result)).toBe(true);
    });

    it('handles empty content', () => {
      const cr = new ContextRecovery();
      const result = cr.truncateOutput({ content: '' }, 100);

      expect(result.truncated).toBe(false);
      expect(result.originalTokens).toBe(0);
    });
  });

  // ─── buildRecoverySummary() ────────────────────────────────────

  describe('buildRecoverySummary', () => {
    it('returns empty summary for non-array input', () => {
      const cr = new ContextRecovery();
      const result = cr.buildRecoverySummary(null);

      expect(result.summary).toBe('');
      expect(result.totalSaved).toBe(0);
      expect(result.itemCount).toBe(0);
    });

    it('returns "no truncation" message when nothing was truncated', () => {
      const cr = new ContextRecovery();
      const result = cr.buildRecoverySummary([
        { content: 'ok', truncated: false },
      ]);

      expect(result.summary).toBe('No outputs were truncated.');
      expect(result.itemCount).toBe(0);
    });

    it('builds summary with per-item savings', () => {
      const cr = new ContextRecovery();
      const result = cr.buildRecoverySummary([
        { id: 'file-read', content: 'short', originalTokens: 500, truncated: true },
        { id: 'search', content: 'data', originalTokens: 300, truncated: true },
      ]);

      expect(result.summary).toContain('[Context Recovery]');
      expect(result.summary).toContain('file-read');
      expect(result.summary).toContain('search');
      expect(result.itemCount).toBe(2);
      expect(result.totalSaved).toBeGreaterThan(0);
    });

    it('uses "(unnamed)" for outputs without id', () => {
      const cr = new ContextRecovery();
      const result = cr.buildRecoverySummary([
        { content: 'x', originalTokens: 100, truncated: true },
      ]);

      expect(result.summary).toContain('(unnamed)');
    });

    it('returns frozen result', () => {
      const cr = new ContextRecovery();
      const result = cr.buildRecoverySummary([]);

      expect(Object.isFrozen(result)).toBe(true);
    });
  });

  // ─── Custom charsPerToken ──────────────────────────────────────

  describe('custom options', () => {
    it('respects custom charsPerToken', () => {
      const cr = new ContextRecovery({ charsPerToken: 2 });
      const result = cr.suggestTruncation([{ content: 'a'.repeat(100) }]);

      expect(result[0].estimatedTokens).toBe(50);
    });
  });
});
