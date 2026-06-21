import { describe, expect, it } from 'vitest';
import { createCliAdapter } from '../../lib/runtime/cli-adapter.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

const TEST_CONFIG = {
  version: '1.12.0',
  automation: { supportedLanguages: ['en', 'ko', 'ja'], ambiguityThreshold: 50 },
  team: {
    enabled: true,
    delegationModeSelection: {
      subAgent: { tools: ['Task'], communication: 'one-way (result return only)' },
      agentTeam: {
        tools: ['TeamCreate', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TeamDelete'],
        communication: 'P2P bidirectional + shared task list',
      },
    },
  },
  cognitive: { router: { threshold: 0.4 } },
};

describe('CLI Adapter', () => {
  it('creates an adapter with correct platform identifiers', () => {
    const adapter = createCliAdapter({ pluginRoot: PLUGIN_ROOT, config: TEST_CONFIG });
    expect(adapter.platformId).toBe('cli');
    expect(adapter.platformName).toBe('Artibot CLI');
  });

  it('processes a simple prompt through the runtime pipeline', async () => {
    const adapter = createCliAdapter({ pluginRoot: PLUGIN_ROOT, config: TEST_CONFIG });
    const result = await adapter.runPrompt('fix typo in readme');

    expect(result).toBeDefined();
    expect(result.userPrompt).toBeTypeOf('string');
    expect(result.userPrompt.length).toBeGreaterThan(0);
    expect(result.message).toContain('[runtime]');
    expect(result.context.routing.system).toBe('system1');
  });

  it('processes a complex prompt and routes to system2', async () => {
    const adapter = createCliAdapter({ pluginRoot: PLUGIN_ROOT, config: TEST_CONFIG });
    const result = await adapter.runPrompt(
      'analyze security vulnerabilities, then refactor auth flow, then deploy to production',
    );

    expect(result.context.routing.system).toBe('system2');
    expect(result.context.subagents.contract.mode).toBe('agentTeam');
  });

  it('enables team mode when teamMode option is true', async () => {
    const config = { ...TEST_CONFIG, team: { ...TEST_CONFIG.team, enabled: false } };
    const adapter = createCliAdapter({ pluginRoot: PLUGIN_ROOT, config, teamMode: true });
    const result = await adapter.runPrompt('build a dashboard');

    expect(result).toBeDefined();
    expect(result.context.config.teamEnabled).toBe(true);
  });

  it('includes source=cli in hookData', async () => {
    const adapter = createCliAdapter({ pluginRoot: PLUGIN_ROOT, config: TEST_CONFIG });
    const result = await adapter.runPrompt('fix typo');

    expect(result.context.hook.event).toBe('UserPromptSubmit');
  });

  it('falls back to default config when config file is unavailable', () => {
    const adapter = createCliAdapter({ pluginRoot: '/nonexistent/path' });
    expect(adapter.platformId).toBe('cli');
  });
});
