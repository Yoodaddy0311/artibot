/**
 * Autopilot consent gate — the single owner of the autopilot activation
 * vocabulary (ADR-004).
 *
 * Why this module exists at all: the activation vocabulary had grown to five
 * independent knobs (`autopilot.enabled`, `team.autoApply`, `runner.autoSelect`,
 * `fast`, and now the `suggest`/`execution` pair) with no single place that
 * decided "may this operation run". `scripts/hooks/autopilot-nlu-trigger.js`
 * owned its own copy of the answer, which is how the doc/code gap in v4.4.1
 * happened. Every consumer must call {@link resolveAutopilotConsent} rather
 * than re-reading a flag.
 *
 * ## The two gates
 *
 * | gate | meaning | shipped default |
 * |---|---|---|
 * | `suggest` | may the NLU hook volunteer `[autopilot-suggested]`? | off in this repo |
 * | `execution` | may an operation create/advance a session? | on |
 *
 * Splitting them is the whole point of ADR-004: `autopilot.enabled: false` was
 * documented in `commands/autopilot.md` as a total kill-switch but implemented
 * as suggestion-silencing only (CHANGELOG v4.4.1: "Per-feature opt-in via
 * explicit `/autopilot <task>` continues to work"). Two populations of users
 * therefore hold contradictory, equally-documented expectations about the same
 * `false`.
 *
 * ## Precedence (this is the load-bearing rule)
 *
 *   1. An explicit boolean at `autopilot.<gate>.enabled` wins outright.
 *   2. Otherwise a legacy `autopilot.enabled === false` maps to **both** gates
 *      false, with a stderr WARN.
 *   3. Otherwise the gate defaults to enabled.
 *
 * Step 1 is what keeps step 2 from being a self-DoS. The conservative
 * both-false mapping preserves the intent of a user who read the docs and typed
 * `false` to stop everything; the explicit-wins rule lets a config that has
 * actually been migrated (like this repo's, which keeps `enabled: false` for
 * suggestion while setting `execution.enabled: true`) say so unambiguously. The
 * ADR fixes the mapping direction but does not discuss the interaction of the
 * two, so the ordering above is the implementation's contract and is pinned by
 * tests.
 *
 * Mapping a legacy `false` to `suggest` only was considered and rejected in
 * ADR-004 (plan-critic C3): it silently hands execution rights back to the user
 * who wanted everything off, which is the worse of the two failure directions.
 *
 * ## Override
 *
 * `override` is a **call argument only**. It is deliberately not read from
 * config or from the environment: a kill-switch that any config file can
 * neutralise is not a kill-switch. A one-shot override is recorded as a consent
 * receipt on the session state (additive field, no schema bump).
 *
 * @module lib/autopilot/consent-gate
 */

import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { getPluginRoot } from '../core/platform.js';

/**
 * Which gate each operation answers to.
 *
 * `always` covers read and control operations. `abort` is deliberately in this
 * bucket: a disabled autopilot must still be stoppable, and gating the stop
 * button behind the same flag that failed you is how a paused session becomes
 * unkillable. `status`/`list`/`tail`/`replay`/`diff` mutate nothing.
 *
 * ## WHAT THIS TABLE DOES NOT PROVE
 *
 * `queue` is **declared here but not yet wired at its call site**. The queue
 * entry point is `lib/autopilot/goal-queue.js#enqueueGoal`, which does not
 * consult this resolver, so `execution.enabled: false` does NOT currently stop
 * a goal from being enqueued. Reading this table and concluding "queue is
 * gated" is exactly the wrong inference — the row states the intended policy,
 * not a live enforcement point. Wiring it is a separate change.
 *
 * The same caution applies in the other direction to the `always` rows: they
 * are always-allowed, so their entry points are correct precisely *because*
 * they never call this resolver. Only `start` and `resume` (engine.js) are
 * live enforcement points today.
 *
 * @type {Readonly<Record<string, 'execution'|'suggest'|'always'>>}
 */
export const OPERATION_GATES = Object.freeze({
  start: 'execution',
  queue: 'execution',
  resume: 'execution',
  status: 'always',
  list: 'always',
  abort: 'always',
  tail: 'always',
  replay: 'always',
  diff: 'always',
  suggest: 'suggest',
});

/** Gate names in their canonical order. @type {readonly string[]} */
export const GATES = Object.freeze(['suggest', 'execution']);

/**
 * Read the autopilot config block. Mirrors `engine.js#loadRunnerConfig`'s
 * direct-read + safe-default pattern.
 *
 * A malformed config degrades to `{}` (→ gates default enabled) rather than
 * fail-closed. That is the opposite of `autopilot-nlu-trigger.js#isEnabled`,
 * and deliberately so: silencing a *suggestion* on a broken config costs the
 * user nothing, but refusing an explicitly typed `/autopilot <task>` because a
 * comma is missing elsewhere in the file is a denial of service. The asymmetry
 * is a decision, not an oversight.
 *
 * But it must never be a SILENT decision. Degrading to `{}` means the gates
 * default to enabled — so a user who deliberately closed the kill-switch and
 * then broke their JSON would find execution quietly re-opened, with the
 * failure visible nowhere. That is the one outcome worse than either
 * fail-open or fail-closed, so the parse failure is announced on stderr.
 *
 * A **missing** file is not a corrupt one and is silent: plenty of consumer
 * repos have no `artibot.config.json` at all, and warning on every call there
 * would be noise that trains users to ignore the warning that matters.
 *
 * @param {(msg: string) => void} [warn] - WARN sink; defaults to stderr.
 * @returns {object} The `autopilot` block, or `{}`.
 */
export function loadAutopilotConfig(warn = defaultWarn) {
  const cfgPath = nodePath.join(getPluginRoot(), 'artibot.config.json');
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    const block = cfg?.autopilot;
    return block && typeof block === 'object' ? block : {};
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      warn(
        `[artibot] WARN: could not read autopilot config at ${cfgPath} `
        + `(${err?.message || err}). Falling back to defaults — the autopilot `
        + `suggest/execution gates are OPEN. If you disabled autopilot on `
        + `purpose, fix the config: the kill-switch is not in effect right now.`,
      );
    }
    return {};
  }
}

/**
 * Resolve one gate against a config block.
 *
 * @param {object} autopilot - the `autopilot` config block.
 * @param {'suggest'|'execution'} gate
 * @returns {{ enabled: boolean, source: 'explicit'|'legacy'|'default',
 *   legacyMapped: boolean }}
 */
function resolveGate(autopilot, gate) {
  const explicit = autopilot?.[gate]?.enabled;
  if (typeof explicit === 'boolean') {
    return { enabled: explicit, source: 'explicit', legacyMapped: false };
  }
  if (autopilot?.enabled === false) {
    // Conservative both-gate mapping — see the precedence table above.
    return { enabled: false, source: 'legacy', legacyMapped: true };
  }
  return { enabled: true, source: 'default', legacyMapped: false };
}

/**
 * Default WARN sink. Kept injectable so tests observe the warning without
 * racing stderr, and so a caller in a quiet context can swallow it.
 * @param {string} message
 */
function defaultWarn(message) {
  try { process.stderr.write(`${message}\n`); } catch { /* best-effort */ }
}

/**
 * Decide whether an autopilot operation may proceed.
 *
 * Never throws: an unknown operation is refused (fail-closed) rather than
 * defaulting to allow, because the caller list grows faster than this table and
 * a typo must not become a bypass.
 *
 * @param {object} args
 * @param {object} [args.config] - the `autopilot` config block; defaults to
 *   {@link loadAutopilotConfig}. Injectable for tests.
 * @param {string} args.operation - one of {@link OPERATION_GATES}'s keys.
 * @param {boolean} [args.override=false] - one-shot bypass. **Call argument
 *   only** — never sourced from config or env.
 * @param {(msg: string) => void} [args.warn] - WARN sink; defaults to stderr.
 * @returns {{ allowed: boolean, operation: string, gate: string,
 *   source: string, legacyMapped: boolean, reason: string,
 *   warning: string|null, receipt: object|null }}
 */
export function resolveAutopilotConsent({ config, operation, override = false, warn } = {}) {
  const emit = typeof warn === 'function' ? warn : defaultWarn;
  // The loader gets the same sink: a config that failed to parse is reported
  // through the caller's channel, not silently down a different pipe.
  const autopilot = config === undefined ? loadAutopilotConfig(emit) : (config || {});
  const gate = Object.hasOwn(OPERATION_GATES, operation) ? OPERATION_GATES[operation] : null;

  if (!gate) {
    return {
      allowed: false,
      operation: String(operation),
      gate: 'unknown',
      source: 'fail-closed',
      legacyMapped: false,
      reason: `unknown-operation:${String(operation)}`,
      warning: null,
      receipt: null,
    };
  }

  if (gate === 'always') {
    return {
      allowed: true,
      operation,
      gate,
      source: 'always-allowed',
      legacyMapped: false,
      reason: `${operation} is a read/control operation`,
      warning: null,
      receipt: null,
    };
  }

  const resolved = resolveGate(autopilot, gate);
  let warning = null;
  if (resolved.legacyMapped) {
    warning = `[artibot] autopilot.enabled:false is legacy; mapping it to `
      + `autopilot.suggest.enabled:false AND autopilot.execution.enabled:false. `
      + `Set autopilot.${gate}.enabled explicitly to silence this warning.`;
    emit(warning);
  }

  if (resolved.enabled) {
    return {
      allowed: true,
      operation,
      gate,
      source: resolved.source,
      legacyMapped: resolved.legacyMapped,
      reason: `${gate} gate enabled (${resolved.source})`,
      warning,
      receipt: null,
    };
  }

  // Gate is closed. Only an explicit call-argument override reopens it.
  if (override === true) {
    return {
      allowed: true,
      operation,
      gate,
      source: 'override',
      legacyMapped: resolved.legacyMapped,
      reason: `${gate} gate disabled (${resolved.source}) but overridden for this call`,
      warning,
      receipt: buildConsentReceipt({ operation, gate, source: resolved.source }),
    };
  }

  return {
    allowed: false,
    operation,
    gate,
    source: resolved.source,
    legacyMapped: resolved.legacyMapped,
    reason: `autopilot ${gate} disabled (${resolved.source})`,
    warning,
    receipt: null,
  };
}

/**
 * Build the additive consent receipt stamped onto session state when a
 * one-shot override was used. Additive by design — no schema version bump, so
 * a rollback to the previous engine simply ignores the field instead of
 * refusing to load the session (one-way rollback is what a version bump buys
 * you, and it is not worth it for a provenance field).
 *
 * @param {{ operation: string, gate: string, source: string }} args
 * @returns {{ overridden: true, operation: string, gate: string,
 *   configSource: string, at: string }}
 */
export function buildConsentReceipt({ operation, gate, source }) {
  return {
    overridden: true,
    operation,
    gate,
    configSource: source,
    at: new Date().toISOString(),
  };
}

/**
 * Shape a refusal into the engine's caller contract. A blocked operation must
 * be loud: returning a quiet `null`/`undefined` no-op is what lets a disabled
 * autopilot look like a hung one.
 *
 * @param {{ operation: string, reason: string, gate: string }} consent
 * @param {string} [sessionId=null]
 * @returns {{ blocked: true, reason: string, phase: 'BLOCKED',
 *   sessionId: string|null, instruction: object }}
 */
export function buildBlockedResult(consent, sessionId = null) {
  return {
    blocked: true,
    reason: consent.reason,
    phase: 'BLOCKED',
    sessionId,
    instruction: {
      type: 'pause',
      reason: consent.reason,
      operation: consent.operation,
      gate: consent.gate,
      remedy: `set autopilot.${consent.gate}.enabled: true in artibot.config.json`,
    },
  };
}
