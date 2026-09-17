/**
 * Which model the `route.bound` row records — and when it records nothing.
 *
 * WHY THIS EXISTS. `SubagentStart` gives the hook one identity: `agent_type`.
 * For an Agent-tool spawn that value IS the agent definition name, so the
 * model policy answers it directly. For a NAMED spawn (`/team`, `/split`) the
 * host puts the TEAMMATE NAME there instead — `split-artibot-x-impl`,
 * `lens-a`, `w8a-opus` — and a name is not a policy key. `getPolicyModel`
 * answers null, the hook suppresses its advisory (correctly: warning about an
 * agent it cannot identify would be a false positive), and the bind row loses
 * its model column. Measured 2026-09-15 13:42Z on this repo's ledger: 244 of
 * 249 `route.bound` rows carried no `selected_model`, and 250 of 250
 * `spawns.ndjson` start rows carried `canonicalModel: null`.
 *
 * The definition that actually spawned is not lost — it is on the RouteReceipt
 * the PreToolUse hook wrote, whose `subagent_type` came from the Agent tool's
 * own input. So when a spawn binds to a receipt, this module re-derives the
 * model from that definition through the SAME resolver a direct spawn uses.
 * Nothing here changes which model runs; it only stops the record from being
 * blank about it.
 *
 * WHAT THIS CANNOT SEE (repo rule §9 — the blind spot, beside the gate):
 *   - WHETHER THE MATCHED RECEIPT IS THE RIGHT RECEIPT. Tier-3 correlation is
 *     FIFO, i.e. a guess (`subagent-handler.js#matchReceipt`). A wrong receipt
 *     yields the wrong definition and therefore the wrong model here. That
 *     uncertainty is ALREADY on the bind row as `confidence: 'fifo'` — this
 *     module deliberately adds no second key saying the same thing, because a
 *     second answer to one question is how two readers end up disagreeing.
 *   - ANY DIFFERENCE BETWEEN THE RECEIPT'S PREDICTION AND THIS ANSWER. On a
 *     named spawn both sides are `resolveModel(<same subagent_type>)`, so they
 *     agree BY CONSTRUCTION. The prediction-versus-actual comparison is
 *     meaningful only on a direct spawn, where `agent_type` is the definition.
 *
 * @module lib/routing/bind-model-fallback
 */

import { getPolicyModel, resolveModel } from '../core/model-policy.js';

/** The one outcome that means "a receipt was matched and the bind was written". */
const BOUND_LEDGER = 'ok:bound';

/** Nothing to record. Frozen so a caller cannot mutate the shared miss. */
const NONE = Object.freeze({ model: null, source: null });

/**
 * Decide the model to record on a bind, preferring the hook's own policy answer
 * and falling back to the bound receipt's agent definition.
 *
 * In order, first hit wins:
 *   1. `canonicalModel` is a string — the payload's `agent_type` WAS a policy
 *      key (direct Agent-tool spawn). Unchanged behaviour, `source: 'policy'`.
 *   2. The spawn did not bind (`routeLedger !== 'ok:bound'`) — no receipt, so
 *      no definition to reinterpret. null.
 *   3. The receipt names no `subagent_type`. null.
 *   4. The policy does not list that definition (`Explore`, `fork`,
 *      `general-purpose`, anything unshipped). null ON PURPOSE: `resolveModel`
 *      would answer `DEFAULT_MODEL` ('opus') here, and recording a default as
 *      if it were a measurement is exactly the illusion this module must not
 *      create. A definition whose tier is unknown stays unknown.
 *   5. Otherwise `resolveModel` on that definition — which applies the fable
 *      opt-in gate and the security denylist, so the value is the EFFECTIVE
 *      tier (code-reviewer → fable, security-reviewer → opus), never the raw
 *      bucket.
 *
 * `config` must be the hydrated config object the caller already loaded. When
 * it is missing the answer is null rather than a lookup against
 * `getConfig()`'s ambient cache: in a hook process that cache is empty, and in
 * a long-lived process it would answer from someone else's hydration.
 *
 * Pure: no filesystem, no clock, no randomness. NEVER THROWS — this runs on a
 * best-effort path where a throw would cost a teammate registration.
 *
 * @param {object} [args]
 * @param {string|null} [args.canonicalModel] - Policy answer for `agent_type`, if any
 * @param {string} [args.routeLedger] - The bind outcome, e.g. `ok:bound`
 * @param {string|null} [args.receiptSubagentType] - `subagent_type` off the matched receipt
 * @param {object} [args.config] - Hydrated config; anything else yields null
 * @returns {{ model: string|null, source: 'policy'|'receipt'|null }}
 */
export function resolveBoundModel(args) {
  try {
    const {
      canonicalModel = null, routeLedger, receiptSubagentType = null, config,
    } = args ?? {};
    if (typeof canonicalModel === 'string' && canonicalModel !== '') {
      return { model: canonicalModel, source: 'policy' };
    }
    if (routeLedger !== BOUND_LEDGER) return { ...NONE };
    if (typeof receiptSubagentType !== 'string' || receiptSubagentType === '') return { ...NONE };
    if (config === null || typeof config !== 'object') return { ...NONE };
    if (getPolicyModel(receiptSubagentType, config) === null) return { ...NONE };
    const model = resolveModel(receiptSubagentType, {}, config);
    if (typeof model !== 'string' || model === '') return { ...NONE };
    return { model, source: 'receipt' };
  } catch {
    return { ...NONE };
  }
}
