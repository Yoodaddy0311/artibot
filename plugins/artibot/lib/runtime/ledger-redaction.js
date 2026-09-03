/**
 * The run ledger's redaction layer — secret scrubbing, plus the structural
 * guards that keep the scrub terminating on input nobody vetted.
 *
 * PER FIELD, NEVER PER LINE. Every string is scrubbed before serialization, not
 * after. Scrubbing a finished JSONL line lets a pattern swallow a closing quote
 * and break the framing of the whole file, which is the rule
 * `lib/learning/ledger/spawn-ledger.js` already follows.
 *
 * WHICH SCRUBBER, AND WHY NOT THE ONE THE BRIEF NAMED.
 * `lib/core/guard-registry.js#SECRET_CONTENT_PATTERNS` is module-private — that
 * file exports only its six guard functions — so this module reuses
 * `lib/learning/ledger/redact.js#redactSecrets`, the scrubber the existing
 * ledgers already use. Copying the patterns across would fork a canonical list
 * (Hardening §46). It is scoped to the four secret-bearing categories, so file
 * paths and other non-secret context survive into the ledger, which is the
 * whole point of keeping one. Coverage of the guard-registry shapes
 * (`sk-ant-…`, `AKIA…`, `ghp_…`, `KEY=value`) is asserted in
 * tests/runtime/event-writer.test.js — a measured equivalence, not a hope.
 *
 * TERMINATES ON ANY INPUT, IN WORK PROPORTIONAL TO THE NUMBER OF OBJECTS.
 * `data` is caller-supplied and a caller is allowed to be wrong. Two separate
 * defects have been measured here, and the second is the reason the first
 * fix was not enough:
 *
 *   - A self-referencing object, or one nested tens of thousands deep, recursed
 *     until V8 threw `RangeError: Maximum call stack size exceeded` — straight
 *     through the writer's "never throws" contract and out into whatever hook
 *     process was doing the bookkeeping (reproduced 2026-09-02).
 *   - The cycle guard that fixed it was PATH-SCOPED (add on the way down,
 *     delete on the way up), which is correct for cycles and quadratic-free
 *     for trees, but re-walks every shared subtree once per path that reaches
 *     it. On a DAG where each level points at one child twice, that is 2^depth
 *     work over 2*depth objects: measured 56 ms at depth 16, 626 ms at 20,
 *     2.7 s at 22, roughly 4x per level (2026-09-03, matching the T-49
 *     review's independent numbers). The depth bound did not help — it caps
 *     the STACK, not the work — and the 4 KB line cap runs afterwards, so
 *     nothing downstream could have stopped it either.
 *
 * The fix is a result MEMO keyed by object: each object is redacted once and
 * its result reused, so work is O(objects) rather than O(paths). Cycles are
 * still caught, by a separate in-progress set. A memo cannot apply to a
 * subtree that contains a cycle, though, and a memo makes the RESULT a DAG
 * that `JSON.stringify` expands again — so a third guard, a budget on result
 * NODES, is what makes the bound hold for every shape rather than for the
 * shapes we thought of. See {@link redactDeep}.
 *
 * @module lib/runtime/ledger-redaction
 */

import { redactSecrets } from '../learning/ledger/redact.js';

/**
 * Keys that must never survive into a serialized object. Exported because the
 * envelope assembler drops them too: a prototype-pollution key has to be
 * refused at BOTH the point a caller supplies it and the point it would be
 * written, and one Set is what keeps those two answers the same.
 */
export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Deepest nesting {@link redactDeep} walks before folding to `'[depth]'`.
 *
 * 64 is far past anything a 4 KB line can hold — closing each level costs a
 * byte on its own — so this bound is only reached by input the byte cap would
 * reject regardless. It guards the stack; it is not a schema rule.
 */
export const MAX_REDACT_DEPTH = 64;

/** Written in place of a back-reference that would otherwise recurse forever. */
export const CIRCULAR_MARKER = '[circular]';

/** Written in place of a subtree deeper than {@link MAX_REDACT_DEPTH}. */
export const DEPTH_MARKER = '[depth]';

/**
 * Most nodes one call will put in its RESULT before the rest folds to
 * {@link BUDGET_MARKER}.
 *
 * WHAT IS COUNTED, AND WHY IT IS OCCURRENCES. Every node the result contains,
 * counting a memoized subtree once per place it appears. Counting only fresh
 * walks would bound the work and leave the OUTPUT unbounded, which is not a
 * theoretical distinction: the memo returns a DAG, `JSON.stringify` expands a
 * DAG back into a tree, and 49 shared objects measured 386 MB of JSON and 3.6 s
 * inside `stringify` alone (2026-09-03). The writer serializes every line, so
 * that lands in the writer, where neither this budget nor the 4 KB cap could
 * see it — the cap measures a string that never finishes being built.
 *
 * WHY 4096. The envelope's 4 KB line cap rejects afterwards, so a result over
 * 4K nodes cannot survive anyway: the smallest a node serializes to is `{}`,
 * two bytes, so 4096 of them exceed 4096 bytes before a single key is written.
 * Under occurrence counting that reasoning is sound — under visit counting it
 * was not, which is what the 386 MB measurement above says.
 *
 * This is the guard that holds when the other two do not. The depth bound caps
 * the STACK and the memo caps re-walks of CLEAN subtrees; neither bounds a
 * shared subtree that also contains a cycle, nor the size of a shared result.
 * This does, for every shape, because it counts the thing the line is made of.
 */
export const MAX_REDACT_NODES = 4096;

/** Written in place of everything past {@link MAX_REDACT_NODES} nodes. */
export const BUDGET_MARKER = '[budget]';

/**
 * Per-call state. Created fresh by {@link redactDeep} so nothing survives
 * between calls — a memo that outlived one call would hand a later caller a
 * result scrubbed under different circumstances, and would pin every object it
 * ever saw were it not a WeakMap.
 *
 * @typedef {object} RedactContext
 * @property {WeakMap<object, unknown>} memo completed results, keyed by object
 * @property {WeakSet<object>} inProgress objects on the current path
 * @property {number} pathMarkers how many path-dependent markers have been
 *   emitted — see {@link walk} for why one counter covers all three kinds
 * @property {number} nodes how many nodes the result holds so far, counting a
 *   reused subtree once per occurrence
 */

/**
 * Redact the members of an array or the own keys of an object.
 *
 * @param {object} value
 * @param {number} depth
 * @param {RedactContext} ctx
 * @returns {unknown}
 */
function redactChildren(value, depth, ctx) {
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, ctx));
  const out = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) continue;
    out[key] = walk(value[key], depth + 1, ctx);
  }
  return out;
}

/**
 * Hand back a completed result for `value`, or `undefined` when there is none.
 *
 * Reuse is what makes the walk O(objects); without it a shared subtree is
 * re-walked once per path that reaches it. It still SPENDS budget for every
 * node it hands back, because those nodes end up in the result and the result
 * gets serialized — see {@link MAX_REDACT_NODES}.
 *
 * @param {object} value
 * @param {RedactContext} ctx
 * @returns {unknown} the reused result, a marker, or undefined for a miss
 */
function reuseMemo(value, ctx) {
  const hit = ctx.memo.get(value);
  if (hit === undefined) return undefined;
  if (ctx.nodes + hit.size > MAX_REDACT_NODES) {
    ctx.pathMarkers += 1;
    return BUDGET_MARKER;
  }
  ctx.nodes += hit.size;
  return hit.out;
}

/**
 * The recursive walk. Four guards, in the order they can fire: the depth bound,
 * the memo, the cycle check, then the node budget.
 *
 * WHAT MAY BE MEMOIZED. Only a result that came back CLEAN of both markers.
 * Both are statements about the PATH, not about the object, so a result
 * carrying either one is valid only where it was computed:
 *
 *   - `[depth]` means "too deep from where I stood", so reusing it higher up
 *     truncates a subtree that was never too deep.
 *   - `[circular]` means "this edge points at an ancestor of MINE". Reused as
 *     a sibling it is simply false. For `A={b:B}, B={back:A}` under
 *     `{first:A, second:B}`, memoizing B while walking A hands `second` the
 *     value `{back:'[circular]'}` — but from `second` the path is B -> A -> B,
 *     so the honest answer is `{back:{b:'[circular]'}}`. (T-49 review #7,
 *     reproduced 2026-09-03; a random-graph oracle in
 *     tests/runtime/event-writer.test.js disagreed on ~9% of graphs before
 *     this rule existed.)
 *   - `[budget]` means "the result was already full by the time this was
 *     reached", which is a fact about arrival order, not about the object.
 *
 * ONE COUNTER, NOT TWO. The two cases are checked together at every site and
 * never independently, so a second counter could only ever differ from the
 * first by being wrong.
 *
 * THE COST, AND WHAT NOW BOUNDS IT. A subtree containing a cycle forfeits its
 * memo and is re-walked per path, so a shared subtree that ALSO contains a
 * cycle was still superlinear — 6 ms at depth 14, 19 ms at 16 (2026-09-03).
 * RESOLVED the same day by {@link MAX_REDACT_NODES}: the budget counts result
 * nodes, which every shape spends, so both the walk and what it returns are
 * bounded whether or not the memo applies.
 *
 * @param {unknown} value
 * @param {number} depth
 * @param {RedactContext} ctx
 * @returns {unknown}
 */
function walk(value, depth, ctx) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return redactSecrets(value);
  if (t === 'number' || t === 'boolean') return value;
  if (t !== 'object') return undefined;

  if (depth >= MAX_REDACT_DEPTH) {
    ctx.pathMarkers += 1;
    return DEPTH_MARKER;
  }
  const reused = reuseMemo(value, ctx);
  if (reused !== undefined) return reused;
  // Still on the stack above us, so this edge closes a cycle.
  if (ctx.inProgress.has(value)) {
    ctx.pathMarkers += 1;
    return CIRCULAR_MARKER;
  }
  // Out of budget. Checked AFTER the cycle test so an exhausted walk still
  // reports a cycle as a cycle, which costs nothing and reads truer.
  if (ctx.nodes >= MAX_REDACT_NODES) {
    ctx.pathMarkers += 1;
    return BUDGET_MARKER;
  }

  ctx.nodes += 1;
  const nodesBefore = ctx.nodes;
  ctx.inProgress.add(value);
  const markersBefore = ctx.pathMarkers;
  const out = redactChildren(value, depth, ctx);
  ctx.inProgress.delete(value);

  // Clean of every marker, so the result is true anywhere — see the header.
  // The size travels with it: a later occurrence has to spend that much budget
  // to reuse it, which is what keeps the RESULT bounded and not just the walk.
  if (ctx.pathMarkers === markersBefore) {
    ctx.memo.set(value, { out, size: ctx.nodes - nodesBefore + 1 });
  }
  return out;
}

/**
 * Recursively scrub secrets from every string, returning a new structure.
 *
 * Three guards, each leaving a MARKER rather than dropping a field silently:
 *   - A result memo keyed by object, so each object is redacted once. Work is
 *     proportional to the number of objects, not to the number of paths
 *     through them.
 *   - `inProgress`, the objects on the CURRENT path, so a genuine cycle
 *     becomes {@link CIRCULAR_MARKER}. Cutting the cycle here is also what
 *     stops `JSON.stringify` from throwing on the same input later. A subtree
 *     that produced one is not memoized, because the marker describes the path
 *     rather than the object — see {@link walk}.
 *   - Anything past {@link MAX_REDACT_DEPTH} becomes {@link DEPTH_MARKER}.
 *   - Anything past {@link MAX_REDACT_NODES} nodes of result becomes
 *     {@link BUDGET_MARKER}. This bounds both the work and the SIZE of what
 *     comes back, which is what keeps `JSON.stringify` downstream finite. It
 *     never throws: the walk unwinds normally and the caller still gets an
 *     event.
 *
 * SHARED OUTPUT SUBTREES. Because of the memo, one object appearing twice in
 * the input yields the SAME object twice in the output rather than two copies.
 * That is invisible to `JSON.stringify`, which writes it out both times, and
 * the ledger serializes immediately. Do not mutate the result in place.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactDeep(value) {
  return walk(value, 0, {
    memo: new WeakMap(),
    inProgress: new WeakSet(),
    pathMarkers: 0,
    nodes: 0,
  });
}
