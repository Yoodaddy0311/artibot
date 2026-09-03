/**
 * Usage receipt writer — the SINGLE producer of Attempt Receipts.
 *
 * Design §3.6 names this module the one writer of the `usage.receipt` ledger
 * event data (`schemas/attempt-receipt.schema.json`). `cache-roi.js` and
 * `token-usage.js` must not also fold token counters into a receipt: two
 * writers over the same numbers is how double counting starts.
 *
 * SOURCE OF TRUTH
 * ---------------
 * Claude Code writes one JSONL transcript per session:
 *
 *   <projects>/<slug>/<session-id>.jsonl                <- main thread
 *   <projects>/<slug>/<session-id>/subagents/agent-*.jsonl  <- one per spawn
 *
 * Each `type: "assistant"` entry carries `message.usage` (input_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens, output_tokens,
 * output_tokens_details.thinking_tokens), `message.model`, a top-level
 * `effort` string, a `requestId` and a `timestamp`. There is NO cost field —
 * which is why {@link buildUsageReceipts} never emits one (see COST below).
 *
 * `lib/learning/model-identity.js#resolveTranscriptModels` walks the very same
 * files but keeps only `message.model` and `effort`, discarding `usage`. This
 * module deliberately does NOT extend it: that file is L3 (learning) and this
 * one is L2 (economics), and an L3 module cannot be imported downward. The
 * traversal is reimplemented here rather than shared.
 *
 * THE FORMAT IS UNDOCUMENTED
 * --------------------------
 * The transcript layout is internal to Claude Code and changes between
 * versions. Every field read below is therefore guarded: a missing REQUIRED
 * key downgrades the affected receipt to `source: 'estimate'` and increments
 * `meta.parseFailures`, instead of throwing or silently producing a confident
 * wrong number. `meta.coverage` is the ratio those two counters exist to
 * produce — the v5 exit criterion "usage measurement coverage >= 95%".
 *
 * COST
 * ----
 * `cost.total` is ALWAYS null here, and that is not a stub. Two price tables
 * exist in this repo and are maintained INDEPENDENTLY — nothing reconciles
 * them: `lib/core/model-catalog.js#MODELS` and
 * `lib/runtime/middleware/cache-roi.js#PRICING_USD_PER_M`.
 *
 * The gap between them is NOT a single factor. Measured 2026-09-03, cache-roi
 * over catalog on input price (output price gives the same four ratios):
 *
 *   haiku 0.8x | sonnet 1.0x | opus 3.0x | fable 3.0x
 *
 * So haiku is cheaper in one table, sonnet is identical, and only opus and
 * fable differ threefold. (An earlier revision of this comment said "~3x",
 * full stop — true for half the tiers and wrong for the other half, which is
 * exactly the kind of number that gets quoted onward as if it covered all
 * four.) The tables are not even the same shape: cache-roi carries cacheRead
 * and cacheWrite columns plus an `unknown` fallback tier, and the catalog has
 * no equivalent for any of them. No code compares the two — repo-wide grep
 * for PRICING_USD_PER_M returns cache-roi.js itself and this comment, and no
 * cross-validation.
 *
 * Picking one is the Shadow-phase "single price table" item. Until it lands,
 * any number this module emitted would be an unverified number wearing a
 * measured label. `cost.pricing_version` is required by the schema even so,
 * and carries {@link PRICING_VERSION_UNRESOLVED} to say exactly that no table
 * was used.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 *  - It does not append to the ledger. It returns receipt DATA; the caller
 *    wraps it in the envelope.
 *  - It does not attribute usage to an action. Transcript entries carry no
 *    mission or action id, so `mission_id` must be supplied by the caller and
 *    `action_id` is always omitted rather than guessed (lane 2 §2.4).
 *  - It does not label outcomes. No user-acceptance signal is recorded
 *    anywhere yet (lane 2 §2.5), so `outcome.accepted` defaults to null,
 *    meaning "not labelled" — never read it as false.
 *
 * @module lib/economics/usage-receipt
 */

import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { CATALOG_VERSION, MODELS } from '../core/model-catalog.js';

/**
 * Receipt schema revision this writer emits. Must match the `const` in
 * `schemas/attempt-receipt.schema.json#/properties/schema_version`.
 * @type {number}
 */
export const SCHEMA_VERSION = 1;

/**
 * Value written to `cost.pricing_version` while no price table is authoritative.
 *
 * The schema makes the field mandatory even when `cost.total` is null, so that
 * a later backfill can tell "priced with table X" from "not priced at all".
 * This constant is the second statement. It is intentionally not a date or a
 * table name: naming a table here would imply one was consulted.
 *
 * @type {string}
 */
export const PRICING_VERSION_UNRESOLVED = 'unresolved';

/**
 * Placeholder model id the harness writes for locally synthesized assistant
 * entries (interrupts, injected notices). Not a served model, so it is counted
 * separately and never folded into a receipt. Same constant as
 * `lib/learning/model-identity.js`; duplicated rather than imported because
 * that module is a layer above this one.
 * @type {string}
 */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * Transcript keys whose absence downgrades an entry to `source: 'estimate'`.
 *
 * Deliberately an ALLOWLIST of what must be present, not a denylist of known
 * bad shapes: a future transcript version that renames a counter must fail
 * closed (downgrade + parseFailure), not pass because it matches no known bad
 * pattern. The optional counters (cache read/write, thinking) are NOT here —
 * their absence normalises to 0 per the schema, which is a weaker statement
 * than a missing required key.
 *
 * @type {readonly string[]}
 */
const REQUIRED_USAGE_KEYS = Object.freeze(['input_tokens', 'output_tokens']);

/**
 * Reverse index: exact catalog model id -> Artibot tier alias.
 * Built once from {@link MODELS} so `tier` is never inferred from the id text.
 * @type {Map<string, string>}
 */
const ID_TO_TIER = new Map(
  Object.entries(MODELS).map(([tier, spec]) => [spec.id, tier]),
);

/**
 * Empty result. Returned whenever nothing readable was found, so a caller can
 * persist it as-is: zero receipts with `coverage: null` says "measured
 * nothing", which is a different statement from "measured zero usage".
 *
 * @returns {{receipts: object[], meta: object}}
 */
export function emptyResult() {
  return {
    receipts: [],
    meta: {
      files: 0,
      unreadableFiles: 0,
      entries: 0,
      measuredEntries: 0,
      parseFailures: 0,
      coverage: null,
      duplicateRequestIds: 0,
      entriesWithoutRequestId: 0,
      entriesWithoutModel: 0,
      syntheticEntries: 0,
      unresolvedModels: {},
      multiModelRuns: [],
      skipped: [],
      sources: { transcript: 0, estimate: 0 },
      effortMixByRun: {},
    },
  };
}

/**
 * Split a transcript model string into the catalog id and its qualifiers.
 *
 * Observed shapes (measured 2026-09-02): a bare catalog id
 * (`claude-fable-5-1`), a dated snapshot (`claude-haiku-4-5-20251001`), and a
 * bracketed context variant (`claude-opus-5[1m]`). The catalog holds only the
 * bare ids, so an exact reverse lookup alone would fail on the other two and
 * throw away real usage. Qualifiers are stripped for the lookup and preserved
 * for `model_identity.version`.
 *
 * @param {string} raw - `message.model` as written in the transcript.
 * @returns {{base: string, qualifiers: string[]}}
 */
function splitModelId(raw) {
  const qualifiers = [];
  let base = raw;

  const variant = base.match(/\[([^\]]+)\]$/);
  if (variant) {
    qualifiers.push(variant[1]);
    base = base.slice(0, variant.index);
  }

  const snapshot = base.match(/-(\d{8})$/);
  if (snapshot) {
    qualifiers.unshift(snapshot[1]);
    base = base.slice(0, snapshot.index);
  }

  return { base, qualifiers };
}

/**
 * Resolve a transcript model string to a schema-valid `model_identity`.
 *
 * `tier` comes from a reverse lookup against the catalog, never from parsing
 * the id text, so a model the catalog does not know yields null rather than a
 * plausible-looking guess. `version` is the qualifier observed in the
 * transcript (snapshot date and/or context variant, joined with `+`); when the
 * transcript carries no qualifier the id itself is the only version pointer
 * that exists, so it is repeated there rather than invented.
 *
 * @param {unknown} rawModelId - `message.model`.
 * @returns {{provider: string, family: string, tier: string, model_id: string,
 *   version: string, catalog_version: string} | null}
 */
export function resolveModelIdentity(rawModelId) {
  if (typeof rawModelId !== 'string' || rawModelId.length === 0) return null;

  const { base, qualifiers } = splitModelId(rawModelId);
  const tier = ID_TO_TIER.get(base);
  if (!tier) return null;

  return {
    provider: 'anthropic',
    family: 'claude',
    tier,
    model_id: base,
    version: qualifiers.length > 0 ? qualifiers.join('+') : base,
    catalog_version: CATALOG_VERSION,
  };
}

/**
 * Read a non-negative integer counter, normalising absence to 0.
 *
 * @param {object} usage
 * @param {string} key
 * @returns {number}
 */
function counter(usage, key) {
  const value = usage?.[key];
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Default file reader port: stream one JSONL file as lines.
 * Replaced in tests so no test ever touches a real home directory.
 *
 * @param {string} filePath
 * @returns {AsyncIterable<string>}
 */
function defaultReadTranscript(filePath) {
  return createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
}

/**
 * Default subagent lister port: the sibling-directory layout Claude Code uses.
 * Returns [] for any unreadable or absent directory — a session with no
 * subagents and a session whose directory cannot be read are indistinguishable
 * here, which is why `meta.unreadableFiles` only counts files.
 *
 * @param {string} transcriptPath - Path to the main session .jsonl
 * @returns {string[]} Absolute subagent transcript paths, sorted.
 */
function defaultListSubagentTranscripts(transcriptPath) {
  const subagentsDir = path.join(
    transcriptPath.replace(/\.jsonl$/i, ''),
    'subagents',
  );
  try {
    return readdirSync(subagentsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(subagentsDir, name));
  } catch {
    return [];
  }
}

/**
 * Normalise whatever a `readTranscript` port returned into a line iterator.
 * Accepts a string (split on newlines), a sync iterable, an async iterable, or
 * a promise of any of those.
 *
 * @param {unknown} result
 * @returns {AsyncGenerator<string>}
 */
async function* toLines(result) {
  const value = await result;
  if (typeof value === 'string') {
    yield* value.split(/\r?\n/);
    return;
  }
  if (value && typeof value[Symbol.asyncIterator] === 'function') {
    yield* value;
    return;
  }
  if (value && typeof value[Symbol.iterator] === 'function') {
    yield* value;
  }
}

/**
 * The run a transcript file belongs to: the file stem, for both kinds of file.
 *
 * One spawn = one Run (§7.2), and a subagent file is named after its spawn
 * (`agent-<id>.jsonl`, where `<id>` is `spawn-ledger.js#agentId`), so its stem
 * IS the run id and joins to `RouteReceipt.routing_epoch_id`. The main thread
 * is NOT a spawn and therefore has no spawn id; its session id is the only
 * stable identifier it has, so that stands in. A caller that needs to tell the
 * two apart must do it by shape (`agent-*` prefix), because this returns the
 * same kind of value for both on purpose — inventing a synthetic main-thread
 * run id would create a key that joins to nothing.
 *
 * @param {string} filePath
 * @returns {string}
 */
function runIdForFile(filePath) {
  return path.basename(filePath).replace(/\.jsonl$/i, '');
}

/**
 * Fresh accumulator for one (run, model) group.
 *
 * @param {string} runId
 * @param {object} identity
 * @returns {object}
 */
function newGroup(runId, identity) {
  return {
    runId,
    identity,
    fresh: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    thinking: 0,
    thinkingSeen: false,
    requests: 0,
    entries: 0,
    failures: 0,
    minTs: null,
    maxTs: null,
  };
}

/**
 * Fold one already-validated assistant entry into its group.
 *
 * @param {object} group
 * @param {object} usage
 * @param {boolean} degraded - Entry was missing a required key.
 * @param {number|null} timestamp - Epoch ms, or null when unparseable.
 * @param {boolean} counted - Entry contributed a distinct requestId.
 * @returns {void}
 */
function foldUsage(group, usage, degraded, timestamp, counted) {
  group.entries += 1;
  if (degraded) group.failures += 1;
  if (counted) group.requests += 1;

  group.fresh += counter(usage, 'input_tokens');
  group.cached += counter(usage, 'cache_read_input_tokens');
  group.cacheWrite += counter(usage, 'cache_creation_input_tokens');
  group.output += counter(usage, 'output_tokens');

  const thinking = usage?.output_tokens_details?.thinking_tokens;
  if (Number.isFinite(thinking) && thinking >= 0) {
    group.thinkingSeen = true;
    group.thinking += Math.trunc(thinking);
  }

  if (timestamp !== null) {
    group.minTs = group.minTs === null ? timestamp : Math.min(group.minTs, timestamp);
    group.maxTs = group.maxTs === null ? timestamp : Math.max(group.maxTs, timestamp);
  }
}

/**
 * Parse an entry timestamp to epoch ms, or null when absent/unparseable.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Fold one parsed JSONL entry into the accumulating state.
 *
 * Every branch that rejects an entry records WHY in a counter, because the
 * coverage ratio this module exists to produce is only meaningful if the
 * denominator's shortfall is itemised.
 *
 * @param {object} state - Mutable accumulator (groups, meta, per-run sets).
 * @param {object} entry - Parsed JSONL entry.
 * @param {string} runId
 * @returns {void}
 */
function foldEntry(state, entry, runId) {
  if (entry?.type !== 'assistant') return;

  const rawModel = entry.message?.model;
  if (rawModel === SYNTHETIC_MODEL) {
    state.meta.syntheticEntries += 1;
    return;
  }

  // Dedup is per RUN, not per group: one API response can be written as
  // several transcript entries that repeat the same `usage` object verbatim,
  // and summing them would inflate every counter. The first entry for a
  // requestId wins; the rest are dropped.
  //
  // This runs BEFORE the entry is counted, on purpose: a repeat is the same
  // attempt written twice, not a second attempt that went unmeasured. Counting
  // it in the denominator would push `coverage` below 1 on a transcript where
  // nothing was actually missed.
  const requestId = typeof entry.requestId === 'string' && entry.requestId.length > 0
    ? entry.requestId
    : null;
  let seen = state.seenRequests.get(runId);
  if (!seen) {
    seen = new Set();
    state.seenRequests.set(runId, seen);
  }
  if (requestId !== null && seen.has(requestId)) {
    state.meta.duplicateRequestIds += 1;
    return;
  }

  state.meta.entries += 1;

  if (typeof rawModel !== 'string' || rawModel.length === 0) {
    state.meta.entriesWithoutModel += 1;
    state.meta.parseFailures += 1;
    return;
  }

  const identity = resolveModelIdentity(rawModel);
  if (identity === null) {
    state.meta.unresolvedModels[rawModel] =
      (state.meta.unresolvedModels[rawModel] ?? 0) + 1;
    return;
  }

  // Claimed only now that the entry is actually being folded: a requestId
  // consumed by an entry that was then dropped for a missing model would make
  // a later, readable entry with the same id look like a duplicate.
  if (requestId === null) {
    state.meta.entriesWithoutRequestId += 1;
  } else {
    seen.add(requestId);
  }

  const usage = entry.message?.usage;
  const degraded =
    usage === null ||
    typeof usage !== 'object' ||
    REQUIRED_USAGE_KEYS.some((key) => !Number.isFinite(usage[key]));
  if (degraded) state.meta.parseFailures += 1;

  // NUL separator: it cannot occur in a run id or a model id, so no pair of
  // values can collide by concatenation. Written as an escape, never as a
  // raw byte — a literal NUL makes grep/ripgrep treat this file as binary and
  // silently stop reporting matches past this line.
  const key = `${runId}\0${identity.model_id}`;
  let group = state.groups.get(key);
  if (!group) {
    group = newGroup(runId, identity);
    state.groups.set(key, group);
  }
  foldUsage(group, usage, degraded, parseTimestamp(entry.timestamp), requestId !== null);

  const effort = typeof entry.effort === 'string' && entry.effort.length > 0
    ? entry.effort
    : 'unspecified';
  const mix = state.meta.effortMixByRun[runId] ?? {};
  mix[effort] = (mix[effort] ?? 0) + 1;
  state.meta.effortMixByRun[runId] = mix;
}

/**
 * Read one transcript file into the accumulator.
 * A malformed line is skipped; an unreadable file keeps whatever was already
 * folded and is counted, because a partial receipt set that says so beats none.
 *
 * @param {object} state
 * @param {string} filePath
 * @param {(p: string) => unknown} readTranscript
 * @returns {Promise<void>}
 */
async function foldFile(state, filePath, readTranscript) {
  const runId = runIdForFile(filePath);
  state.meta.files += 1;
  try {
    for await (const line of toLines(readTranscript(filePath))) {
      if (typeof line !== 'string' || line.length === 0) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      foldEntry(state, entry, runId);
    }
  } catch {
    state.meta.unreadableFiles += 1;
  }
}

/**
 * Normalise a caller-supplied outcome into the schema's `outcome` block.
 *
 * Defaults are deliberately non-committal: `status: 'unknown'` because the
 * transcript records no terminal status, and `accepted: null` because no
 * acceptance signal is recorded anywhere in the repo yet (lane 2 §2.5). A
 * caller that passes garbage gets the default, never a coerced value — false
 * would read as "rejected", which is a claim this module cannot make.
 *
 * @param {unknown} supplied
 * @returns {{status: string, verifier_result?: string, accepted: boolean|null}}
 */
function normaliseOutcome(supplied) {
  const status =
    typeof supplied?.status === 'string' && supplied.status.length > 0
      ? supplied.status
      : 'unknown';
  const accepted = typeof supplied?.accepted === 'boolean' ? supplied.accepted : null;
  const verifier =
    typeof supplied?.verifier_result === 'string' && supplied.verifier_result.length > 0
      ? supplied.verifier_result
      : null;

  return {
    status,
    ...(verifier === null ? {} : { verifier_result: verifier }),
    accepted,
  };
}

/**
 * Turn one folded group into an Attempt Receipt, or explain why it cannot be.
 *
 * @param {object} group
 * @param {string} missionId
 * @param {object} outcomes - run_id -> partial outcome block.
 * @returns {{receipt: object|null, reason: string|null, source: string}}
 */
function buildReceipt(group, missionId, outcomes) {
  const source = group.failures > 0 ? 'estimate' : 'transcript';

  if (group.minTs === null || group.maxTs === null) {
    return { receipt: null, reason: 'no-timestamp', source };
  }

  const usage = {
    source,
    fresh_input_tokens: group.fresh,
    cached_input_tokens: group.cached,
    cache_creation_tokens: group.cacheWrite,
    output_tokens: group.output,
    // Absent thinking_tokens is not the same statement as 0 (schema), so the
    // key only appears when at least one entry actually reported it.
    ...(group.thinkingSeen ? { thinking_tokens: group.thinking } : {}),
    // The schema marks `requests` unavailable for an estimate-graded receipt.
    ...(source === 'transcript' ? { requests: group.requests } : {}),
  };

  return {
    receipt: {
      schema_version: SCHEMA_VERSION,
      run_id: group.runId,
      mission_id: missionId,
      // action_id is intentionally absent: transcript entries carry no action
      // id and guessing one would poison every per-action aggregate built on
      // this receipt.
      model_identity: group.identity,
      usage,
      timing: {
        started_at: new Date(group.minTs).toISOString(),
        completed_at: new Date(group.maxTs).toISOString(),
        latency_ms: group.maxTs - group.minTs,
      },
      outcome: normaliseOutcome(outcomes[group.runId]),
      cost: { total: null, pricing_version: PRICING_VERSION_UNRESOLVED },
    },
    reason: null,
    source,
  };
}

/**
 * Build every Attempt Receipt derivable from one session transcript.
 *
 * Grouping is by (run, model). A run that served exactly one model — the
 * observed case for a subagent file — yields exactly one receipt, matching
 * §42's "one receipt per Run". A run that served more than one yields one
 * receipt per model and is listed in `meta.multiModelRuns`: splitting states
 * the truth, whereas collapsing would attribute one model's tokens to another.
 *
 * Never throws on transcript CONTENT: a missing file, a truncated line, an
 * unknown model or a renamed counter all resolve to a counter in `meta`.
 * Invalid ARGUMENTS do throw — a receipt carrying a fabricated mission id is
 * worse than no receipt at all.
 *
 * @param {object} options
 * @param {string} options.transcriptPath - Absolute path to the session .jsonl.
 * @param {string} options.missionId - Mission the session belongs to. Required:
 *   the transcript does not contain it.
 * @param {Record<string, object>} [options.outcomes] - run_id -> `{status,
 *   verifier_result, accepted}` overrides. Anything absent stays unlabelled.
 * @param {(filePath: string) => unknown} [options.readTranscript] - File port.
 *   Returns a string, an iterable of lines, an async iterable, or a promise of
 *   any of those. Injected in tests so no test reads a real home directory.
 * @param {(transcriptPath: string) => string[]|Promise<string[]>} [options.listSubagentTranscripts]
 *   - Subagent discovery port.
 * @returns {Promise<{receipts: object[], meta: object}>}
 * @throws {TypeError} When `transcriptPath` or `missionId` is not a non-empty string.
 *
 * @example
 * const { receipts, meta } = await buildUsageReceipts({
 *   transcriptPath: '/p/abc.jsonl',
 *   missionId: 'm-0001',
 * });
 * meta.coverage; // 1 when every assistant entry parsed cleanly
 */
export async function buildUsageReceipts(options) {
  const { transcriptPath, missionId, outcomes = {} } = options ?? {};
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    throw new TypeError('buildUsageReceipts: transcriptPath must be a non-empty string');
  }
  if (typeof missionId !== 'string' || missionId.length === 0) {
    throw new TypeError('buildUsageReceipts: missionId must be a non-empty string');
  }

  const readTranscript = options.readTranscript ?? defaultReadTranscript;
  const listSubagents = options.listSubagentTranscripts ?? defaultListSubagentTranscripts;

  const state = {
    groups: new Map(),
    seenRequests: new Map(),
    meta: emptyResult().meta,
  };

  await foldFile(state, transcriptPath, readTranscript);

  let subagentFiles;
  try {
    subagentFiles = (await listSubagents(transcriptPath)) ?? [];
  } catch {
    // A lister that throws is indistinguishable here from a session with no
    // subagents. Both mean "fold the main thread only" — the alternative,
    // failing the whole call, would throw away a main-thread receipt that was
    // already read successfully.
    subagentFiles = [];
  }
  for (const file of subagentFiles) {
    await foldFile(state, file, readTranscript);
  }

  return finalise(state, missionId, outcomes);
}

/**
 * Turn folded groups into receipts and close out the coverage counters.
 *
 * @param {object} state
 * @param {string} missionId
 * @param {Record<string, object>} outcomes
 * @returns {{receipts: object[], meta: object}}
 */
function finalise(state, missionId, outcomes) {
  const { meta } = state;
  const receipts = [];
  const modelsPerRun = new Map();

  const ordered = [...state.groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, group] of ordered) {
    const models = modelsPerRun.get(group.runId) ?? new Set();
    models.add(group.identity.model_id);
    modelsPerRun.set(group.runId, models);

    const { receipt, reason, source } = buildReceipt(group, missionId, outcomes);
    if (receipt === null) {
      meta.skipped.push({
        run_id: group.runId,
        model_id: group.identity.model_id,
        reason,
        entries: group.entries,
      });
      continue;
    }
    meta.sources[source] += 1;
    if (source === 'transcript') meta.measuredEntries += group.entries;
    receipts.push(receipt);
  }

  meta.multiModelRuns = [...modelsPerRun.entries()]
    .filter(([, models]) => models.size > 1)
    .map(([runId]) => runId)
    .sort();

  // Coverage is measured entries over ALL assistant entries seen — not over
  // the ones that happened to produce a receipt. An entry dropped for an
  // unknown model or a missing timestamp is a measurement miss, and hiding it
  // in the denominator would make the ratio flatter to look at and useless.
  meta.coverage = meta.entries === 0 ? null : meta.measuredEntries / meta.entries;

  return { receipts, meta };
}
