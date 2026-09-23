import { beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../lib/core/config.js';
import { getPolicyModel, resolveModel } from '../../lib/core/model-policy.js';
import { resolveBoundModel } from '../../lib/routing/bind-model-fallback.js';

/**
 * `route.bound.data.selected_model` — which value the bind row records, and
 * when it records nothing at all.
 *
 * WHY THIS MODULE EXISTS (the measured defect it answers): for a NAMED spawn
 * (`/team`, `/split`) the host puts the TEAMMATE NAME in the SubagentStart
 * `agent_type` — `split-artibot-x-impl`, `lens-a` — not the agent DEFINITION
 * name. A name is not a policy key, so `getPolicyModel` answers null and the
 * hook suppressed the field: 244 of 249 live `route.bound` rows carried no
 * `selected_model` (measured 2026-09-15 13:42Z on this repo's ledger).
 *
 * WHAT THIS FILE DOES NOT PROVE (repo rule §9 — the gate's blind spots, beside
 * the gate):
 *   - THAT THE MATCHED RECEIPT IS THE RIGHT RECEIPT. A FIFO-tier bind is a
 *     guess; the fallback then re-derives the model from a guessed definition.
 *     The bind row already says so in `confidence: 'fifo'` — these assertions
 *     only pin that a receipt-derived answer is computed, never that the
 *     receipt was correct.
 *   - THAT THE LIVE POLICY SAYS WHAT THE SHIPPED CONFIG SAYS. Named-definition
 *     expectations go through `resolveModel` under the loaded config, so a tier
 *     change moves both sides together. The tier LITERALS that remain (the
 *     `'opus'` DEFAULT_MODEL control, the shipped single-tier `'opus'` answer
 *     for an allowlisted reviewer, the `'fable'` allowlist answer on the
 *     gate-on copy, and the security-reviewer denylist pair) are deliberate
 *     policy pins in the same spirit as the FABLE_AGENTS pin: they are MEANT to
 *     break when the owner changes those rules, so that change is noticed here
 *     too.
 */
describe('resolveBoundModel', () => {
  let config;

  beforeAll(async () => {
    config = await loadConfig();
    expect(config && typeof config === 'object').toBe(true);
  });

  const ok = (over = {}) => resolveBoundModel({
    canonicalModel: null,
    routeLedger: 'ok:bound',
    receiptSubagentType: 'tdd-guide',
    config,
    ...over,
  });

  // -------------------------------------------------------------------------
  // Rule 1 — a policy answer already exists (direct Agent-tool spawn)
  // -------------------------------------------------------------------------

  it('returns the policy model unchanged when the hook already resolved one', () => {
    expect(ok({ canonicalModel: 'opus' })).toEqual({ model: 'opus', source: 'policy' });
  });

  it('prefers the policy model over the receipt, so a direct spawn is untouched', () => {
    // agent_type WAS the definition name here; the receipt must not override it.
    const out = ok({ canonicalModel: 'fable', receiptSubagentType: 'tdd-guide' });
    expect(out).toEqual({ model: 'fable', source: 'policy' });
  });

  it('keeps the policy model even when the route did not bind', () => {
    const out = ok({ canonicalModel: 'opus', routeLedger: 'skipped:unbound' });
    expect(out).toEqual({ model: 'opus', source: 'policy' });
  });

  // -------------------------------------------------------------------------
  // Rule 2 — nothing to reinterpret unless this spawn actually bound
  // -------------------------------------------------------------------------

  it('answers null for an unbound spawn: there is no receipt to read a definition from', () => {
    expect(ok({ routeLedger: 'skipped:unbound' })).toEqual({ model: null, source: null });
  });

  it('answers null for an already-bound replay', () => {
    expect(ok({ routeLedger: 'skipped:already-bound' })).toEqual({ model: null, source: null });
  });

  it('answers null when the route ledger outcome is missing entirely', () => {
    expect(ok({ routeLedger: undefined })).toEqual({ model: null, source: null });
  });

  // -------------------------------------------------------------------------
  // Rule 3 — the receipt must actually name a definition
  // -------------------------------------------------------------------------

  it('answers null when the receipt carries no subagent_type', () => {
    expect(ok({ receiptSubagentType: null })).toEqual({ model: null, source: null });
  });

  it('answers null for an empty subagent_type rather than resolving the empty name', () => {
    expect(ok({ receiptSubagentType: '' })).toEqual({ model: null, source: null });
  });

  it('answers null for a non-string subagent_type', () => {
    expect(ok({ receiptSubagentType: 42 })).toEqual({ model: null, source: null });
  });

  // -------------------------------------------------------------------------
  // Rule 4 — an unlisted definition stays null; it is NEVER dressed as opus
  // -------------------------------------------------------------------------

  it('answers null for a built-in agent the policy does not list', () => {
    // `Explore` is a host built-in: no bucket, no declared tier. 4 of the 244
    // missing live rows are this case and they are SUPPOSED to stay missing.
    expect(getPolicyModel('Explore', config)).toBeNull();
    expect(ok({ receiptSubagentType: 'Explore' })).toEqual({ model: null, source: null });
  });

  it('answers null for `fork` and `general-purpose` rather than falling through to the default model', () => {
    for (const name of ['fork', 'general-purpose']) {
      expect(getPolicyModel(name, config)).toBeNull();
      expect(ok({ receiptSubagentType: name })).toEqual({ model: null, source: null });
    }
  });

  it('never returns DEFAULT_MODEL for an unlisted definition', () => {
    // `resolveModel` itself would answer 'opus' here (defaultModel fallback).
    // Pricing and tier for an unknown definition are UNKNOWN, and recording a
    // guess as a measurement is the failure this assertion exists to prevent.
    expect(resolveModel('zzz-not-an-agent', {}, config)).toBe('opus');
    expect(ok({ receiptSubagentType: 'zzz-not-an-agent' })).toEqual({ model: null, source: null });
  });

  // -------------------------------------------------------------------------
  // Rule 5 — the receipt's definition, through the SAME resolver as a spawn
  // -------------------------------------------------------------------------

  it('re-derives the model from the receipt definition on a named spawn', () => {
    expect(ok({ receiptSubagentType: 'tdd-guide' })).toEqual({
      model: resolveModel('tdd-guide', {}, config), source: 'receipt',
    });
  });

  /**
   * The loaded config with the fable gate re-opened — the 2-tier fleet
   * (2026-09-02 .. 2026-09-23) rebuilt by flipping back only the two keys the
   * single-tier revert touched. Since the owner decision of 2026-09-23 ("fable
   * 5.1 -> opus 5.5") the shipped gate is OFF, so every definition resolves to
   * opus there and an allowlist/denylist assertion against it would pass
   * whether or not the gate works. Gate behavior is pinned on this copy.
   *
   * @returns {object}
   */
  const gateOnConfig = () => {
    const copy = structuredClone(config);
    copy.agents.modelPolicy.fable.enabled = true;
    copy.agents.modelPolicy.phaseRoles.review = 'fable';
    return copy;
  };

  it('shipped config (single-tier opus, owner 2026-09-23): an allowlisted reviewer lands on opus', () => {
    // Deliberate policy pin: breaks if the kill-switch is re-opened, so that
    // change is noticed here too. The allowlist still NAMES code-reviewer.
    expect(config.agents.modelPolicy.fable.enabled).toBe(false);
    expect(config.agents.modelPolicy.fable.allowlist).toContain('code-reviewer');
    const out = ok({ receiptSubagentType: 'code-reviewer' });
    expect(out).toEqual({ model: resolveModel('code-reviewer', {}, config), source: 'receipt' });
    expect(out.model).toBe('opus');
  });

  it('applies the fable allowlist, so an allowlisted reviewer lands on fable (gate-on copy)', () => {
    const on = gateOnConfig();
    const out = ok({ receiptSubagentType: 'code-reviewer', config: on });
    expect(out).toEqual({ model: resolveModel('code-reviewer', {}, on), source: 'receipt' });
    expect(out.model).toBe('fable');
  });

  it('applies the fable denylist, so security-reviewer lands on opus despite its fable bucket (gate-on copy)', () => {
    // `security-reviewer` sits in the fable-model `high` bucket; the denylist
    // is what demotes it. Going through the raw bucket instead would record a
    // tier that never runs. Run with the gate OPEN, where an allowlisted
    // neighbour in the same bucket does reach fable — otherwise the closed
    // shipped gate, not the denylist, would be what produced opus.
    const on = gateOnConfig();
    expect(getPolicyModel('security-reviewer', on)).toBe('fable');
    expect(ok({ receiptSubagentType: 'code-reviewer', config: on }).model).toBe('fable');
    const out = ok({ receiptSubagentType: 'security-reviewer', config: on });
    expect(out).toEqual({ model: 'opus', source: 'receipt' });
    // And on the shipped config too, where it is opus like everyone else.
    expect(ok({ receiptSubagentType: 'security-reviewer' })).toEqual({ model: 'opus', source: 'receipt' });
  });

  it('normalizes an `artibot:`-prefixed definition the way the spawn path does', () => {
    expect(ok({ receiptSubagentType: 'artibot:tdd-guide' })).toEqual({
      model: resolveModel('tdd-guide', {}, config), source: 'receipt',
    });
  });

  // -------------------------------------------------------------------------
  // Never throws — this runs on a best-effort hook path
  // -------------------------------------------------------------------------

  it('answers null instead of throwing when the config failed to hydrate', () => {
    // `checkModelPolicy`'s catch branch returns `config: undefined`. The
    // resolver refuses to fall back on `getConfig()`'s ambient cache: in a hook
    // process that cache is empty anyway, and in a long-lived process it would
    // answer from SOMEONE ELSE'S hydration — a second answer to the one
    // question this repo keeps single-sourced.
    expect(resolveBoundModel({
      canonicalModel: null, routeLedger: 'ok:bound',
      receiptSubagentType: 'tdd-guide', config: undefined,
    })).toEqual({ model: null, source: null });
  });

  it('answers null instead of throwing on a missing argument object', () => {
    expect(resolveBoundModel()).toEqual({ model: null, source: null });
  });

  it('answers null instead of throwing when the config is a hostile getter', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'agents', {
      get() { throw new Error('boom'); },
      enumerable: true,
    });
    expect(resolveBoundModel({
      canonicalModel: null, routeLedger: 'ok:bound',
      receiptSubagentType: 'tdd-guide', config: hostile,
    })).toEqual({ model: null, source: null });
  });
});
