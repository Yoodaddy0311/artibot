/**
 * Disk-commit tests for the Artibot SDK factories.
 *
 * Each factory's `.commit(pluginRoot, options)` method is exercised against
 * a throwaway tmp plugin root to verify:
 *   - files are created at the expected paths
 *   - overwrite guard throws by default
 *   - DATA POLICY violations surface as warnings (not errors)
 *   - JSON registries (plugin.json, hooks.json, artibot.config.json) are
 *     merged idempotently
 *
 * @module tests/sdk/artibot-sdk-commit
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgent,
  createHook,
  createMiddleware,
  createSkill,
  scanDataPolicyViolations,
} from '../../lib/sdk/artibot-sdk.js';

/** @type {string} */
let pluginRoot;

beforeEach(() => {
  pluginRoot = mkdtempSync(path.join(tmpdir(), 'artibot-sdk-commit-'));
});

afterEach(() => {
  rmSync(pluginRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scanDataPolicyViolations
// ---------------------------------------------------------------------------

describe('scanDataPolicyViolations', () => {
  it('returns an empty array for a clean body', () => {
    expect(scanDataPolicyViolations('const x = 1;')).toEqual([]);
  });

  it('flags fetch(', () => {
    const out = scanDataPolicyViolations('await fetch("https://api.example.com")');
    expect(out.length).toBeGreaterThan(0);
  });

  it('flags child_process', () => {
    const out = scanDataPolicyViolations('import { spawn } from "child_process";');
    expect(out.length).toBeGreaterThan(0);
  });

  it('flags eval and new Function', () => {
    expect(scanDataPolicyViolations('eval("1+1")').length).toBeGreaterThan(0);
    expect(scanDataPolicyViolations('new Function("return 1")').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createSkill.commit
// ---------------------------------------------------------------------------

describe('createSkill().commit', () => {
  const spec = {
    name: 'demo-skill',
    description: 'Demo skill',
    category: 'engineering',
    body: '# Demo\n\nClean body.',
  };

  it('writes SKILL.md and references/ dir', async () => {
    const result = createSkill(spec);
    const committed = await result.commit(pluginRoot);

    const skillFile = path.join(pluginRoot, 'skills', 'demo-skill', 'SKILL.md');
    expect(committed.path).toBe(skillFile);
    expect(committed.overwritten).toBe(false);
    expect(existsSync(skillFile)).toBe(true);
    expect(existsSync(path.join(pluginRoot, 'skills', 'demo-skill', 'references'))).toBe(true);
    expect(readFileSync(skillFile, 'utf-8')).toContain('name: demo-skill');
    expect(committed.warnings).toEqual([]);
  });

  it('throws when target file exists and overwrite is not set', async () => {
    const result = createSkill(spec);
    await result.commit(pluginRoot);
    await expect(result.commit(pluginRoot)).rejects.toThrow(/file exists/);
  });

  it('overwrites when overwrite: true', async () => {
    const result = createSkill(spec);
    await result.commit(pluginRoot);
    const second = await result.commit(pluginRoot, { overwrite: true });
    expect(second.overwritten).toBe(true);
  });

  it('returns warnings for DATA POLICY violations in body', async () => {
    const bad = { ...spec, body: '# Bad\n\nawait fetch("https://evil.example")' };
    const result = createSkill(bad);
    const committed = await result.commit(pluginRoot);
    expect(committed.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createAgent.commit
// ---------------------------------------------------------------------------

describe('createAgent().commit', () => {
  const spec = {
    name: 'demo-agent',
    role: 'Demo Agent',
    model: 'opus',
    body: 'Do things.',
  };

  it('writes agent .md and registers in plugin.json', async () => {
    const result = createAgent(spec);
    const committed = await result.commit(pluginRoot);

    const agentFile = path.join(pluginRoot, 'agents', 'demo-agent.md');
    expect(committed.path).toBe(agentFile);
    expect(existsSync(agentFile)).toBe(true);

    const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.agents).toContain('./agents/demo-agent.md');
  });

  it('merges into existing plugin.json without duplicating', async () => {
    const manifestDir = path.join(pluginRoot, '.claude-plugin');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      JSON.stringify({ name: 'artibot', agents: ['./agents/existing.md'] }, null, 2) + '\n',
      'utf-8',
    );

    const result = createAgent(spec);
    await result.commit(pluginRoot);
    // Commit a second time with overwrite to verify idempotency on the JSON side.
    await result.commit(pluginRoot, { overwrite: true });

    const manifest = JSON.parse(
      readFileSync(path.join(manifestDir, 'plugin.json'), 'utf-8'),
    );
    expect(manifest.agents).toEqual([
      './agents/existing.md',
      './agents/demo-agent.md',
    ]);
    expect(manifest.name).toBe('artibot');
  });

  it('guards against overwrite by default', async () => {
    const result = createAgent(spec);
    await result.commit(pluginRoot);
    await expect(result.commit(pluginRoot)).rejects.toThrow(/file exists/);
  });
});

// ---------------------------------------------------------------------------
// createHook.commit
// ---------------------------------------------------------------------------

describe('createHook().commit', () => {
  const spec = {
    event: 'PreToolUse',
    name: 'demo-hook',
    description: 'Demo hook',
    script: 'process.stdout.write("hello");',
  };

  it('writes hook script and registers in hooks.json', async () => {
    const result = createHook(spec);
    const committed = await result.commit(pluginRoot);

    const scriptFile = path.join(pluginRoot, 'scripts', 'hooks', 'demo-hook.js');
    expect(committed.path).toBe(scriptFile);
    expect(existsSync(scriptFile)).toBe(true);

    const hooksFile = path.join(pluginRoot, 'hooks', 'hooks.json');
    const hooksData = JSON.parse(readFileSync(hooksFile, 'utf-8'));
    expect(Array.isArray(hooksData.hooks.PreToolUse)).toBe(true);
    expect(hooksData.hooks.PreToolUse.length).toBe(1);
    expect(hooksData.hooks.PreToolUse[0].hooks[0].command).toMatch(/demo-hook\.js/);
  });

  it('is idempotent when registering the same event entry twice', async () => {
    const result = createHook(spec);
    await result.commit(pluginRoot);
    await result.commit(pluginRoot, { overwrite: true });

    const hooksData = JSON.parse(
      readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf-8'),
    );
    expect(hooksData.hooks.PreToolUse.length).toBe(1);
  });

  it('flags script containing child_process with a warning', async () => {
    const bad = { ...spec, script: 'import {spawn} from "child_process";' };
    const result = createHook(bad);
    const committed = await result.commit(pluginRoot);
    expect(committed.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createMiddleware.commit
// ---------------------------------------------------------------------------

describe('createMiddleware().commit', () => {
  const spec = {
    name: 'demo-mw',
    position: 'after',
    target: 'router',
    factoryCode: 'export default function mw(ctx) { return ctx; }',
  };

  it('writes module and registers in artibot.config.json', async () => {
    const result = createMiddleware(spec);
    const committed = await result.commit(pluginRoot);

    const moduleFile = path.join(
      pluginRoot, 'lib', 'runtime', 'middleware', 'demo-mw.js',
    );
    expect(committed.path).toBe(moduleFile);
    expect(existsSync(moduleFile)).toBe(true);

    const configPath = path.join(pluginRoot, 'artibot.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.runtime.middleware).toContain('demo-mw');
  });

  it('preserves existing runtime.middleware entries', async () => {
    writeFileSync(
      path.join(pluginRoot, 'artibot.config.json'),
      JSON.stringify({ runtime: { middleware: ['router', 'skills'] } }, null, 2) + '\n',
      'utf-8',
    );

    const result = createMiddleware(spec);
    await result.commit(pluginRoot);

    const config = JSON.parse(
      readFileSync(path.join(pluginRoot, 'artibot.config.json'), 'utf-8'),
    );
    expect(config.runtime.middleware).toEqual(['router', 'skills', 'demo-mw']);
  });

  it('guards overwrite by default', async () => {
    const result = createMiddleware(spec);
    await result.commit(pluginRoot);
    await expect(result.commit(pluginRoot)).rejects.toThrow(/file exists/);
  });
});
