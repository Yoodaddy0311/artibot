#!/usr/bin/env node
/**
 * artibot-dashboard — local observability dashboard CLI (v3.2.0).
 *
 * Binds to 127.0.0.1 only. Any attempt to override --host with a
 * non-loopback value is rejected with a clear warning.
 *
 * Usage:
 *   artibot-dashboard [--port <n>] [--events <path>] [--help] [--version]
 *
 * Examples:
 *   artibot-dashboard
 *   artibot-dashboard --port 3030
 *   artibot-dashboard --events ./runtime/events/2026-04-23.jsonl
 *
 * @module bin/artibot-dashboard
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer } from '../lib/runtime/dashboard/server.mjs';

const VERSION = '3.2.0';
const HELP = `
artibot-dashboard ${VERSION}
Local observability dashboard for hook-event-emitter envelopes.

Usage:
  artibot-dashboard [options]

Options:
  --port <n>        TCP port (default: auto — random free port)
  --events <path>   Override event JSONL file path
  --host <h>        Loopback host (127.0.0.1 forced, override blocked)
  --help, -h        Show this help
  --version, -v     Show version

Security:
  The server binds to 127.0.0.1 only. External hosts (0.0.0.0, LAN IPs)
  are refused. No auth layer beyond loopback — do not port-forward.
`.trim();

/**
 * Parse argv into a flat flags object. Unknown flags error out.
 * @param {string[]} argv
 * @returns {{
 *   port: number | undefined,
 *   events: string | undefined,
 *   host: string | undefined,
 *   help: boolean,
 *   version: boolean,
 * }}
 */
export function parseArgs(argv) {
  const out = {
    port: undefined,
    events: undefined,
    host: undefined,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--port') { out.port = Number(argv[++i]); }
    else if (a === '--events') { out.events = argv[++i]; }
    else if (a === '--host') { out.host = argv[++i]; }
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Enforce loopback, warn if overridden.
 * @param {string | undefined} host
 * @returns {string}
 */
function resolveHost(host) {
  if (!host) return '127.0.0.1';
  if (!LOOPBACK.has(host)) {
    process.stderr.write(
      `[artibot-dashboard] --host "${host}" blocked (loopback-only). Forcing 127.0.0.1.\n`
    );
    return '127.0.0.1';
  }
  return host;
}

/**
 * CLI entry.
 * @param {string[]} argv
 */
export async function main(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (args.help) { process.stdout.write(`${HELP}\n`); return; }
  if (args.version) { process.stdout.write(`${VERSION}\n`); return; }

  const host = resolveHost(args.host);
  const port = Number.isFinite(args.port) ? Number(args.port) : 0;
  const eventFile = args.events ? resolve(args.events) : undefined;

  let server;
  try {
    server = await createDashboardServer({ host, port, eventFile });
  } catch (err) {
    if (String(err?.code) === 'EADDRINUSE' && port !== 0) {
      process.stderr.write(
        `[artibot-dashboard] port ${port} in use — retrying on a random port.\n`
      );
      server = await createDashboardServer({ host, port: 0, eventFile });
    } else {
      process.stderr.write(
        `[artibot-dashboard] failed to start: ${err?.message ?? err}\n`
      );
      process.exit(1);
    }
  }

  process.stdout.write(`artibot-dashboard listening at ${server.url}\n`);
  process.stdout.write(`  events: ${eventFile ?? '(default daily file)'}\n`);
  process.stdout.write(`  press Ctrl+C to stop.\n`);

  const shutdown = async (sig) => {
    process.stdout.write(`\n[artibot-dashboard] ${sig} received — stopping.\n`);
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedFromCli =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedFromCli) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[artibot-dashboard] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
