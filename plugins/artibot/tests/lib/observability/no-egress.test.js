/**
 * DATA POLICY enforcement: orchestration primitives introduced by Squad A
 * (Phase 2 §4.1 allowlist) MUST NOT contain any HTTP/network egress code in
 * production sources.
 *
 * Scope: only files this squad owns. Pre-existing exporters outside the
 * allowlist (e.g. otel-exporter.js) are owned by other surfaces and are gated
 * separately; including them here would conflate Squad A's contract with code
 * we cannot modify.
 */

import { describe, expect, it } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..', '..', '..');
const TARGET_DIRS = [
  join(PLUGIN_ROOT, 'lib', 'observability'),
  join(PLUGIN_ROOT, 'lib', 'orchestration'),
  join(PLUGIN_ROOT, 'lib', 'security'),
];

// Files this squad owns (Phase 2 §4.1 allowlist for Squad A).
const OWNED_FILES = new Set([
  'guardrails.js',
  'tool-guardrails.js',
  'agent-as-tool.js',
  'handoff-filter.js',
  'trace.js',
  'ndjson.js',
  'cmd-allowlist.js',
]);

const EGRESS_REGEX = /\b(fetch|http|https|XMLHttpRequest|axios|node-fetch)\b/;

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (s.isFile() && (name.endsWith('.js') || name.endsWith('.mjs'))) {
      out.push(full);
    }
  }
  return out;
}

function stripCommentsAndStrings(src) {
  // Remove block comments
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove line comments
  out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // Remove string literals (single, double, backtick — no nested template support needed for this check)
  out = out.replace(/'(?:\\.|[^'\\])*'/g, "''");
  out = out.replace(/"(?:\\.|[^"\\])*"/g, '""');
  out = out.replace(/`(?:\\.|[^`\\])*`/g, '``');
  return out;
}

describe('DATA POLICY: no HTTP egress in observability/orchestration/security', () => {
  it('finds zero http/fetch matches in production code', async () => {
    const offenders = [];
    for (const dir of TARGET_DIRS) {
      const files = await walk(dir);
      for (const file of files) {
        if (!OWNED_FILES.has(basename(file))) continue;
        const src = await readFile(file, 'utf-8');
        const stripped = stripCommentsAndStrings(src);
        if (EGRESS_REGEX.test(stripped)) {
          // collect line numbers of matches in original (for diagnostic only)
          const lines = src.split('\n');
          const hits = [];
          lines.forEach((line, idx) => {
            const cleanLine = stripCommentsAndStrings(line);
            if (EGRESS_REGEX.test(cleanLine)) {
              hits.push(`${idx + 1}: ${line.trim()}`);
            }
          });
          offenders.push({ file, hits });
        }
      }
    }
    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `\n${o.file}:\n  ${o.hits.join('\n  ')}`)
        .join('\n');
      throw new Error(`DATA POLICY violation — egress matches found:${report}`);
    }
    expect(offenders).toEqual([]);
  });

  it('walked at least the orchestration directory', async () => {
    const files = await walk(join(PLUGIN_ROOT, 'lib', 'orchestration'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('walked at least the observability directory', async () => {
    const files = await walk(join(PLUGIN_ROOT, 'lib', 'observability'));
    expect(files.length).toBeGreaterThan(0);
  });
});
