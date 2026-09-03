/**
 * A dependency-free JSON Schema subset validator, used by the run-ledger writer
 * to run the three receipt schemas that own their events' `data` object.
 *
 * WHY THIS EXISTS RATHER THAN ajv. `route.selected`, `context.compiled` and
 * `usage.receipt` delegate their whole `data` object to a sibling receipt
 * schema (the T-15 to T-16 ruling), so the writer has to actually run that
 * schema. It does not do so with ajv, and that is a deliberate refusal:
 *
 *   - ajv resolves in this checkout ONLY as a transitive of a devDependency
 *     (eslint -> ajv), is declared in no package.json, and `node_modules/` is
 *     gitignored. Measured across the whole tree, `lib/` imports NOTHING
 *     outside `node:` builtins — that is the "zero runtime deps" contract in
 *     CLAUDE.md, and this module would have been the first exception.
 *   - A static import of a package that may be absent is a module-load throw.
 *     The writer's whole contract is that it never throws, and its callers are
 *     hooks: a missing module would kill the process over bookkeeping.
 *
 * WHAT IS ENFORCED: local `$ref` (`#/definitions/...`), `type` (including type
 * arrays), `required` at every depth, `properties`, `additionalProperties:
 * false`, `enum`, `const`, `items`, `minimum`, `maximum`, `minLength`,
 * `minItems`, `pattern`.
 *
 * WHAT IS NOT: `allOf`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`, `format`,
 * and any non-local `$ref`. Every keyword in that list only ever ADDS a
 * constraint, so skipping one can let an invalid document through — it can
 * never reject a valid one. Two places cost something today, both in
 * route-receipt: the nullable `models.current` (`oneOf`) and the
 * `source:"shadow"` -> `shadow_of` conditional (`allOf`/`if`).
 *
 * That distance is MEASURED, not assumed:
 * `tests/firewall/ledger-vocab-allowlist.test.js` compiles the same schemas
 * with real ajv and requires the two to reach the same verdict on a fixture set
 * spanning every enforced keyword, plus one fixture that demonstrates the
 * `if`/`then` gap explicitly.
 *
 * ALSO HERE: the enum case-fold table, which is the other half of "does
 * this value conform to what was declared" — see ENUM_CASE_FOLD below.
 *
 * @module lib/runtime/ledger-schema
 */

/** Keywords this validator knowingly does not run. Declared, not silent. */
export const UNCHECKED_SCHEMA_KEYWORDS = Object.freeze([
  'allOf', 'oneOf', 'anyOf', 'not', 'if', 'then', 'else', 'format',
]);

/**
 * Does a value satisfy a JSON Schema `type` declaration? `type` may be a single
 * type name or an array of them (`["boolean","null"]`).
 *
 * @param {unknown} value
 * @param {string|string[]} type
 * @returns {boolean}
 */
export function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === 'null') return value === null;
    if (t === 'array') return Array.isArray(value);
    if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (t === 'integer') return Number.isInteger(value);
    if (t === 'number') return typeof value === 'number';
    return typeof value === t;
  });
}

/**
 * Follow local `$ref` hops to the node that actually carries the constraints.
 *
 * @param {object} node
 * @param {object} root the document `$ref` is relative to
 * @returns {object|null} null when a ref is external or cannot be resolved
 */
function resolveNode(node, root) {
  let cur = node;
  for (let hops = 0; cur && typeof cur.$ref === 'string'; hops += 1) {
    if (hops >= 8 || !cur.$ref.startsWith('#/')) return null;
    let target = root;
    for (const seg of cur.$ref.slice(2).split('/')) {
      target = target?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    cur = target;
  }
  return cur && typeof cur === 'object' ? cur : null;
}

/**
 * Keyword checks that apply to a scalar value.
 *
 * @param {unknown} value
 * @param {object} s resolved schema node
 * @param {string} at dotted path, for the failure message
 * @returns {string|null}
 */
function checkScalarKeywords(value, s, at) {
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return `minimum:${at}`;
    if (typeof s.maximum === 'number' && value > s.maximum) return `maximum:${at}`;
  }
  if (typeof value === 'string') {
    if (Number.isFinite(s.minLength) && value.length < s.minLength) return `minLength:${at}`;
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value)) return `pattern:${at}`;
  }
  return null;
}

/**
 * Keyword checks for an array value.
 *
 * @param {unknown[]} value
 * @param {object} s
 * @param {object} root
 * @param {string} at
 * @returns {string|null}
 */
function checkArrayNode(value, s, root, at) {
  if (Number.isFinite(s.minItems) && value.length < s.minItems) return `minItems:${at}`;
  if (!s.items) return null;
  for (let i = 0; i < value.length; i += 1) {
    const err = checkNode(value[i], s.items, root, `${at}[${i}]`);
    if (err) return err;
  }
  return null;
}

/**
 * Keyword checks for an object value: required keys, the closed key set, and
 * each declared property in turn.
 *
 * `additionalProperties:false` is applied against THIS node's own `properties`
 * only, which is what a real validator does as well — a sibling `allOf` branch
 * does not widen the permitted key set.
 *
 * @param {object} value
 * @param {object} s
 * @param {object} root
 * @param {string} at
 * @returns {string|null}
 */
function checkObjectNode(value, s, root, at) {
  const prefix = at ? `${at}.` : '';
  for (const key of s.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return `required:${prefix}${key}`;
  }
  const props = s.properties ?? {};
  if (s.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) return `additional:${prefix}${key}`;
    }
  }
  for (const [key, sub] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const err = checkNode(value[key], sub, root, `${prefix}${key}`);
    if (err) return err;
  }
  return null;
}

/**
 * Validate one value against one schema node.
 *
 * @param {unknown} value
 * @param {object} node
 * @param {object} root
 * @param {string} at
 * @returns {string|null} `<keyword>:<path>`, or null when the node is satisfied
 */
function checkNode(value, node, root, at) {
  const s = resolveNode(node, root);
  if (!s) return null; // unresolvable ref: unchecked, never a false rejection
  if (s.type !== undefined && !matchesType(value, s.type)) return `type:${at || 'data'}`;
  if (Array.isArray(s.enum) && !s.enum.includes(value)) return `enum:${at || 'data'}`;
  if (s.const !== undefined && value !== s.const) return `const:${at || 'data'}`;
  const scalar = checkScalarKeywords(value, s, at || 'data');
  if (scalar) return scalar;
  if (Array.isArray(value)) return checkArrayNode(value, s, root, at || 'data');
  if (value !== null && typeof value === 'object') return checkObjectNode(value, s, root, at);
  return null;
}

/**
 * Validate a document against a schema. Pure — reads both, mutates neither.
 *
 * @param {unknown} data
 * @param {object} schema the schema document, which is also the `$ref` root
 * @returns {string|null} a short `<keyword>:<path>` reason, or null when valid
 */
export function validateAgainstSchema(data, schema) {
  return checkNode(data, schema, schema, '');
}

// ---------------------------------------------------------------------------
// Enum case folding
// ---------------------------------------------------------------------------

/**
 * The enums whose incoming values are case-folded before validation, and the
 * direction of the fold.
 *
 * ONE ENTRY, ON PURPOSE. `unified-verifier` reports `PASS|FAIL|UNMEASURED`
 * while the ledger's `verify_result` enum is lowercase, so a `verify.completed`
 * line would be rejected over a difference of case alone. `review_verdict` is
 * deliberately ABSENT: its five values are uppercase in the allowlist because
 * uppercase IS the canonical spelling there, and folding them would corrupt the
 * vocabulary rather than repair it. Keyed by enum rather than by event so a
 * later event reusing `verify_result` inherits the same rule.
 *
 * The fold is an allowlist of two spellings — the canonical value and its full
 * uppercase form. A mixed-case value such as `Pass` matches neither and is
 * rejected, because `toLowerCase()` on anything would quietly widen the
 * vocabulary every time a caller invented a new spelling.
 */
export const ENUM_CASE_FOLD = Object.freeze({ verify_result: 'lower' });

/**
 * The canonical spelling of `value`, or undefined when it is neither of the two
 * accepted forms.
 * @param {unknown} value
 * @param {string[]} allowed
 * @returns {string|undefined}
 */
function canonicalSpelling(value, allowed) {
  if (typeof value !== 'string' || !Array.isArray(allowed)) return undefined;
  return allowed.find((v) => v === value || v.toUpperCase() === value);
}

/**
 * Return an envelope whose case-folded enum fields carry canonical spellings.
 * Pure — returns the same object when nothing needed folding. The allowlist is
 * a parameter so this module never imports the writer that owns it.
 *
 * @param {object} env
 * @param {{events: object, enums: object}} allowlist
 * @returns {object}
 */
export function foldDeclaredEnums(env, allowlist) {
  const { events, enums } = allowlist;
  const spec = events[env.event];
  if (!spec?.fields || !env.data || typeof env.data !== 'object') return env;
  const data = { ...env.data };
  let changed = false;
  for (const [key, decl] of Object.entries(spec.fields)) {
    const ref = decl?.enum_ref;
    if (!ref || ENUM_CASE_FOLD[ref] !== 'lower') continue;
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const canonical = canonicalSpelling(data[key], enums[ref]);
    if (canonical === undefined || canonical === data[key]) continue;
    data[key] = canonical;
    changed = true;
  }
  return changed ? { ...env, data } : env;
}
