/**
 * MCP tool registry — registration, validation, dispatch.
 *
 * Implements a minimal JSON-Schema validator (type + required + enum) so the
 * registry has zero runtime deps and stays Korean-path safe. A Tool entry is
 * immutable; calling `registerTool` with the same name twice throws unless
 * `replace: true` is set explicitly.
 *
 * Contract:
 *   - Tools are pure-ish handlers: `(args, ctx) => result | Promise<result>`.
 *   - `listTools()` returns MCP-shaped `{tools: [{name, description, inputSchema}]}`.
 *   - `callTool(name, args, ctx)` returns MCP `content[]` shape:
 *       `{ content: [{type:"text", text: "..."}], isError?: boolean }`.
 *   - Handler exceptions are caught and surfaced as `isError: true` with a
 *     human-readable text block; they never throw out of `callTool`.
 *
 * @module lib/mcp/tool-registry
 */

const TYPE_CHECKERS = Object.freeze({
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
});

/**
 * Validate a single value against a JSON-Schema-ish node.
 * Supports: type, required (for object), enum, items.type.
 *
 * @param {unknown} value
 * @param {object} schema
 * @param {string} pathLabel
 * @returns {{ok:true}|{ok:false,error:string}}
 */
function validateNode(value, schema, pathLabel) {
  if (!schema || typeof schema !== 'object') return { ok: true };
  if (schema.type) {
    const checker = TYPE_CHECKERS[schema.type];
    if (!checker) {
      return { ok: false, error: `unknown type '${schema.type}' at ${pathLabel}` };
    }
    if (!checker(value)) {
      return {
        ok: false,
        error: `expected ${schema.type} at ${pathLabel}, got ${typeof value}`,
      };
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return {
      ok: false,
      error: `value at ${pathLabel} must be one of ${JSON.stringify(schema.enum)}`,
    };
  }
  if (schema.type === 'array' && schema.items) {
    for (let i = 0; i < value.length; i += 1) {
      const sub = validateNode(value[i], schema.items, `${pathLabel}[${i}]`);
      if (!sub.ok) return sub;
    }
  }
  if (schema.type === 'object') {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        return { ok: false, error: `missing required field '${key}' at ${pathLabel}` };
      }
    }
    const props = schema.properties || {};
    for (const [key, subSchema] of Object.entries(props)) {
      if (!(key in value)) continue;
      const sub = validateNode(value[key], subSchema, `${pathLabel}.${key}`);
      if (!sub.ok) return sub;
    }
  }
  return { ok: true };
}

/**
 * Validate tool args against its input schema.
 *
 * @param {unknown} args
 * @param {object} schema
 * @returns {{ok:true}|{ok:false,error:string}}
 */
export function validateArgs(args, schema) {
  if (!schema) return { ok: true };
  const target = args === null || args === undefined ? {} : args;
  return validateNode(target, schema, 'args');
}

/**
 * Normalize a thrown error into an MCP content-array result with isError.
 *
 * @param {unknown} err
 * @returns {{content: Array<{type:string,text:string}>, isError: true}}
 */
function errorResult(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text', text: msg }],
    isError: true,
  };
}

/**
 * Wrap a raw handler return value in the MCP content-array shape if it's not
 * already wrapped. Strings become a single text block; objects are JSON-ified.
 *
 * @param {unknown} raw
 * @returns {{content: Array<{type:string,text:string}>}}
 */
function normalizeResult(raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
    return raw;
  }
  if (typeof raw === 'string') {
    return { content: [{ type: 'text', text: raw }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }] };
}

/**
 * Create an MCP tool registry.
 *
 * @returns {object}
 */
export function createToolRegistry() {
  /** @type {Map<string, {name:string, description:string, inputSchema:object, handler:Function}>} */
  const tools = new Map();

  function registerTool(def, options = {}) {
    if (!def || typeof def !== 'object') {
      throw new Error('registerTool: definition object required');
    }
    const { name, description = '', inputSchema = { type: 'object', properties: {} }, handler } = def;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('registerTool: name must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new Error(`registerTool: handler for '${name}' must be a function`);
    }
    if (tools.has(name) && !options.replace) {
      throw new Error(`registerTool: tool '${name}' already registered`);
    }
    tools.set(name, Object.freeze({ name, description, inputSchema, handler }));
    return tools.get(name);
  }

  function registerMany(list, options) {
    const results = [];
    for (const def of list) results.push(registerTool(def, options));
    return results;
  }

  function hasTool(name) {
    return tools.has(name);
  }

  function getTool(name) {
    return tools.get(name) || null;
  }

  function listTools() {
    const arr = [...tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools: arr };
  }

  async function callTool(name, args, ctx = {}) {
    const tool = tools.get(name);
    if (!tool) {
      return errorResult(new Error(`tool not found: ${name}`));
    }
    const validation = validateArgs(args, tool.inputSchema);
    if (!validation.ok) {
      return errorResult(new Error(`invalid params: ${validation.error}`));
    }
    try {
      const raw = await tool.handler(args || {}, ctx);
      return normalizeResult(raw);
    } catch (err) {
      return errorResult(err);
    }
  }

  function unregister(name) {
    return tools.delete(name);
  }

  function size() {
    return tools.size;
  }

  return Object.freeze({
    registerTool,
    registerMany,
    hasTool,
    getTool,
    listTools,
    callTool,
    unregister,
    size,
  });
}
