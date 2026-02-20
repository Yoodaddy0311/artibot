import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * E2E Integration Test: Plugin Initialization Flow
 *
 * Simulates the complete plugin startup sequence as Claude Code would invoke it:
 *   1. Plugin manifest (plugin.json) is read and validated
 *   2. Config (artibot.config.json) is loaded and merged with defaults
 *   3. Hooks registry (hooks.json) is parsed and all hook scripts are resolvable
 *   4. Agent definitions are discoverable from the manifest
 *   5. Command definitions are discoverable from the commands/ directory
 *   6. Cognitive router initializes with config values
 *
 * These tests use the REAL plugin files on disk (no mocks for file content)
 * to validate the full initialization contract.
 */

// Resolve the actual plugin root from this test file's location
const PLUGIN_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
  '..', '..',
);

describe('E2E: Plugin Initialization Flow', () => {
  describe('Step 1 - Plugin manifest validation', () => {
    let manifest;

    beforeEach(() => {
      const manifestPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    });

    it('has required top-level fields', () => {
      expect(manifest).toHaveProperty('name', 'artibot');
      expect(manifest).toHaveProperty('version');
      expect(manifest).toHaveProperty('description');
      expect(manifest).toHaveProperty('agents');
      expect(manifest).toHaveProperty('commands');
      expect(manifest).toHaveProperty('skills');
    });

    it('declares version matching semantic versioning', () => {
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('lists agents as relative paths to .md files', () => {
      expect(Array.isArray(manifest.agents)).toBe(true);
      expect(manifest.agents.length).toBeGreaterThan(0);
      for (const agentPath of manifest.agents) {
        expect(agentPath).toMatch(/^\.\/agents\/.+\.md$/);
      }
    });

    it('all declared agent files exist on disk', () => {
      for (const agentRelPath of manifest.agents) {
        const absPath = path.join(PLUGIN_ROOT, agentRelPath);
        expect(() => readFileSync(absPath, 'utf-8')).not.toThrow();
      }
    });

    it('declares orchestrator as the first agent', () => {
      expect(manifest.agents[0]).toContain('orchestrator');
    });

    it('commands entry points to the commands directory', () => {
      expect(manifest.commands).toContain('./commands/');
    });

    it('skills entry points to the skills directory', () => {
      expect(manifest.skills).toContain('./skills/');
    });
  });

  describe('Step 2 - Config loading and defaults', () => {
    let config;
    let loadConfig;
    let resetConfig;

    beforeEach(async () => {
      vi.resetModules();

      // Mock platform to use the real plugin root
      vi.doMock('../../lib/core/platform.js', () => ({
        getPluginRoot: vi.fn(() => PLUGIN_ROOT),
        getHomeDir: vi.fn(() => '/fake/home'),
      }));

      const configModule = await import('../../lib/core/config.js');
      loadConfig = configModule.loadConfig;
      resetConfig = configModule.resetConfig;
      resetConfig();

      config = await loadConfig();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('loads config successfully from artibot.config.json', () => {
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });

    it('has the correct plugin version', () => {
      expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('has team configuration with agent-teams engine', () => {
      expect(config.team).toBeDefined();
      expect(config.team.enabled).toBe(true);
      expect(config.team.engine).toBe('claude-agent-teams');
    });

    it('has agent categories defined', () => {
      expect(config.agents).toBeDefined();
      expect(config.agents.categories).toBeDefined();
      expect(config.agents.categories.manager).toContain('orchestrator');
    });

    it('has taskBased agent mapping for command routing', () => {
      expect(config.agents.taskBased).toBeDefined();
      expect(config.agents.taskBased['code review']).toBe('code-reviewer');
      expect(config.agents.taskBased['security review']).toBe('security-reviewer');
      expect(config.agents.taskBased['tdd']).toBe('tdd-guide');
    });

    it('has automation settings with supported languages', () => {
      expect(config.automation).toBeDefined();
      expect(config.automation.intentDetection).toBe(true);
      expect(config.automation.supportedLanguages).toEqual(
        expect.arrayContaining(['en', 'ko']),
      );
    });

    it('has cognitive router settings', () => {
      expect(config.cognitive).toBeDefined();
      expect(config.cognitive.router).toBeDefined();
      expect(typeof config.cognitive.router.threshold).toBe('number');
      expect(config.cognitive.router.threshold).toBeGreaterThanOrEqual(0.2);
      expect(config.cognitive.router.threshold).toBeLessThanOrEqual(0.7);
    });

    it('has output settings with a default style', () => {
      expect(config.output).toBeDefined();
      expect(config.output.defaultStyle).toBe('artibot-default');
    });

    it('preserves default values for unspecified fields', () => {
      // These come from DEFAULTS in config.js even if artibot.config.json omits them
      expect(typeof config.context.importCacheTTL).toBe('number');
    });

    it('caches config on repeated calls', async () => {
      const second = await loadConfig();
      expect(second).toBe(config);
    });
  });

  describe('Step 3 - Hooks registry validation', () => {
    let hooksConfig;

    beforeEach(() => {
      const hooksPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
      hooksConfig = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    });

    it('has a valid hooks configuration', () => {
      expect(hooksConfig).toHaveProperty('hooks');
      expect(typeof hooksConfig.hooks).toBe('object');
    });

    it('registers SessionStart hooks', () => {
      expect(hooksConfig.hooks.SessionStart).toBeDefined();
      expect(Array.isArray(hooksConfig.hooks.SessionStart)).toBe(true);
      expect(hooksConfig.hooks.SessionStart.length).toBeGreaterThan(0);
    });

    it('registers UserPromptSubmit hooks including cognitive router', () => {
      expect(hooksConfig.hooks.UserPromptSubmit).toBeDefined();
      const commands = hooksConfig.hooks.UserPromptSubmit.flatMap(
        (entry) => entry.hooks.map((h) => h.command),
      );
      expect(commands.some((cmd) => cmd.includes('cognitive-router'))).toBe(true);
    });

    it('registers PreToolUse hooks for Write and Bash', () => {
      expect(hooksConfig.hooks.PreToolUse).toBeDefined();
      const matchers = hooksConfig.hooks.PreToolUse.map((e) => e.matcher);
      expect(matchers.some((m) => m.includes('Write'))).toBe(true);
      expect(matchers.some((m) => m.includes('Bash'))).toBe(true);
    });

    it('registers PostToolUse hooks including quality gate', () => {
      expect(hooksConfig.hooks.PostToolUse).toBeDefined();
      const commands = hooksConfig.hooks.PostToolUse.flatMap(
        (entry) => entry.hooks.map((h) => h.command),
      );
      expect(commands.some((cmd) => cmd.includes('quality-gate'))).toBe(true);
    });

    it('registers SessionEnd hooks for cleanup', () => {
      expect(hooksConfig.hooks.SessionEnd).toBeDefined();
      expect(hooksConfig.hooks.SessionEnd.length).toBeGreaterThan(0);
    });

    it('registers SubagentStart and SubagentStop hooks for agent teams', () => {
      expect(hooksConfig.hooks.SubagentStart).toBeDefined();
      expect(hooksConfig.hooks.SubagentStop).toBeDefined();
    });

    it('all hook script paths use CLAUDE_PLUGIN_ROOT variable', () => {
      const allCommands = Object.values(hooksConfig.hooks).flatMap(
        (entries) => entries.flatMap((entry) => entry.hooks.map((h) => h.command)),
      );
      for (const cmd of allCommands) {
        expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}');
      }
    });

    it('all hook scripts reference files that exist on disk', () => {
      const allCommands = Object.values(hooksConfig.hooks).flatMap(
        (entries) => entries.flatMap((entry) => entry.hooks.map((h) => h.command)),
      );
      for (const cmd of allCommands) {
        // Extract the script path: "node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/foo.js [args]"
        const match = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s]+)/);
        if (match) {
          const scriptPath = path.join(PLUGIN_ROOT, match[1]);
          expect(
            () => readFileSync(scriptPath, 'utf-8'),
            `Hook script not found: ${scriptPath}`,
          ).not.toThrow();
        }
      }
    });

    it('all hooks have valid timeouts (positive number, <= 15000ms)', () => {
      const allTimeouts = Object.values(hooksConfig.hooks).flatMap(
        (entries) => entries.flatMap((entry) => entry.hooks.map((h) => h.timeout)),
      );
      for (const timeout of allTimeouts) {
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThanOrEqual(15000);
      }
    });
  });

  describe('Step 4 - Agent definitions consistency', () => {
    let manifest;
    let config;

    beforeEach(() => {
      manifest = JSON.parse(
        readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'),
      );
      config = JSON.parse(
        readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'),
      );
    });

    it('all config taskBased agents have corresponding manifest entries', () => {
      const manifestAgentNames = manifest.agents.map(
        (p) => path.basename(p, '.md'),
      );
      const taskBasedAgents = new Set(Object.values(config.agents.taskBased));

      for (const agent of taskBasedAgents) {
        expect(
          manifestAgentNames,
          `Agent "${agent}" in taskBased config missing from manifest`,
        ).toContain(agent);
      }
    });

    it('all category agents exist in manifest', () => {
      const manifestAgentNames = manifest.agents.map(
        (p) => path.basename(p, '.md'),
      );
      const categoryAgents = Object.values(config.agents.categories).flat();

      for (const agent of categoryAgents) {
        expect(
          manifestAgentNames,
          `Agent "${agent}" in categories missing from manifest`,
        ).toContain(agent);
      }
    });

    it('model policy covers all agents declared in manifest', () => {
      const manifestAgentNames = manifest.agents.map(
        (p) => path.basename(p, '.md'),
      );
      const policyAgents = Object.values(config.agents.modelPolicy).flatMap(
        (tier) => tier.agents,
      );

      for (const agent of manifestAgentNames) {
        expect(
          policyAgents,
          `Agent "${agent}" from manifest missing from modelPolicy`,
        ).toContain(agent);
      }
    });

    it('CTO agent matches orchestrator', () => {
      expect(config.team.ctoAgent).toBe('orchestrator');
    });
  });

  describe('Step 5 - Command definitions discovery', () => {
    let commandFiles;

    beforeEach(() => {
      const commandsDir = path.join(PLUGIN_ROOT, 'commands');
      commandFiles = readdirSync(commandsDir).filter((f) => f.endsWith('.md'));
    });

    it('has the main router command (sc.md)', () => {
      expect(commandFiles).toContain('sc.md');
    });

    it('has the index/catalog command', () => {
      expect(commandFiles).toContain('index.md');
    });

    it('has essential development commands', () => {
      const essential = ['build.md', 'implement.md', 'test.md', 'analyze.md', 'improve.md'];
      for (const cmd of essential) {
        expect(commandFiles, `Missing command: ${cmd}`).toContain(cmd);
      }
    });

    it('has all commands referenced in sc.md routing table', () => {
      const scContent = readFileSync(
        path.join(PLUGIN_ROOT, 'commands', 'sc.md'),
        'utf-8',
      );
      // Extract routing table section between "## Routing Table" and next "##"
      const tableSection = scContent.match(
        /## Routing Table[\s\S]*?\n\n([\s\S]*?)(?=\n## |\n$)/,
      );
      if (!tableSection) return;

      // Extract command names from table rows: "| /command-name |"
      const routedCommands = [...tableSection[1].matchAll(/\| \/(\w[\w-]*)\b/g)]
        .map((m) => m[1])
        .filter((cmd) => !cmd.startsWith('artibot'));
      const commandNames = commandFiles.map((f) => f.replace('.md', ''));

      for (const routed of new Set(routedCommands)) {
        expect(
          commandNames,
          `Routed command "/${routed}" has no .md file in commands/`,
        ).toContain(routed);
      }
    });

    it('each command file has valid YAML frontmatter', () => {
      for (const file of commandFiles) {
        const content = readFileSync(
          path.join(PLUGIN_ROOT, 'commands', file),
          'utf-8',
        );
        expect(
          content.startsWith('---'),
          `Command ${file} missing YAML frontmatter`,
        ).toBe(true);

        const endIndex = content.indexOf('---', 3);
        expect(endIndex, `Command ${file} has unclosed frontmatter`).toBeGreaterThan(3);

        const frontmatter = content.slice(3, endIndex);
        expect(
          frontmatter,
          `Command ${file} frontmatter missing description`,
        ).toContain('description:');
      }
    });
  });

  describe('Step 6 - Cognitive router integration', () => {
    let router;

    beforeEach(async () => {
      vi.resetModules();
      router = await import('../../lib/cognitive/router.js');
      router.resetRouter();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('initializes with default threshold', () => {
      expect(router.getThreshold()).toBe(0.4);
    });

    it('can be configured from config values', () => {
      const config = JSON.parse(
        readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'),
      );
      router.configure({
        threshold: config.cognitive.router.threshold,
        adaptRate: config.cognitive.router.adaptRate,
      });
      expect(router.getThreshold()).toBe(config.cognitive.router.threshold);
    });

    it('routes simple inputs to System 1', () => {
      const result = router.route('fix a typo');
      expect(result.system).toBe(1);
      expect(result.classification.confidence).toBeGreaterThan(0);
    });

    it('routes complex multi-domain inputs to System 2', () => {
      const result = router.route(
        'analyze security vulnerabilities in the API, then deploy to production after migration',
      );
      expect(result.system).toBe(2);
    });

    it('records routing history', () => {
      router.route('hello world');
      router.route('analyze architecture');
      const stats = router.getRoutingStats();
      expect(stats.totalRouted).toBe(2);
    });
  });
});
