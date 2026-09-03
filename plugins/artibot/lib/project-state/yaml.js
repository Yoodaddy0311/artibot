/**
 * Minimal deterministic YAML emitter for the `state.yaml` projection.
 *
 * Why hand-written: the plugin ships with ZERO runtime dependencies
 * (`package.json` has no `dependencies` block — measured 2026-09-02), and the
 * projection is the only YAML this layer writes. Pulling `js-yaml` in to
 * render a document whose shape we fully control would trade a real
 * constraint for a convenience.
 *
 * Scope, deliberately narrow — the emitter handles exactly what
 * `project-state.schema.json` can contain and refuses everything else:
 * strings, finite numbers, booleans, `null`, arrays, plain objects, and
 * ISO-8601 instants (which are strings). Anchors, aliases, tags, multi-line
 * literal blocks, `undefined`, functions, `Date`, `BigInt`, `Symbol`, cyclic
 * references and non-finite numbers all THROW rather than emit something
 * that round-trips wrong. A silent coercion here would corrupt a projection
 * that `/doctor` later byte-compares against the store.
 *
 * Determinism is the load-bearing property: `emitYaml(x)` is a pure function
 * of `x` and of key insertion order, with no clock, locale or randomness. It
 * is what makes "re-render the projection and compare bytes" a usable check
 * (design ARTIBOT-5.0-DESIGN.md §3.6). Key ORDER is the caller's
 * responsibility — this module never sorts, because the projection's field
 * order is part of its contract with the v1.1 §06 example.
 *
 * What it does NOT do: parse. There is no `parseYaml` here and none is
 * needed — the projection is write-only by design (§1-2: state.yaml is
 * regenerated from the store, never read back as truth). Adding a parser
 * would invite exactly the "repair state.yaml by hand" workflow the design
 * forbids.
 *
 * @module lib/project-state/yaml
 */

/** Two spaces per level, matching the v1.1 §06 canonical example. */
const INDENT = '  ';

/**
 * Scalars a YAML reader resolves to a non-string type when left unquoted.
 * `yes/no/on/off/y/n` are included because YAML 1.1 (which many readers still
 * implement) treats them as booleans; quoting them costs nothing and stops an
 * `owns: [n]` glob from becoming `false`.
 */
const RESERVED_PLAIN = /^(?:true|false|null|~|yes|no|on|off|y|n)$/i;

/** Anything a YAML reader would resolve as a number if left unquoted. */
const NUMERIC_PLAIN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Whether a string holds a character that cannot appear in a plain scalar.
 *
 * A codepoint test rather than a regex range: a literal C0 range inside a
 * regex is invisible in a diff and is exactly what `no-control-regex` warns
 * about. DEL (0x7f) is included with C0 because YAML excludes it from the
 * printable set too.
 *
 * @param {string} value - String to test.
 * @returns {boolean} True when a control character is present.
 */
function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Indicator characters that may not open a plain scalar. */
const LEADING_INDICATORS = new Set([
  '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>',
  "'", '"', '%', '@', '`',
]);

/**
 * Decide whether a string must be quoted to survive a round trip.
 *
 * Conservative by construction: every branch answers "could a reader resolve
 * this to something other than this exact string?". A false negative corrupts
 * data; a false positive only adds quotes.
 *
 * @param {string} value - Candidate plain scalar.
 * @returns {boolean} True when the value needs double quotes.
 */
function needsQuoting(value) {
  if (value === '') return true;
  if (value !== value.trim()) return true;
  if (RESERVED_PLAIN.test(value)) return true;
  if (NUMERIC_PLAIN.test(value)) return true;
  if (LEADING_INDICATORS.has(value[0])) return true;
  if (value.includes(': ') || value.endsWith(':')) return true;
  if (value.includes(' #')) return true;
  if (hasControlChar(value)) return true;
  return false;
}

/**
 * Render one string as a YAML scalar.
 *
 * Double quotes with JSON escaping when quoting is needed: JSON's escape set
 * is a subset of YAML's double-quoted escape set, so `JSON.stringify` is a
 * correct encoder here, not merely a convenient one.
 *
 * @param {string} value - The string to render.
 * @returns {string} A YAML scalar.
 */
function emitString(value) {
  return needsQuoting(value) ? JSON.stringify(value) : value;
}

/**
 * Render a non-container value.
 *
 * @param {string|number|boolean|null} value - Scalar to render.
 * @param {string} at - Path of the value, used in error messages.
 * @returns {string} A YAML scalar.
 * @throws {TypeError} When the value is outside the supported scalar set.
 */
function emitScalar(value, at) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return emitString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `emitYaml: non-finite number at ${at} — .inf/.nan do not round-trip through JSON`,
        );
      }
      // Object.is separates -0 from 0. YAML has no -0, so normalise instead of
      // emitting "-0" for a value that reads back as 0.
      return Object.is(value, -0) ? '0' : String(value);
    default:
      throw new TypeError(`emitYaml: unsupported value of type ${typeof value} at ${at}`);
  }
}

/**
 * @param {unknown} value - Value to classify.
 * @returns {boolean} True for a plain object (Object.prototype or null proto).
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value - Value to test.
 * @returns {boolean} True for an array or object holding no entries.
 */
function isEmptyContainer(value) {
  if (Array.isArray(value)) return value.length === 0;
  return isPlainObject(value) && Object.keys(value).length === 0;
}

/**
 * Guard against a cycle, then register the node as an ancestor.
 *
 * @param {object} node - Container being entered.
 * @param {string} at - Path of the node, used in the error message.
 * @param {Set<object>} seen - Ancestors on the current path.
 * @returns {void}
 * @throws {TypeError} When the node is already an ancestor of itself.
 */
function enter(node, at, seen) {
  if (seen.has(node)) throw new TypeError(`emitYaml: circular reference at ${at}`);
  seen.add(node);
}

/**
 * Render a sequence in block style.
 *
 * @param {unknown[]} node - Sequence to render.
 * @param {number} depth - Current indent depth.
 * @param {string} at - Path of the node, used in error messages.
 * @param {Set<object>} seen - Ancestors on the current path.
 * @returns {string[]} Rendered lines.
 */
function emitSequence(node, depth, at, seen) {
  const pad = INDENT.repeat(depth);
  enter(node, at, seen);
  const lines = [];
  node.forEach((item, i) => {
    const childAt = `${at}[${i}]`;
    if (isEmptyContainer(item)) {
      lines.push(`${pad}- ${Array.isArray(item) ? '[]' : '{}'}`);
    } else if (Array.isArray(item) || isPlainObject(item)) {
      const child = emitNode(item, depth + 1, childAt, seen);
      // Hoist the first child line onto the dash so the sequence entry and its
      // first key share a line, as YAML convention expects.
      lines.push(`${pad}- ${child[0].slice((depth + 1) * INDENT.length)}`);
      lines.push(...child.slice(1));
    } else {
      lines.push(`${pad}- ${emitScalar(item, childAt)}`);
    }
  });
  seen.delete(node);
  return lines;
}

/**
 * Render one `key: value` entry of a mapping.
 *
 * @param {string} renderedKey - The already-rendered `pad + key + ':'` prefix.
 * @param {unknown} value - The value to render.
 * @param {number} depth - Indent depth of the KEY.
 * @param {string} at - Path of the value, used in error messages.
 * @param {Set<object>} seen - Ancestors on the current path.
 * @returns {string[]} Rendered lines for this entry.
 */
function emitEntry(renderedKey, value, depth, at, seen) {
  if (isEmptyContainer(value)) {
    return [`${renderedKey} ${Array.isArray(value) ? '[]' : '{}'}`];
  }
  if (Array.isArray(value)) {
    // A sequence sits at its parent's indent — legal YAML, and what the
    // v1.1 §06 example uses.
    return [renderedKey, ...emitNode(value, depth, at, seen)];
  }
  if (isPlainObject(value)) {
    return [renderedKey, ...emitNode(value, depth + 1, at, seen)];
  }
  return [`${renderedKey} ${emitScalar(value, at)}`];
}

/**
 * Render a mapping in block style, preserving key insertion order.
 *
 * @param {object} node - Mapping to render.
 * @param {number} depth - Current indent depth.
 * @param {string} at - Path of the node, used in error messages.
 * @param {Set<object>} seen - Ancestors on the current path.
 * @returns {string[]} Rendered lines.
 */
function emitMapping(node, depth, at, seen) {
  const pad = INDENT.repeat(depth);
  enter(node, at, seen);
  const lines = [];
  for (const [key, value] of Object.entries(node)) {
    const childAt = at ? `${at}.${key}` : key;
    if (value === undefined) {
      throw new TypeError(
        `emitYaml: undefined at ${childAt} — omit the key instead, so the absence is explicit`,
      );
    }
    lines.push(...emitEntry(`${pad}${emitString(String(key))}:`, value, depth, childAt, seen));
  }
  seen.delete(node);
  return lines;
}

/**
 * Recursively render a node at a given indent depth.
 *
 * @param {unknown} node - Value to render.
 * @param {number} depth - Current indent depth.
 * @param {string} at - Path of the node, used in error messages.
 * @param {Set<object>} seen - Ancestors on the current path, for cycle detection.
 * @returns {string[]} Rendered lines, without trailing newlines.
 */
function emitNode(node, depth, at, seen) {
  if (Array.isArray(node)) return emitSequence(node, depth, at, seen);
  if (isPlainObject(node)) return emitMapping(node, depth, at, seen);
  return [`${INDENT.repeat(depth)}${emitScalar(node, at)}`];
}

/**
 * Render a mapping as a YAML document.
 *
 * @param {object} value - Root mapping to render.
 * @returns {string} YAML text terminated by exactly one newline.
 * @throws {TypeError} On unsupported values, cycles, or a non-object root.
 * @example
 * emitYaml({ project: 'artibot', state_version: 12 });
 * // => 'project: artibot\nstate_version: 12\n'
 */
export function emitYaml(value) {
  if (!isPlainObject(value)) {
    throw new TypeError('emitYaml: root must be a plain object');
  }
  if (Object.keys(value).length === 0) return '{}\n';
  return emitNode(value, 0, '', new Set()).join('\n') + '\n';
}
