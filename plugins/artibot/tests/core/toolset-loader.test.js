import { describe, expect, it, beforeEach } from 'vitest';
import {
  loadToolsets,
  getToolsetForCommand,
  listCommandsInToolset,
  listToolsets,
  _resetToolsetCache,
} from '../../lib/core/toolset-loader.js';

// These tests exercise the live `plugins/artibot/toolsets.json` manifest.
// Contracts under test (presence of "code" toolset, command lookup) are
// stable; if the manifest is reorganized later, only specific names need
// updating.

beforeEach(() => {
  _resetToolsetCache();
});

describe('loadToolsets', () => {
  it('parses the live manifest', async () => {
    const data = await loadToolsets();
    expect(data).toBeTypeOf('object');
    expect(data.toolsets).toBeTypeOf('object');
    expect(typeof data.version).toBe('number');
  });

  it('returns the cached manifest on the second call (mtime hit)', async () => {
    const a = await loadToolsets();
    const b = await loadToolsets();
    expect(b).toBe(a); // identity equality proves cache hit
  });

  it('rebuilds after the cache is reset', async () => {
    const a = await loadToolsets();
    _resetToolsetCache();
    const b = await loadToolsets();
    // After reset we get a fresh parse — different reference, equivalent shape.
    expect(b).not.toBe(a);
    expect(Object.keys(b.toolsets)).toEqual(Object.keys(a.toolsets));
  });
});

describe('getToolsetForCommand', () => {
  it('returns the toolset name for a known command', async () => {
    // "code" toolset is documented to include "build" and "test" — both stable.
    const toolset = await getToolsetForCommand('build');
    expect(toolset).toBe('code');
  });

  it('returns null for an unknown command', async () => {
    expect(await getToolsetForCommand('definitely-not-a-real-command')).toBeNull();
  });
});

describe('listCommandsInToolset', () => {
  it('returns commands for a known toolset as a fresh array', async () => {
    const cmds1 = await listCommandsInToolset('code');
    expect(Array.isArray(cmds1)).toBe(true);
    expect(cmds1.length).toBeGreaterThan(0);
    // Mutating the returned array must not corrupt the cached manifest.
    cmds1.push('hacked');
    const cmds2 = await listCommandsInToolset('code');
    expect(cmds2).not.toContain('hacked');
  });

  it('returns an empty array for an unknown toolset', async () => {
    expect(await listCommandsInToolset('no-such-toolset')).toEqual([]);
  });
});

describe('listToolsets', () => {
  it('returns at least one toolset name', async () => {
    const names = await listToolsets();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('code');
  });
});
