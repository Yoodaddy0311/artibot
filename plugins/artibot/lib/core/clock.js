/**
 * `lib/core/clock.js` — the one judge of an injected `now` port.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 *   `now` is `() => Date`. Not epoch milliseconds, not an ISO string.
 *
 * Callers convert internally to whatever they need; `readClock` hands back an
 * ISO timestamp. A port that accepts several shapes looks harmless in any one
 * module and is not: `state-manager.js` passes `() => Date`, `split-state.js`
 * passes `() => Date`, and a permissive third module lets those drift apart
 * with nothing to notice it. One accepted shape is the whole point.
 *
 * ── Why a wrong clock throws ───────────────────────────────────────────────
 * Modules that fold measurements — `verification/unified-verifier.js` is the
 * first — treat "could not be measured" as a reportable value rather than an
 * error, and deliberately do not throw on bad input. A clock of the wrong type
 * is a different kind of thing: it is a defect in the calling code, not a
 * measurement that came back empty, so there is no honest verdict to report
 * about it and a `TypeError` is the right answer.
 *
 * ── Why this sits at L1 ────────────────────────────────────────────────────
 * Three consumers now need it and they are on three different layers —
 * `runtime/event-writer.js` (L5), `project-state/state-manager.js` (L2),
 * `topology/split-state.js` (L4). The rule was defined inside the verification
 * module when it had one consumer; leaving it there would make L5 borrow its
 * clock from a verification module, which is backwards. The definition moves
 * down to the layer everything may import, and
 * `verification/unified-verifier.js` re-exports it so existing import paths
 * keep working.
 *
 * Imports nothing, on purpose: L1 may not import from any higher layer
 * (`eslint.config.js:79`), and this file has no need to import at all.
 *
 * @module lib/core/clock
 */

/**
 * Coarse type name for an error message. Local rather than shared: L1 leaves
 * are meant to stand alone, and a three-line helper is cheaper to repeat than
 * a dependency is to justify.
 *
 * @param {unknown} v
 * @returns {string}
 */
function describeType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Read an injected clock and return an ISO timestamp.
 *
 * `label` prefixes the error messages. An importer passes its own name so the
 * diagnostic points at the function the caller actually called: a developer
 * debugging `writeWorkerState` should not be handed an error naming a module
 * they never invoked.
 *
 * The default names this module, not any one consumer. A core utility whose
 * error prefix named a particular L2 caller would misdirect every other caller;
 * `clock` is what you see when nobody passed a name.
 *
 * @param {unknown} now - Injected clock. Omit (`undefined`) for `new Date()`.
 * @param {string} [label='clock'] - Prefix for the error messages.
 * @returns {string} ISO timestamp.
 * @throws {TypeError} When `now` is present but is not a function, or returns
 *   anything other than a valid `Date`.
 */
export function readClock(now, label = 'clock') {
  if (now === undefined) return new Date().toISOString();
  if (typeof now !== 'function') {
    throw new TypeError(`${label}: now must be a function returning a Date, received ${describeType(now)}`);
  }
  const v = now();
  if (!(v instanceof Date)) {
    throw new TypeError(`${label}: now() must return a Date, received ${describeType(v)}`);
  }
  if (Number.isNaN(v.getTime())) {
    throw new TypeError(`${label}: now() returned an Invalid Date`);
  }
  return v.toISOString();
}
