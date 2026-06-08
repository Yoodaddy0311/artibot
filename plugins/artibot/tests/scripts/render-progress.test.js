/**
 * Tests for scripts/render-progress.js — the chat-visible /team progress box.
 *
 * @module tests/scripts/render-progress
 */

import { describe, expect, it } from 'vitest';
import {
  clampInt,
  computePct,
  renderBar,
  renderProgressBox,
} from '../../scripts/render-progress.js';

describe('render-progress / computePct', () => {
  it('computes integer percentages', () => {
    expect(computePct(7, 10)).toBe(70);
    expect(computePct(1, 3)).toBe(33);
    expect(computePct(10, 10)).toBe(100);
  });

  it('returns 0 when total is missing or non-positive', () => {
    expect(computePct(5, 0)).toBe(0);
    expect(computePct(5, -1)).toBe(0);
  });

  it('clamps to [0, 100]', () => {
    expect(computePct(15, 10)).toBe(100);
  });
});

describe('render-progress / renderBar', () => {
  it('renders a 20-cell bar proportional to percentage', () => {
    expect(renderBar(0)).toBe('░'.repeat(20));
    expect(renderBar(100)).toBe('█'.repeat(20));
    // 70% → round(0.7 * 20) = 14 filled
    expect(renderBar(70)).toBe('█'.repeat(14) + '░'.repeat(6));
  });

  it('is robust to out-of-range / NaN input', () => {
    expect(renderBar(150)).toBe('█'.repeat(20));
    expect(renderBar(-10)).toBe('░'.repeat(20));
    expect(renderBar(NaN)).toBe('░'.repeat(20));
  });
});

describe('render-progress / clampInt', () => {
  it('floors non-negative numbers and falls back otherwise', () => {
    expect(clampInt('7')).toBe(7);
    expect(clampInt(3.9)).toBe(3);
    expect(clampInt('abc')).toBe(0);
    expect(clampInt(-2)).toBe(0);
    expect(clampInt(undefined, 5)).toBe(5);
  });
});

describe('render-progress / renderProgressBox', () => {
  it('renders an in-progress box with bar, percent and counts', () => {
    const box = renderProgressBox({ done: 7, total: 10, phaseLabel: 'Review', inflight: 2, pending: 1 });
    expect(box).toContain('📊 작업 진행률');
    expect(box).toContain('70%');
    expect(box).toContain('완료 7 / 전체 10');
    expect(box).toContain('🔄 진행 2');
    expect(box).toContain('⏳ 대기 1');
    expect(box).toContain('현재 단계: Review');
    expect(box).not.toContain('🎉');
  });

  it('renders the completion box at 100% (done >= total)', () => {
    const box = renderProgressBox({ done: 10, total: 10 });
    expect(box).toContain('🎉 작업 완료');
    expect(box).toContain('100%');
    expect(box).toContain('████████████████████');
    expect(box).not.toContain('📊');
  });

  it('never lets total fall below done (defensive)', () => {
    const box = renderProgressBox({ done: 8, total: 3 });
    // done >= total → completion variant with total normalized up to 8
    expect(box).toContain('🎉 작업 완료');
    expect(box).toContain('완료 8 / 전체 8');
  });

  it('omits inflight/pending/phase rows when not provided', () => {
    const box = renderProgressBox({ done: 2, total: 8 });
    expect(box).toContain('완료 2 / 전체 8');
    expect(box).not.toContain('🔄 진행');
    expect(box).not.toContain('⏳ 대기');
    expect(box).not.toContain('현재 단계');
  });

  it('handles empty/zero input without throwing', () => {
    expect(() => renderProgressBox({})).not.toThrow();
    expect(renderProgressBox({ done: 0, total: 0 })).toContain('0%');
  });
});
