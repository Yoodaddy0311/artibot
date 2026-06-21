/**
 * Unit tests for lib/adapters/skill-export — the platform export orchestration.
 *
 * Verifies that exportFor{Gemini,Codex,Cursor,Antigravity,All} wire the core
 * loaders through the real export-target adapters into a file bundle. Runs
 * against a throwaway plugin root under the OS temp dir with an injected config
 * (so loadConfig and the real plugin state are never touched).
 *
 * @module tests/adapters/skill-export
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  exportForAll,
  exportForAntigravity,
  exportForCodex,
  exportForCursor,
  exportForGemini,
} from '../../lib/adapters/skill-export.js';

/** @type {string} */
let root;
const CONFIG = { version: '1.0.0' };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-skill-export-'));
  // One skill, one agent, one command — exercises every collect* path.
  const skillDir = path.join(root, 'skills', 'sample');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    ['---', 'name: sample', 'description: A sample skill', '---', '', 'Sample skill body.'].join('\n'),
    'utf-8',
  );
  const agentsDir = path.join(root, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, 'helper.md'),
    ['---', 'name: helper', '---', '# Role: Helps out', '', 'Agent body.'].join('\n'),
    'utf-8',
  );
  const commandsDir = path.join(root, 'commands');
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(
    path.join(commandsDir, 'go.md'),
    ['---', 'name: go', 'description: Go command', '---', '', 'Do the thing.'].join('\n'),
    'utf-8',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function assertBundle(result, expectedPlatform) {
  expect(result.platform).toBe(expectedPlatform);
  expect(Array.isArray(result.files)).toBe(true);
  expect(result.files.length).toBeGreaterThan(0);
  for (const file of result.files) {
    expect(typeof file.path).toBe('string');
    expect(file.path.length).toBeGreaterThan(0);
    expect(typeof file.content).toBe('string');
  }
  expect(Array.isArray(result.warnings)).toBe(true);
}

describe('exportForGemini()', () => {
  it('produces a gemini-cli bundle from the loaded skills', async () => {
    const result = await exportForGemini({ pluginRoot: root, config: CONFIG });
    assertBundle(result, 'gemini-cli');
    // The sample skill must surface somewhere in the produced file paths.
    expect(result.files.some((f) => f.path.includes('sample'))).toBe(true);
  });
});

describe('exportForCodex()', () => {
  it('produces a codex-cli bundle', async () => {
    const result = await exportForCodex({ pluginRoot: root, config: CONFIG });
    assertBundle(result, 'codex-cli');
  });
});

describe('exportForCursor()', () => {
  it('produces a cursor bundle', async () => {
    const result = await exportForCursor({ pluginRoot: root, config: CONFIG });
    assertBundle(result, 'cursor');
  });
});

describe('exportForAntigravity()', () => {
  it('produces an antigravity bundle', async () => {
    const result = await exportForAntigravity({ pluginRoot: root, config: CONFIG });
    expect(result.platform).toBeTruthy();
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
  });
});

describe('exportForAll()', () => {
  it('returns a bundle keyed for every supported platform', async () => {
    const all = await exportForAll({ pluginRoot: root, config: CONFIG });
    expect(Object.keys(all).sort()).toEqual(
      ['antigravity', 'codex-cli', 'cursor', 'gemini-cli'],
    );
    expect(all['gemini-cli'].files.length).toBeGreaterThan(0);
    expect(all['codex-cli'].files.length).toBeGreaterThan(0);
    expect(all.cursor.files.length).toBeGreaterThan(0);
    expect(all.antigravity.files.length).toBeGreaterThan(0);
  });
});
