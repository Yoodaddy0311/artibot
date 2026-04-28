/**
 * artibot-mcp-smoke.test.js — smoke test for bin/artibot-mcp.mjs.
 *
 * Covers:
 *   1. --version output matches package.json
 *   2. --help output contains usage info
 *   3. Unknown flag → exit code 2 with help text on stderr
 *   4. MCP stdio handshake: initialize request → JSON-RPC response on stdout
 *   5. tools/list integration with a mock server module
 *   6. Malformed JSON-RPC input → -32700 parse error
 *   7. All stdio interactions complete inside a 10s timeout
 *
 * The tests spawn the CLI as a subprocess (real node execution path) and
 * also exercise the exported `main(argv, deps)` with mock streams to drive
 * the JSON-RPC loop deterministically.
 */

import { describe, expect, it } from 'vitest';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(PLUGIN_ROOT, 'bin', 'artibot-mcp.mjs');
const PKG_PATH = path.join(PLUGIN_ROOT, 'package.json');

function readPkgVersion() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
  return pkg.version;
}

async function runCli(args, { stdinLines = [], timeout = 10_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout after ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf-8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code });
    });
    if (stdinLines.length > 0) {
      child.stdin.write(stdinLines.join('\n') + '\n');
    }
    child.stdin.end();
  });
}

describe('artibot-mcp smoke — simple CLI flags', () => {
  it('prints package.json version with --version', async () => {
    const expected = readPkgVersion();
    const { stdout } = await execFile(process.execPath, [CLI_PATH, '--version'], {
      cwd: PLUGIN_ROOT,
      timeout: 10_000,
    });
    expect(stdout.trim()).toBe(expected);
  });

  it('prints package.json version with -v', async () => {
    const expected = readPkgVersion();
    const { stdout } = await execFile(process.execPath, [CLI_PATH, '-v'], {
      cwd: PLUGIN_ROOT,
      timeout: 10_000,
    });
    expect(stdout.trim()).toBe(expected);
  });

  it('prints help with --help', async () => {
    const { stdout } = await execFile(process.execPath, [CLI_PATH, '--help'], {
      cwd: PLUGIN_ROOT,
      timeout: 10_000,
    });
    expect(stdout).toContain('artibot-mcp');
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('stdio');
  });

  it('prints help with -h', async () => {
    const { stdout } = await execFile(process.execPath, [CLI_PATH, '-h'], {
      cwd: PLUGIN_ROOT,
      timeout: 10_000,
    });
    expect(stdout).toContain('Usage:');
  });

  it('rejects unknown flags with non-zero exit and help on stderr', async () => {
    const { code, stderr } = await runCli(['--bogus']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('unknown arg');
  });

  it('does not contain hardcoded VERSION literal in CLI source', () => {
    const src = readFileSync(CLI_PATH, 'utf-8');
    expect(src).not.toMatch(/const\s+VERSION\s*=\s*['"]\d+\.\d+\.\d+['"]/);
  });
});

describe('artibot-mcp smoke — MCP stdio handshake (fallback path)', () => {
  it(
    'responds to initialize over stdio when no MS1 server module is present',
    async () => {
      // The fallback loop always answers initialize with protocolVersion +
      // serverInfo. Even once MS1 lands, this assertion holds because MS1's
      // createArtibotMcpServer must also answer initialize identically.
      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      });
      const { stdout, code } = await runCli([], { stdinLines: [initReq], timeout: 10_000 });
      // Split NDJSON lines, find the id=1 response
      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const responses = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const initResp = responses.find((r) => r.id === 1);
      expect(initResp).toBeDefined();
      expect(initResp.jsonrpc).toBe('2.0');
      expect(initResp.result).toBeDefined();
      expect(initResp.result.serverInfo?.name).toBe('artibot-mcp');
      expect(initResp.result.serverInfo?.version).toBe(readPkgVersion());
      // graceful exit after stdin EOF
      expect([0, null]).toContain(code);
    },
    15_000
  );

  it(
    'returns -32700 parse error on malformed JSON-RPC input',
    async () => {
      const { stdout } = await runCli([], {
        stdinLines: ['not valid json {{'],
        timeout: 10_000,
      });
      const lines = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const responses = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const parseErr = responses.find((r) => r.error?.code === -32700);
      expect(parseErr).toBeDefined();
      expect(parseErr.error.message).toMatch(/parse/i);
    },
    15_000
  );

  it(
    'responds to tools/list (empty list in fallback mode)',
    async () => {
      const initReq = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      });
      const listReq = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const { stdout } = await runCli([], {
        stdinLines: [initReq, listReq],
        timeout: 10_000,
      });
      const responses = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const listResp = responses.find((r) => r.id === 2);
      expect(listResp).toBeDefined();
      expect(Array.isArray(listResp.result?.tools)).toBe(true);
    },
    15_000
  );
});

describe('artibot-mcp smoke — main() with mock server (MS1/MS2 contract)', () => {
  it('wires createArtibotMcpServer and wireBridges when both modules load', async () => {
    const { main } = await import(pathToFileURL(CLI_PATH).href);
    const startCalls = [];
    const wireCalls = [];
    const closeCalls = [];
    const fakeServer = {
      start: async () => {
        startCalls.push(true);
      },
      close: async () => {
        closeCalls.push(true);
      },
      waitUntilClosed: async () => {
        /* resolve immediately to unblock main() */
      },
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stderrBuf = '';
    stderr.on('data', (c) => {
      stderrBuf += c.toString('utf-8');
    });

    const mods = {
      createArtibotMcpServer: async (opts) => {
        expect(opts.pluginRoot).toBe(PLUGIN_ROOT);
        expect(typeof opts.version).toBe('string');
        return fakeServer;
      },
      wireBridges: async (srv) => {
        wireCalls.push(srv);
      },
    };
    // Fire-and-forget; the fake server.waitUntilClosed resolves immediately.
    await main([], {
      stdin,
      stdout,
      stderr,
      loadModules: async () => mods,
    });
    expect(startCalls).toHaveLength(1);
    expect(wireCalls).toHaveLength(1);
    expect(wireCalls[0]).toBe(fakeServer);
    expect(stderrBuf).not.toContain('server failed to start');
  });

  it('surfaces createArtibotMcpServer errors on stderr with non-zero exitCode', async () => {
    const { main } = await import(pathToFileURL(CLI_PATH).href);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let stderrBuf = '';
    stderr.on('data', (c) => {
      stderrBuf += c.toString('utf-8');
    });

    const prevExit = process.exitCode;
    process.exitCode = 0;
    await main([], {
      stdin,
      stdout,
      stderr,
      loadModules: async () => ({
        createArtibotMcpServer: async () => {
          throw new Error('boom');
        },
      }),
    });
    expect(stderrBuf).toContain('server failed to start');
    expect(stderrBuf).toContain('boom');
    expect(process.exitCode).toBe(1);
    process.exitCode = prevExit;
  });

  it('parseArgs throws on unknown flags', async () => {
    const { parseArgs } = await import(pathToFileURL(CLI_PATH).href);
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });

  it('parseArgs parses --help and --version flags', async () => {
    const { parseArgs } = await import(pathToFileURL(CLI_PATH).href);
    expect(parseArgs(['--help'])).toEqual({ help: true, version: false });
    expect(parseArgs(['-h'])).toEqual({ help: true, version: false });
    expect(parseArgs(['--version'])).toEqual({ help: false, version: true });
    expect(parseArgs(['-v'])).toEqual({ help: false, version: true });
    expect(parseArgs([])).toEqual({ help: false, version: false });
  });
});
