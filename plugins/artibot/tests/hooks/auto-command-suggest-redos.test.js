import { describe, expect, it } from 'vitest';
import * as acs from '../../scripts/hooks/auto-command-suggest.js';

/**
 * auto-command-suggest.js#classifyCommandIntent — super-linear backtracking (M1,
 * review 2026-11-21).
 *
 * ── the defect this pins ─────────────────────────────────────────────────────
 * The ADR / Migrate patterns used an UNBOUNDED `\S{2,}` (e.g. MIGRATE_KO_PATTERNS
 * `(\S{2,})\s*에서\s*(\S{2,})…`, ADR_KO_COMPARE_PATTERNS `(\S{2,})\s*(?:와|과)…`,
 * ADR_VS_PATTERN `\b\S{2,}\s+vs…`). On a long run with no whitespace every start
 * position scans to the end of the run and backtracks, so the cost is O(n^2) in
 * the prompt length. Measured 2026-11-21 on this machine, before the fix:
 * 32,768 x '가' took 8,186 ms, 16,384 x '가' 2,027 ms (x4 per doubling). The
 * hook runs in the UserPromptSubmit slot, so a pasted minified bundle or base64
 * blob stalled the slot for its whole timeout.
 *
 * The fix is two-sided: the classifier reads at most CLASSIFY_MAX_CHARS of the
 * prompt (head + tail), and every token quantifier is bounded (`\S{2,64}`). The
 * bound alone is not enough — measured 2026-11-21 on a prototype, a 131,072 x '와'
 * input still took 3.1 s with bounded tokens, because `(\S{2,64})\s*와\s*(\S{2,64})`
 * is 64 x 64 per start — so the length cap is load-bearing too.
 *
 * ── what this file does NOT see ──────────────────────────────────────────────
 *   - Only the inputs listed below are timed. Another pattern added later with an
 *     unbounded quantifier is caught only if one of these inputs reaches it; the
 *     source scan at the bottom is the second line for that.
 *   - The time limit is deliberately loose (LIMIT_MS) so a loaded CI runner cannot
 *     flake it; it separates "linear and capped" (tens of ms) from "quadratic"
 *     (tens of seconds at this size), not a 2x regression.
 */

/** 128K characters — at least 128 KB in any encoding. */
const N = 131_072;

/** Generous: the fixed classifier takes ~100 ms on the worst input here; the old one took minutes. */
const LIMIT_MS = 3_000;

/** No-whitespace runs that drive each pattern family into backtracking. */
const ADVERSARIAL = {
  'ascii run': 'a'.repeat(N),
  'hangul run': '가'.repeat(N),
  '와 run (ADR_KO_COMPARE 와/과)': '와'.repeat(N),
  'a에서 run (MIGRATE_KO 에서…로)': 'a에서'.repeat(N / 3),
  'aa와 run': 'aa와'.repeat(N / 3),
};

describe('classifyCommandIntent — long no-whitespace input finishes quickly', () => {
  for (const [label, text] of Object.entries(ADVERSARIAL)) {
    it(`${label} (${text.length} chars) < ${LIMIT_MS} ms`, () => {
      const t0 = performance.now();
      acs.classifyCommandIntent(text);
      const ms = performance.now() - t0;
      expect(ms, `${label}: ${Math.round(ms)} ms`).toBeLessThan(LIMIT_MS);
    }, 600_000);
  }
});

describe('classifyCommandIntent — the length cap keeps intent at either end', () => {
  it('exports a finite positive CLASSIFY_MAX_CHARS', () => {
    expect(Number.isInteger(acs.CLASSIFY_MAX_CHARS)).toBe(true);
    expect(acs.CLASSIFY_MAX_CHARS).toBeGreaterThan(0);
  });

  it('a question at the START of a long pasted prompt is still classified', () => {
    const filler = 'x'.repeat(N);
    expect(acs.classifyCommandIntent(`PostgreSQL vs MongoDB 어느 쪽?\n${filler}`)?.command).toBe('adr');
  });

  it('a question at the END of a long pasted prompt is still classified', () => {
    const filler = 'x'.repeat(N);
    expect(acs.classifyCommandIntent(`${filler}\nRedis 에서 Valkey 로 이전 계획 짜줘`)?.command).toBe('migrate');
  });

  it('a token longer than 64 chars still matches by its tail (left-unanchored pattern)', () => {
    // MIGRATE_KO `(\S{2,64})\s*에서…` has no left anchor, so a long token matches by its last 64 chars.
    const longToken = `${'가'.repeat(100)}DB`;
    expect(acs.classifyCommandIntent(`${longToken} 에서 Valkey 로 이전`)?.command).toBe('migrate');
  });

  it('known cost of the bound: a `\\b`-anchored pattern misses an ASCII word over 64 chars', () => {
    // ADR_VS_PATTERN opens with `\b`; a 64-char tail of a longer word starts mid-word,
    // where `\b` does not hold. Pinned so the cost is visible, not because it is wanted.
    const longWord = `${'p'.repeat(100)}SQL`;
    expect(acs.classifyCommandIntent(`${longWord} vs MongoDB`)).toBeNull();
    expect(acs.classifyCommandIntent('PostgreSQL vs MongoDB')?.command).toBe('adr');
  });
});

/**
 * An UNBOUNDED quantifier on a `\S` token, as it appears in source text: `\S+`, `\S*`,
 * `\S{n,}`. Widened from `\S{2,}` alone (xcC LOW, 2026-11-21) — `\S+` backtracks the
 * same way. Not widened to `\s`/`\w`/`.`: on 2026-11-21 that family matched 30 of the
 * file's 293 lines, every one a whitespace quantifier (`\s*`, `\s+`) beside a bounded
 * token, so it would be red on the fixed source. What this does NOT see: an unbounded
 * `[^\s]+` / `\w+` / `.+` token, or a pattern built with `new RegExp(string)`.
 */
const UNBOUNDED_S_TOKEN = /\\S(?:[+*]|\{\d+,\})/;

describe('auto-command-suggest.js — no unbounded token quantifier is left', () => {
  it('the source has no unbounded `\\S` token (`\\S+`, `\\S*`, `\\S{n,}`)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../../scripts/hooks/auto-command-suggest.js', import.meta.url)), 'utf8');
    // Self-check of the scanner: the bounded form must be present, or this scan proves nothing.
    expect(src).toMatch(/\\S\{2,64\}/);
    const hits = src.split(/\r?\n/).filter((l) => UNBOUNDED_S_TOKEN.test(l));
    expect(hits).toEqual([]);
    // Negative control on an in-memory copy: un-bounding the real source is caught.
    const mutated = src.replace('\\S{2,64}', '\\S+');
    expect(mutated).not.toBe(src);
    expect(UNBOUNDED_S_TOKEN.test(mutated)).toBe(true);
  });

  it('scanner self-check: each unbounded form is flagged, bounded forms are not', () => {
    const unbounded = [String.raw`/(\S{2,})x/`, String.raw`/\S+y/`, String.raw`/\S*z/`, String.raw`/\S{10,}/`];
    const bounded = [String.raw`/(\S{2,64})x/`, String.raw`/\S{3}/`, String.raw`/\S?/`, String.raw`/\s+vs/`];
    expect(unbounded.filter((s) => !UNBOUNDED_S_TOKEN.test(s))).toEqual([]);
    expect(bounded.filter((s) => UNBOUNDED_S_TOKEN.test(s))).toEqual([]);
  });
});
