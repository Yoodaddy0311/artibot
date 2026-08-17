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
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from '../scripts/hooks/_main-entry.js';

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
 * (MS1) and bridges from lib/mcp/bridge/index.js (MS2). Both are optional
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
      new URL('../lib/mcp/bridge/index.js', import.meta.url).href
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
    // A Buffer chunk decoded on its own loses the tail of any multibyte
    // character that straddles the chunk boundary, so 64KB of Korean text
    // arrives with a U+FFFD sitting inside a JSON-RPC frame. StringDecoder
    // holds the incomplete sequence until the next chunk completes it.
    //
    // Deliberately NOT `stdin.setEncoding(...)`, which is what
    // createStdioTransport uses: that call is optional-chained there because
    // a caller may inject a stream that does not implement it, and on such a
    // stream setEncoding is a silent no-op while the corruption survives.
    // Decoding the chunks themselves depends on nothing the stream provides,
    // and does not reconfigure a stream this function was handed rather than
    // opened. Collecting every chunk and decoding once — the readPayload
    // shape in scripts/hooks/_dispatcher-utils.js — is not available here:
    // this loop has to answer `initialize` long before stdin ends.
    const decoder = new StringDecoder('utf-8');
    const onData = (chunk) => {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
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
    // Same decode contract as fallbackStdioLoop, and deliberately the same
    // shape: one answer in this file to "how is stdin turned into text".
    //
    // This replaces a `stdin.setEncoding?.('utf-8')` that used to sit here.
    // That call was correct whenever the stream implemented it — measured
    // 2026-08-15, a normal Readable round-tripped 315,037 bytes of Korean
    // intact — but its own optional chaining conceded that a caller may
    // inject a stream without it, and on such a stream it was a silent no-op
    // while `buf += chunk` decoded every 64KB chunk in isolation: the same
    // measurement over a Readable with setEncoding removed came back with 5
    // U+FFFD. Keeping both would have left the decoder unreached on every
    // stream that does implement setEncoding, so a later reader could not
    // tell which mechanism was load-bearing. Decoding the chunks depends on
    // nothing the stream provides, and does not reconfigure a stream this
    // function was handed rather than opened.
    //
    // Declared here, not inside the loop: the decoder must outlive a chunk to
    // hold the leading bytes of a character whose tail is in the next one.
    // One instance per lines() call, and createStdioTransport calls it once.
    const decoder = new StringDecoder('utf-8');
    for await (const chunk of stdin) {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length > 0) yield line;
      }
    }
    // Unlike fallbackStdioLoop, this generator yields a trailing unterminated
    // line rather than dropping it (next statement). Bytes still held by the
    // decoder belong to that line, so flushing one without the other loses
    // exactly the data that statement exists to keep. Returns '' — and costs
    // nothing — unless the stream ended mid-character.
    buf += decoder.end();
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

// The direct-run guard is the shared helper, not a local copy. bin/ already
// reaches into scripts/ (bin/artibot.js imports scripts/utils/index.js), so
// this is not a new dependency direction, and _main-entry.js is a leaf whose
// only imports are three node: builtins — this CLI pays three builtin lookups
// it would have made anyway.
//
// The inline comparison this replaces used fileURLToPath, so it escaped the
// v4.43.0 percent-encoding defect, but it compared a RAW process.argv[1]
// against a realpath-resolved import.meta.url. Measured 2026-08-15 through a
// Windows junction pointing at the real plugin directory:
//
//   node <real>/bin/artibot-mcp.mjs --version       -> 4.44.0
//   node <junction>/bin/artibot-mcp.mjs --version   -> no output, exit 0
//
// An MCP host launching a junctioned install saw a process exit 0 with no
// protocol on stdio and no diagnostic — "server disconnected", nothing else.
const invokedFromCli = isMainEntry(import.meta.url);
if (invokedFromCli) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[artibot-mcp] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
