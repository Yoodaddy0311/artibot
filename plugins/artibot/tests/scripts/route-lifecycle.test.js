import { describe, expect, it } from 'vitest';
import { routeCli } from '../../scripts/route-lifecycle.mjs';

describe('route-lifecycle CLI bridge', () => {
  // All 5 lifecycle-command phases are declared in lifecycle.json, so
  // routeLifecycle resolves them deterministically (never null) with a fixed
  // default agent — exact-equality is safe here.
  it('routes an explicit known phase id through routeLifecycle', async () => {
    const r = await routeCli(['spec']);
    expect(r).not.toBeNull();
    expect(r.lifecycle).toBe('spec');
    expect(r.agent).toBeNull(); // spec has no default_agent yet
    expect(r.candidates).toEqual([]);
  });
  it('forwards a free-form hint with the phase', async () => {
    const r = await routeCli(['ship', 'deploy', 'to', 'prod']);
    expect(r).not.toBeNull();
    expect(r.lifecycle).toBe('ship');
    expect(r.agent).toBe('devops-engineer');
    expect(r.toolset).toBe('devops');
  });
  it('falls back to routeByContext for an unknown first arg and never throws', async () => {
    // "review code" hits two matchers: "review" (review phase) and "code"
    // (build phase). Both score 1; matchContextToLifecycle keeps the first
    // lifecycle seen at the top score in declaration order, and build precedes
    // review in lifecycle.json — so this resolves deterministically to build.
    const r = await routeCli(['please', 'review', 'my', 'code']);
    expect(r).not.toBeNull();
    expect(r.lifecycle).toBe('build');
    expect(r.agent).toBe('backend-developer');
  });
  it('routes an unambiguous review hint to the review lifecycle', async () => {
    const r = await routeCli(['run', 'a', 'security', 'audit']);
    expect(r).not.toBeNull();
    expect(r.lifecycle).toBe('review');
    expect(r.agent).toBe('code-reviewer');
  });
  it('resolves the design phase to the architect agent', async () => {
    const r = await routeCli(['design']);
    expect(r).not.toBeNull();
    expect(r.lifecycle).toBe('design');
    expect(r.agent).toBe('architect');
  });
  it('resolves the marketing phase to the marketing-strategist agent', async () => {
    const r = await routeCli(['marketing', 'launch', 'campaign']);
    expect(r).not.toBeNull();
    expect(r.lifecycle).toBe('marketing');
    expect(r.agent).toBe('marketing-strategist');
  });
});
