#!/usr/bin/env node
/**
 * artibot-mcp — Artibot MCP server entrypoint (stdio transport).
 *
 * Exposes Artibot's read-only tools (git status/log, skill/agent lookup,
 * runtime hints) to any MCP host (Claude Desktop, Claude Code, IDE plugins)
 * over Model Context Protocol's stdio JSON-RPC 2.0 transport.
 *
 * Protocol: newline-delimited JSON on stdin/stdout (NDJSON). stderr is
 * reserved for human-readable logs — never write protocol frames there,
 * and never write logs to stdout (would corrupt the JSON-RPC stream).
 *
 * Usage:
 *   artibot-mcp                  # run MCP server (stdio)
 *   artibot-mcp --help           # print help
 *   artibot-mcp --version        # print package.json version
 *
 * Security:
 *   - Local stdio only. No network bind, no auth layer.
 *   - Git bridges are read-only (status/log/diff/show).
 *   - External network: 0.
 *
 * @module bin/artibot-mcp
 */

import { readFileSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

process.env.CLAUDE_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || PLUGIN_ROOT;

/**
 * Load package.json version at runtime so --version can never drift.
 * @returns {string}
 */
function loadVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const HELP = `
artibot-mcp ${loadVersion()}
Artibot MCP server (Model Context Protocol, stdio transport).

Usage:
  artibot-mcp [options]

Options:
  --help, -h        Show this help
  --version, -v     Show version

Transport:
  stdio JSON-RPC 2.0, newline-delimited JSON. stderr for logs only.

Security:
  Local stdio only — no network bind. Git bridges are read-only.

MCP host config (Claude Desktop / Claude Code):
  {
    "mcpServers": {
      "artibot": { "command": "artibot-mcp" }
    }
  }
`.trim();

/**
 * Parse argv into a flat flags object. Unknown flags throw.
 * @param {string[]} argv
 * @returns {{ help: boolean, version: boolean }}
 */
export function parseArgs(argv) {
  const out = { help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

/**
 * Attempt to dynamically load the MCP server factory from lib/mcp/server.js
 * (MS1) and bridges from lib/mcp/bridges/index.js (MS2). Both are optional
 * at bin boot so the CLI can still print --version / --help even before
 * those modules land.
 * @returns {Promise<{ createArtibotMcpServer?: Function, wireBridges?: Function }>}
 */
async function loadServerModules() {
  const mods = {};
  try {
    const serverMod = await import(
      // Avoid Windows percent-encoding issues on Korean paths by using
      // file:// URL path via fileURLToPath.
      new URL('../lib/mcp/server.js', import.meta.url).href
    );
    mods.createArtibotMcpServer = serverMod.createArtibotMcpServer;
  } catch (err) {
    mods._serverError = err;
  }
  try {
    const bridgesMod = await import(
      new URL('../lib/mcp/bridges/index.js', import.meta.url).href
    );
    mods.wireBridges = bridgesMod.wireBridges;
  } catch (err) {
    mods._bridgesError = err;
  }
  return mods;
}

/**
 * Minimal fallback JSON-RPC stdio loop used when MS1's server factory is
 * unavailable. Responds to `initialize` / `tools/list` with empty tool set
 * and surfaces a warning on stderr. Kept tiny on purpose — real logic
 * lives in lib/mcp/server.js once MS1 lands.
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 * @param {NodeJS.WritableStream} stderr
 * @returns {Promise<void>}
 */
export function fallbackStdioLoop(stdin, stdout, stderr) {
  stderr.write('[artibot-mcp] server module not found — running minimal fallback.\n');
  return new Promise((resolvePromise) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf-8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }) + '\n'
          );
          continue;
        }
        handleFallback(msg, stdout);
      }
    };
    stdin.on('data', onData);
    stdin.on('end', () => resolvePromise());
    stdin.on('close', () => resolvePromise());
  });
}

function handleFallback(msg, stdout) {
  const id = msg?.id ?? null;
  const method = msg?.method;
  if (method === 'initialize') {
    stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'artibot-mcp', version: loadVersion() },
        },
      }) + '\n'
    );
    return;
  }
  if (method === 'tools/list') {
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [] } }) + '\n');
    return;
  }
  if (method === 'ping') {
    stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }) + '\n');
    return;
  }
  if (id !== null && id !== undefined) {
    stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      }) + '\n'
    );
  }
}

/**
 * Create and bridge-wire the server from loaded modules. Returns
 * `{ server, failed }` — when `failed` is true, caller should return early
 * (process.exitCode already set and error logged).
 * @param {object} mods
 * @param {{stdin:NodeJS.ReadableStream, stdout:NodeJS.WritableStream, stderr:NodeJS.WritableStream}} io
 */
async function bootServer(mods, { stdin, stdout, stderr }) {
  if (typeof mods.createArtibotMcpServer !== 'function') {
    return { server: null, failed: false };
  }
  let server;
  try {
    server = await mods.createArtibotMcpServer({
      pluginRoot: PLUGIN_ROOT,
      name: 'artibot-mcp',
      version: loadVersion(),
      stdin,
      stdout,
      stderr,
    });
  } catch (err) {
    stderr.write(`[artibot-mcp] server failed to start: ${err?.message ?? err}\n`);
    process.exitCode = 1;
    return { server: null, failed: true };
  }
  if (typeof mods.wireBridges === 'function') {
    try {
      await mods.wireBridges(server, { pluginRoot: PLUGIN_ROOT });
    } catch (err) {
      stderr.write(`[artibot-mcp] bridge wiring failed: ${err?.message ?? err}\n`);
    }
  }
  return { server, failed: false };
}

/**
 * CLI entry. Exported for tests.
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {NodeJS.ReadableStream} [deps.stdin]
 * @param {NodeJS.WritableStream} [deps.stdout]
 * @param {NodeJS.WritableStream} [deps.stderr]
 * @param {Function} [deps.loadModules]
 */
export async function main(argv, deps = {}) {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const loadModules = deps.loadModules ?? loadServerModules;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n\n${HELP}\n`);
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    stdout.write(`${HELP}\n`);
    return;
  }
  if (args.version) {
    stdout.write(`${loadVersion()}\n`);
    return;
  }

  const mods = await loadModules();
  const boot = await bootServer(mods, { stdin, stdout, stderr });
  if (boot.failed) return;
  const server = boot.server;

  const shutdown = async (sig) => {
    stderr.write(`[artibot-mcp] ${sig} received — stopping.\n`);
    try {
      if (server && typeof server.close === 'function') await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Run loop: prefer MS1 contract `server.run({read, write})`. Fall back to
  // `server.start()` + `server.waitUntilClosed()` for test mocks, and to the
  // built-in fallback loop when no server module is present.
  if (server && typeof server.run === 'function') {
    await server.run(createStdioTransport(stdin, stdout));
  } else if (server && typeof server.start === 'function') {
    await server.start();
    if (typeof server.waitUntilClosed === 'function') {
      await server.waitUntilClosed();
    }
  } else if (!server) {
    await fallbackStdioLoop(stdin, stdout, stderr);
  }
}

/**
 * Wrap a Node.js stdin/stdout pair into the {read, write} transport MS1
 * expects. `read` is an async iterable of line strings (NDJSON framed),
 * `write` serializes one response line.
 * @param {NodeJS.ReadableStream} stdin
 * @param {NodeJS.WritableStream} stdout
 */
function createStdioTransport(stdin, stdout) {
  async function* lines() {
    let buf = '';
    stdin.setEncoding?.('utf-8');
    for await (const chunk of stdin) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length > 0) yield line;
      }
    }
    if (buf.trim().length > 0) yield buf;
  }
  return {
    read: lines(),
    write: (line) =>
      new Promise((resolvePromise, reject) => {
        stdout.write(line, (err) => (err ? reject(err) : resolvePromise()));
      }),
  };
}

const invokedFromCli =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedFromCli) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[artibot-mcp] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
