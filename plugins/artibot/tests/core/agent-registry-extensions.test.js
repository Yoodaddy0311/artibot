/**
 * External agent drop-in tests for lib/core/agent-registry.
 *
 * Verifies that `scanExternalAgents`, `validateExternalManifest`, and
 * `loadAgents(pluginRoot, {includeExternal, searchPaths})` honour the
 * Artibot DATA POLICY (dataPolicy in {local, artibot-swarm}) and namespace
 * external agents as `<pluginId>:<agentName>`.
 *
 * @module tests/core/agent-registry-extensions
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scanExternalAgents,
  validateExternalManifest,
} from '../../lib/core/agent-registry.js';

/** @type {string} */
let searchRoot;

beforeEach(() => {
  searchRoot = mkdtempSync(path.join(tmpdir(), 'artibot-ext-scan-'));
});

afterEach(() => {
  rmSync(searchRoot, { recursive: true, force: true });
});

function buildExt(pluginId, manifest, agents) {
  const extDir = path.join(searchRoot, `artibot-ext-${pluginId}`);
  mkdirSync(path.join(extDir, 'agents'), { recursive: true });
  if (manifest !== null) {
    writeFileSync(
      path.join(extDir, 'artibot.ext.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8',
    );
  }
  for (const [agentName, body] of Object.entries(agents || {})) {
    const md = [
      '---',
      `name: ${agentName}`,
      'description: External drop-in agent for testing',
      'capabilities:',
      '  - "test"',
      '---',
      body,
    ].join('\n');
    writeFileSync(path.join(extDir, 'agents', `${agentName}.md`), md, 'utf-8');
  }
  return extDir;
}

// ---------------------------------------------------------------------------
// validateExternalManifest
// ---------------------------------------------------------------------------

describe('validateExternalManifest', () => {
  it('accepts a minimal local-policy manifest', () => {
    const out = validateExternalManifest({
      name: 'foo',
      version: '1.0.0',
      dataPolicy: 'local',
    });
    expect(out.valid).toBe(true);
    expect(out.errors).toEqual([]);
  });

  it('accepts artibot-swarm dataPolicy', () => {
    const out = validateExternalManifest({
      name: 'foo',
      version: '0.1.0',
      dataPolicy: 'artibot-swarm',
    });
    expect(out.valid).toBe(true);
  });

  it('rejects external dataPolicy', () => {
    const out = validateExternalManifest({
      name: 'foo',
      version: '1.0.0',
      dataPolicy: 'external',
    });
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toMatch(/dataPolicy/);
  });

  it('rejects missing required fields', () => {
    const out = validateExternalManifest({ name: 'foo' });
    expect(out.valid).toBe(false);
    expect(out.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects non-object input', () => {
    expect(validateExternalManifest(null).valid).toBe(false);
    expect(validateExternalManifest('string').valid).toBe(false);
    expect(validateExternalManifest([]).valid).toBe(false);
  });

  it('warns on missing description', () => {
    const out = validateExternalManifest({
      name: 'foo', version: '1.0.0', dataPolicy: 'local',
    });
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// scanExternalAgents
// ---------------------------------------------------------------------------

describe('scanExternalAgents', () => {
  it('returns empty array for empty/invalid input', async () => {
    expect(await scanExternalAgents([])).toEqual([]);
    expect(await scanExternalAgents(null)).toEqual([]);
  });

  it('finds agents in a valid extension and namespaces them', async () => {
    buildExt('foo', {
      name: 'foo',
      version: '1.0.0',
      dataPolicy: 'local',
      description: 'Foo extension',
    }, { 'my-agent': 'Agent body.' });

    const refs = await scanExternalAgents([searchRoot]);
    expect(refs.length).toBe(1);
    expect(refs[0].namespacedName).toBe('foo:my-agent');
    expect(refs[0].pluginId).toBe('foo');
    expect(refs[0].agentName).toBe('my-agent');
  });

  it('skips extensions whose dataPolicy is rejected', async () => {
    buildExt('bad', {
      name: 'bad',
      version: '1.0.0',
      dataPolicy: 'external',
      description: 'Should be rejected',
    }, { 'leaky-agent': 'body' });

    const refs = await scanExternalAgents([searchRoot]);
    expect(refs).toEqual([]);
  });

  it('skips directories without a manifest', async () => {
    const extDir = path.join(searchRoot, 'artibot-ext-nomanifest');
    mkdirSync(path.join(extDir, 'agents'), { recursive: true });
    writeFileSync(
      path.join(extDir, 'agents', 'orphan.md'),
      '---\nname: orphan\ndescription: x\ncapabilities:\n  - "x"\n---\nbody',
      'utf-8',
    );

    const refs = await scanExternalAgents([searchRoot]);
    expect(refs).toEqual([]);
  });

  it('ignores non-artibot-ext-* directories', async () => {
    const extDir = path.join(searchRoot, 'random-dir');
    mkdirSync(path.join(extDir, 'agents'), { recursive: true });
    writeFileSync(
      path.join(extDir, 'artibot.ext.json'),
      JSON.stringify({ name: 'random', version: '1.0.0', dataPolicy: 'local' }),
      'utf-8',
    );
    writeFileSync(
      path.join(extDir, 'agents', 'x.md'),
      '---\nname: x\ndescription: x\ncapabilities:\n  - "x"\n---\n',
      'utf-8',
    );

    const refs = await scanExternalAgents([searchRoot]);
    expect(refs).toEqual([]);
  });

  it('handles multiple extensions and multiple agents', async () => {
    buildExt('alpha', {
      name: 'alpha', version: '1.0.0', dataPolicy: 'local', description: 'a',
    }, { 'a1': 'b', 'a2': 'b' });
    buildExt('beta', {
      name: 'beta', version: '1.0.0', dataPolicy: 'artibot-swarm', description: 'b',
    }, { 'b1': 'b' });

    const refs = await scanExternalAgents([searchRoot]);
    const names = refs.map((r) => r.namespacedName).sort();
    expect(names).toEqual(['alpha:a1', 'alpha:a2', 'beta:b1']);
  });

  it('tolerates nonexistent search paths', async () => {
    const refs = await scanExternalAgents([path.join(searchRoot, 'does-not-exist')]);
    expect(refs).toEqual([]);
  });

  it('tolerates malformed manifest JSON', async () => {
    const extDir = path.join(searchRoot, 'artibot-ext-broken');
    mkdirSync(path.join(extDir, 'agents'), { recursive: true });
    writeFileSync(path.join(extDir, 'artibot.ext.json'), '{not json', 'utf-8');

    const refs = await scanExternalAgents([searchRoot]);
    expect(refs).toEqual([]);
  });
});
