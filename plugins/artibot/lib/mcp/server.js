/**
 * Artibot MCP server — JSON-RPC 2.0 over stdio.
 *
 * Implements the Model Context Protocol 2.0 surface (MCP 2026 draft) without
 * any external dependency. Transport is newline-delimited JSON on stdin/stdout
 * (MCP stdio framing). The server is factory-created so tests can inject
 * custom transports and registries.
 *
 * Supported methods:
 *   - initialize              handshake + capability negotiation
 *   - initialized             no-op notification
 *   - ping                    liveness probe
 *   - tools/list              registered tool catalog
 *   - tools/call              invoke a tool with validated args
 *   - resources/list          static + dynamic resources
 *   - resources/read          fetch resource content by URI
 *   - prompts/list            reusable prompt templates
 *   - prompts/get             fetch a prompt by name
 *   - shutdown                clean exit
 *
 * Error codes follow the JSON-RPC 2.0 spec:
 *   -32700 parse error, -32600 invalid request, -32601 method not found,
 *   -32602 invalid params, -32603 internal error.
 *
 * @module lib/mcp/server
 */

import { createToolRegistry } from './tool-registry.js';

const PROTOCOL_VERSION = '2026-01-01';
const SERVER_NAME = 'artibot';
const SERVER_VERSION = '3.7.0';

const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/**
 * Build a JSON-RPC success response envelope.
 * @param {string|number|null} id
 * @param {unknown} result
 */
function successResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Build a JSON-RPC error response envelope.
 * @param {string|number|null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 */
function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/**
 * Normalize a loaded resource into MCP resource-read shape.
 * @param {string} uri
 * @param {string|object} contents
 */
function normalizeResourceContents(uri, contents) {
  if (typeof contents === 'string') {
    return { contents: [{ uri, mimeType: 'text/plain', text: contents }] };
  }
  if (contents && typeof contents === 'object' && Array.isArray(contents.contents)) {
    return contents;
  }
  return {
    contents: [
      { uri, mimeType: 'application/json', text: JSON.stringify(contents, null, 2) },
    ],
  };
}

/**
 * Validate a JSON-RPC envelope minimally.
 * @param {unknown} msg
 */
function isJsonRpcRequest(msg) {
  return (
    msg !== null
    && typeof msg === 'object'
    && msg.jsonrpc === '2.0'
    && typeof msg.method === 'string'
  );
}

/**
 * Create an Artibot MCP server.
 *
 * @param {object} [options]
 * @param {object} [options.registry] Tool registry (created if omitted).
 * @param {Map<string, Function>} [options.resources] URI -> loader map.
 * @param {Map<string, object>} [options.prompts] name -> prompt definition map.
 * @param {{info:Function,warn:Function,error:Function}} [options.logger]
 * @param {string} [options.name]
 * @param {string} [options.version]
 * @returns {object}
 */
export function createArtibotMcpServer(options = {}) {
  const registry = options.registry || createToolRegistry();
  const resources = options.resources instanceof Map ? options.resources : new Map();
  const prompts = options.prompts instanceof Map ? options.prompts : new Map();
  const logger = options.logger || {
    info: () => {},
    warn: (m) => process.stderr.write(`[mcp] ${m}\n`),
    error: (m) => process.stderr.write(`[mcp] ${m}\n`),
  };
  const name = options.name || SERVER_NAME;
  const version = options.version || SERVER_VERSION;

  const state = {
    initialized: false,
    clientInfo: null,
    clientCapabilities: null,
    shuttingDown: false,
  };

  function capabilities() {
    return {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    };
  }

  async function handleInitialize(params) {
    state.initialized = true;
    state.clientInfo = (params && params.clientInfo) || null;
    state.clientCapabilities = (params && params.capabilities) || null;
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name, version },
      capabilities: capabilities(),
    };
  }

  function handleToolsList() {
    return registry.listTools();
  }

  async function handleToolsCall(params) {
    if (!params || typeof params !== 'object' || typeof params.name !== 'string') {
      const err = new Error("tools/call requires { name: string, arguments?: object }");
      err.code = ERROR_CODES.INVALID_PARAMS;
      throw err;
    }
    const toolName = params.name;
    const args = params.arguments || {};
    if (!registry.hasTool(toolName)) {
      const err = new Error(`tool not found: ${toolName}`);
      err.code = ERROR_CODES.METHOD_NOT_FOUND;
      throw err;
    }
    return registry.callTool(toolName, args, { server: { name, version } });
  }

  function handleResourcesList() {
    const list = [];
    for (const [uri, entry] of resources.entries()) {
      const meta = typeof entry === 'object' && entry && entry.meta ? entry.meta : {};
      list.push({
        uri,
        name: meta.name || uri,
        description: meta.description || '',
        mimeType: meta.mimeType || 'text/plain',
      });
    }
    return { resources: list };
  }

  async function handleResourcesRead(params) {
    if (!params || typeof params.uri !== 'string') {
      const err = new Error('resources/read requires { uri: string }');
      err.code = ERROR_CODES.INVALID_PARAMS;
      throw err;
    }
    const entry = resources.get(params.uri);
    if (!entry) {
      const err = new Error(`resource not found: ${params.uri}`);
      err.code = ERROR_CODES.METHOD_NOT_FOUND;
      throw err;
    }
    const loader = typeof entry === 'function' ? entry : entry.loader;
    if (typeof loader !== 'function') {
      const err = new Error(`resource '${params.uri}' has no loader`);
      err.code = ERROR_CODES.INTERNAL_ERROR;
      throw err;
    }
    const raw = await loader(params);
    return normalizeResourceContents(params.uri, raw);
  }

  function handlePromptsList() {
    const list = [];
    for (const [pname, def] of prompts.entries()) {
      list.push({
        name: pname,
        description: def.description || '',
        arguments: def.arguments || [],
      });
    }
    return { prompts: list };
  }

  async function handlePromptsGet(params) {
    if (!params || typeof params.name !== 'string') {
      const err = new Error('prompts/get requires { name: string }');
      err.code = ERROR_CODES.INVALID_PARAMS;
      throw err;
    }
    const def = prompts.get(params.name);
    if (!def) {
      const err = new Error(`prompt not found: ${params.name}`);
      err.code = ERROR_CODES.METHOD_NOT_FOUND;
      throw err;
    }
    const renderer = typeof def === 'function' ? def : def.render;
    const rendered = typeof renderer === 'function'
      ? await renderer(params.arguments || {})
      : def.messages || [];
    return {
      description: def.description || '',
      messages: Array.isArray(rendered) ? rendered : rendered.messages || [],
    };
  }

  async function handleShutdown() {
    state.shuttingDown = true;
    return {};
  }

  const METHODS = Object.freeze({
    initialize: handleInitialize,
    ping: async () => ({}),
    'tools/list': handleToolsList,
    'tools/call': handleToolsCall,
    'resources/list': handleResourcesList,
    'resources/read': handleResourcesRead,
    'prompts/list': handlePromptsList,
    'prompts/get': handlePromptsGet,
    shutdown: handleShutdown,
  });

  const NOTIFICATIONS = new Set(['initialized', 'notifications/initialized', 'exit']);

  /**
   * Dispatch a parsed JSON-RPC message. Returns the response envelope or
   * `null` for notifications (no response per spec).
   *
   * @param {object} msg
   * @returns {Promise<object|null>}
   */
  async function dispatch(msg) {
    if (!isJsonRpcRequest(msg)) {
      return errorResponse(
        msg && msg.id !== undefined ? msg.id : null,
        ERROR_CODES.INVALID_REQUEST,
        'invalid JSON-RPC 2.0 request',
      );
    }
    if (NOTIFICATIONS.has(msg.method)) {
      return null;
    }
    const handler = METHODS[msg.method];
    if (!handler) {
      return errorResponse(
        msg.id ?? null,
        ERROR_CODES.METHOD_NOT_FOUND,
        `method not found: ${msg.method}`,
      );
    }
    if (msg.method !== 'initialize' && msg.method !== 'ping' && !state.initialized) {
      return errorResponse(
        msg.id ?? null,
        ERROR_CODES.INVALID_REQUEST,
        'server not initialized: send `initialize` first',
      );
    }
    try {
      const result = await handler(msg.params || {});
      return successResponse(msg.id ?? null, result);
    } catch (err) {
      const code = typeof err.code === 'number' ? err.code : ERROR_CODES.INTERNAL_ERROR;
      return errorResponse(msg.id ?? null, code, err.message || 'internal error');
    }
  }

  /**
   * Parse a raw line into a JSON-RPC message. Returns `{error}` for parse fail.
   *
   * @param {string} line
   */
  function parseLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') return { skip: true };
    try {
      return { msg: JSON.parse(trimmed) };
    } catch (err) {
      return { error: err };
    }
  }

  /**
   * Handle one inbound line end-to-end, returning the response envelope
   * (or null for notifications / skip).
   *
   * @param {string} line
   */
  async function handleLine(line) {
    const parsed = parseLine(line);
    if (parsed.skip) return null;
    if (parsed.error) {
      return errorResponse(null, ERROR_CODES.PARSE_ERROR, 'parse error: invalid JSON');
    }
    return dispatch(parsed.msg);
  }

  /**
   * Run the server over arbitrary {read, write} transport streams. `read` is
   * an async iterable yielding lines; `write` is an async function receiving
   * serialized response lines (including trailing \n).
   *
   * @param {{read: AsyncIterable<string>, write: (line:string)=>Promise<void>|void}} transport
   */
  async function run(transport) {
    logger.info(`mcp-server '${name}' v${version} starting`);
    for await (const line of transport.read) {
      if (state.shuttingDown) break;
      const response = await handleLine(line);
      if (response !== null) {
        await transport.write(`${JSON.stringify(response)}\n`);
      }
    }
    logger.info(`mcp-server '${name}' v${version} stopped`);
  }

  return Object.freeze({
    registry,
    resources,
    prompts,
    dispatch,
    handleLine,
    run,
    get state() {
      return { ...state };
    },
    capabilities,
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: Object.freeze({ name, version }),
  });
}

export { ERROR_CODES, PROTOCOL_VERSION };
