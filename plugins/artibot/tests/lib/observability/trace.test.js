import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSpan,
  Span,
  SPAN_TYPES,
  Trace,
} from '../../../lib/observability/trace.js';
import { NdjsonExporter } from '../../../lib/observability/exporters/ndjson.js';
import {
  isAllowedCommand,
  parseLeadingBinary,
  diagnose,
  DEFAULT_BASH_ALLOWLIST,
} from '../../../lib/security/cmd-allowlist.js';

describe('Span', () => {
  it('rejects unknown span types', () => {
    expect(() => createSpan('banana')).toThrow(TypeError);
  });

  it('records all canonical types', () => {
    for (const t of SPAN_TYPES) {
      const s = createSpan(t, { foo: 'bar' });
      expect(s.type).toBe(t);
      expect(s.attrs).toEqual({ foo: 'bar' });
    }
  });

  it('end() sets endedAt and durationMs', () => {
    const s = createSpan('agent');
    s.end();
    expect(s.endedAt).not.toBeNull();
    const json = s.toJSON();
    expect(json.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('addEvent appends to events array', () => {
    const s = createSpan('tool');
    s.addEvent('called', { tool: 'Bash' });
    s.addEvent('returned', { ok: true });
    expect(s.events).toHaveLength(2);
    expect(s.events[0].name).toBe('called');
  });

  it('end(error) records error info', () => {
    const s = createSpan('function');
    s.end(new Error('boom'));
    expect(s.error).not.toBeNull();
    expect(s.error.message).toBe('boom');
  });

  it('child span inherits traceId', () => {
    const parent = createSpan('agent');
    const child = createSpan('tool', {}, parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentId).toBe(parent.id);
  });
});

describe('Trace + NdjsonExporter', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'artibot-trace-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('exports spans as NDJSON to runtime/traces dir', async () => {
    const exporter = new NdjsonExporter({ dir: tmpDir });
    const trace = new Trace({ name: 'demo', sessionId: 'sess1', exporter });
    trace.start();
    const s1 = createSpan('agent', { name: 'planner' });
    s1.end();
    const s2 = createSpan('tool', { name: 'Bash' }, s1);
    s2.end();
    trace.recordSpan(s1);
    trace.recordSpan(s2);
    await trace.end();

    const files = await readdir(tmpDir);
    expect(files.length).toBe(1);
    const content = await readFile(join(tmpDir, files[0]), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].sessionId).toBe('sess1');
    expect(parsed[0].traceName).toBe('demo');
    expect(parsed[1].parentId).toBe(parsed[0].id);
  });

  it('skips export when spans is empty', async () => {
    const exporter = new NdjsonExporter({ dir: tmpDir });
    const result = await exporter.export([]);
    expect(result).toEqual({ path: null, count: 0 });
  });

  it('Trace.recordSpan auto-ends open spans', async () => {
    const trace = new Trace({ name: 'auto', sessionId: 's' });
    const s = new Span('turn');
    trace.recordSpan(s);
    expect(s.endedAt).not.toBeNull();
  });
});

describe('cmd-allowlist', () => {
  it('default list contains read tools', () => {
    expect(DEFAULT_BASH_ALLOWLIST).toContain('ls');
    expect(DEFAULT_BASH_ALLOWLIST).toContain('grep');
    expect(DEFAULT_BASH_ALLOWLIST).toContain('rg');
  });

  it('parses leading binary stripping path', () => {
    expect(parseLeadingBinary('/usr/bin/ls -la')).toBe('ls');
    expect(parseLeadingBinary('  rg "pattern" .')).toBe('rg');
    expect(parseLeadingBinary('FOO=bar BAR=baz cat file')).toBe('cat');
  });

  it('rejects empty / non-string input', () => {
    expect(parseLeadingBinary('')).toBeNull();
    expect(parseLeadingBinary(null)).toBeNull();
  });

  it('isAllowedCommand returns true for allowed binary', () => {
    expect(isAllowedCommand('ls -la')).toBe(true);
    expect(isAllowedCommand('grep foo file')).toBe(true);
  });

  it('isAllowedCommand returns false for non-allowlisted', () => {
    expect(isAllowedCommand('curl https://example.com')).toBe(false);
    expect(isAllowedCommand('bash -c "ls"')).toBe(false);
  });

  it('diagnose returns bin and decision', () => {
    expect(diagnose('cat file')).toEqual({ bin: 'cat', hasMeta: false, allowed: true });
    expect(diagnose('npx do-thing')).toEqual({ bin: 'npx', hasMeta: false, allowed: false });
    expect(diagnose('ls; rm -rf /')).toEqual({ bin: 'ls;', hasMeta: true, allowed: false });
  });
});
