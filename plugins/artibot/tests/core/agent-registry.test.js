import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetAgentCache,
  filterAgents,
  getAgent,
  getAgentsForLifecycle,
  listAgents,
  loadAgentRegistry,
  loadAgents,
  stripTrailingComment,
} from '../../lib/core/agent-registry.js';

/**
 * The registry reads `getPluginRoot()` to locate `agents/`. These tests
 * exercise the real plugin layout. The exact count is read from the agents
 * directory at runtime so adding a new agent doesn't break this test.
 * Contracts under test — lifecycle distribution, required fields, cache
 * semantics — are layout-stable.
 */

describe('agent-registry', () => {
  beforeEach(() => {
    _resetAgentCache();
  });

  describe('loadAgentRegistry', () => {
    it('returns a non-empty Map of agents from the live agents directory', async () => {
      const registry = await loadAgentRegistry();
      expect(registry).toBeInstanceOf(Map);
      expect(registry.size).toBeGreaterThanOrEqual(20);
    });

    it('each entry has name, capabilities, lifecycle, and path fields', async () => {
      const registry = await loadAgentRegistry();
      for (const entry of registry.values()) {
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(Array.isArray(entry.capabilities)).toBe(true);
        expect('lifecycle' in entry).toBe(true);
        expect(typeof entry.path).toBe('string');
        expect(typeof entry.mtimeMs).toBe('number');
      }
    });

    it('returns the same Map reference on repeat calls (mtime cached)', async () => {
      const first = await loadAgentRegistry();
      const second = await loadAgentRegistry();
      expect(second).toBe(first);
    });

    it('rebuilds after _resetAgentCache()', async () => {
      const first = await loadAgentRegistry();
      _resetAgentCache();
      const second = await loadAgentRegistry();
      expect(second).not.toBe(first);
      expect(second.size).toBe(first.size);
    });
  });

  describe('getAgent', () => {
    it("returns orchestrator entry with lifecycle: null", async () => {
      const entry = await getAgent('orchestrator');
      expect(entry).not.toBeNull();
      expect(entry.name).toBe('orchestrator');
      expect(entry.lifecycle).toBeNull();
    });

    it("returns backend-developer entry with lifecycle: 'build' and non-empty capabilities", async () => {
      const entry = await getAgent('backend-developer');
      expect(entry).not.toBeNull();
      expect(entry.lifecycle).toBe('build');
      expect(entry.capabilities.length).toBeGreaterThan(0);
      expect(entry.capabilities).toContain('api-design');
    });

    it('returns null for a nonexistent agent', async () => {
      const entry = await getAgent('nonexistent-agent-xyz');
      expect(entry).toBeNull();
    });

    it('every entry.path points to an existing .md file', async () => {
      const registry = await loadAgentRegistry();
      for (const entry of registry.values()) {
        expect(entry.path.endsWith('.md')).toBe(true);
        expect(existsSync(entry.path)).toBe(true);
      }
    });
  });

  describe('listAgents', () => {
    it('returns exactly 30 agent names', async () => {
      const names = await listAgents();
      expect(names).toHaveLength(30);
      expect(names).toContain('orchestrator');
      expect(names).toContain('backend-developer');
      expect(names).toContain('frontend-developer');
    });
  });

  describe('filterAgents', () => {
    it("returns 6 agents when filtering lifecycle === 'marketing'", async () => {
      const agents = await filterAgents((a) => a.lifecycle === 'marketing');
      expect(agents).toHaveLength(6);
    });

    it('returns only entries satisfying the predicate', async () => {
      const withModel = await filterAgents((a) => a.model !== undefined);
      for (const a of withModel) {
        expect(a.model).toBeDefined();
      }
    });
  });

  describe('getAgentsForLifecycle', () => {
    it("returns >= 8 agents for lifecycle 'build'", async () => {
      const agents = await getAgentsForLifecycle('build');
      expect(agents.length).toBeGreaterThanOrEqual(8);
      for (const a of agents) {
        expect(a.lifecycle).toBe('build');
      }
    });

    it("returns cross-phase agents (lifecycle=null) when passed 'null'", async () => {
      const agents = await getAgentsForLifecycle('null');
      const names = agents.map((a) => a.name).sort();
      expect(names).toContain('orchestrator');
      expect(names).toContain('repo-benchmarker');
      for (const a of agents) {
        expect(a.lifecycle).toBeNull();
      }
    });
  });
});

/**
 * A YAML block-list item may carry a trailing line comment (`  - Read  # why`).
 * The comment is not part of the value: it must not reach `tools` (which the MCP
 * `get-agent` / `list-agents` tools return) or `capabilities`. YAML rule: `#`
 * starts a comment only after whitespace, and never inside a quoted scalar.
 */
describe('agent-registry block-list trailing comments', () => {
  // The rule itself, shared with scripts/validate-agent-frontmatter.js. It returns the scalar with
  // its quotes still on: dropping the outer quotes is the caller's next step.
  describe('stripTrailingComment', () => {
    it.each([
      ['Read  # why', 'Read'],
      ['Read\t# why', 'Read'],
      ['Read #', 'Read'],
      ['"Read"  # why', '"Read"'],
      ["'Read'  # why", "'Read'"],
      ['"a # b"', '"a # b"'],
      ['"a # b"   # real', '"a # b"'],
      ["'it''s # kept'  # real", "'it''s # kept'"],
      ['"say \\" # kept"  # real', '"say \\" # kept"'],
      ['mcp__srv__tool#v2', 'mcp__srv__tool#v2'],
      ["don't # note", "don't"],
      ['# only a comment', ''],
      ['"unterminated # kept', '"unterminated # kept'],
      ['', ''],
    ])('turns %j into %j', (input, expected) => {
      expect(stripTrailingComment(input)).toBe(expected);
    });
  });

  describe('live agents', () => {
    beforeEach(() => {
      _resetAgentCache();
    });

    it('keeps comment text out of every live agent tool name', async () => {
      const registry = await loadAgentRegistry();
      const dirty = [];
      for (const entry of registry.values()) {
        for (const tool of entry.tools ?? []) {
          if (tool.includes('#')) dirty.push(`${entry.name}: ${tool}`);
        }
      }
      expect(dirty).toEqual([]);
    });

    // Without this the case above would also pass if the parser lost the tools list.
    it('still lists the orchestrator tool whose frontmatter line carries a comment', async () => {
      const entry = await getAgent('orchestrator');
      expect(entry.tools).toContain('SendMessage');
      expect(entry.tools.every((tool) => tool === tool.trim() && !/\s/.test(tool))).toBe(true);
    });
  });

  describe('frontmatter fixtures', () => {
    /** @type {string} */
    let extRoot;

    beforeEach(() => {
      extRoot = mkdtempSync(path.join(tmpdir(), 'artibot-registry-comments-'));
    });

    afterEach(() => {
      rmSync(extRoot, { recursive: true, force: true });
    });

    /** Run `frontmatterLines` through the real parser as an external drop-in agent. */
    async function parseProbe(frontmatterLines) {
      const extDir = path.join(extRoot, 'artibot-ext-fx');
      mkdirSync(path.join(extDir, 'agents'), { recursive: true });
      writeFileSync(
        path.join(extDir, 'artibot.ext.json'),
        JSON.stringify({ name: 'fx', version: '1.0.0', dataPolicy: 'local' }),
        'utf-8',
      );
      writeFileSync(
        path.join(extDir, 'agents', 'probe.md'),
        ['---', 'name: probe', 'description: fixture', ...frontmatterLines, '---', 'body'].join('\n'),
        'utf-8',
      );
      const agents = await loadAgents(undefined, { includeExternal: true, searchPaths: [extRoot] });
      return agents.get('fx:probe');
    }

    const withCapability = (...toolLines) => ['capabilities:', '  - "probe"', 'tools:', ...toolLines];

    it.each([
      { what: 'a plain item', line: '  - Read  # why', expected: 'Read' },
      { what: 'a tab before the hash', line: '  - Read\t# why', expected: 'Read' },
      { what: 'an empty comment', line: '  - Read #', expected: 'Read' },
      { what: 'a double-quoted item', line: '  - "Read"  # why', expected: 'Read' },
      { what: 'a single-quoted item', line: "  - 'Read'  # why", expected: 'Read' },
    ])('drops the trailing comment of $what', async ({ line, expected }) => {
      const entry = await parseProbe(withCapability(line));
      expect(entry).toBeDefined();
      expect(entry.tools).toEqual([expected]);
    });

    // The hash is data here, not a comment: a stripper that cuts at the first " #" breaks these.
    it.each([
      { what: 'a hash inside double quotes', line: '  - "Read # kept"', expected: 'Read # kept' },
      { what: 'a hash inside single quotes, then a real comment', line: "  - 'Read # kept'   # real", expected: 'Read # kept' },
      { what: 'an escaped double quote before a hash', line: '  - "say \\" # kept"  # real', expected: 'say \\" # kept' },
      { what: 'a doubled single quote before a hash', line: "  - 'it''s # kept'  # real", expected: "it''s # kept" },
      { what: 'a hash with no whitespace before it', line: '  - mcp__srv__tool#v2', expected: 'mcp__srv__tool#v2' },
      { what: 'an apostrophe inside a plain item', line: "  - don't # note", expected: "don't" },
    ])('keeps the hash of $what', async ({ line, expected }) => {
      const entry = await parseProbe(withCapability(line));
      expect(entry).toBeDefined();
      expect(entry.tools).toEqual([expected]);
    });

    it('skips an item that is only a comment and keeps its neighbours', async () => {
      const entry = await parseProbe(withCapability('  - Read', '  - # nothing here', '  - Write  # why'));
      expect(entry.tools).toEqual(['Read', 'Write']);
    });

    it('keeps skipping whole-line comments between items', async () => {
      const entry = await parseProbe(withCapability('  # --- group ---', '  - Read', '  # more', '  - Write'));
      expect(entry.tools).toEqual(['Read', 'Write']);
    });

    it('strips trailing comments from capabilities too, which share the list parser', async () => {
      const entry = await parseProbe(['capabilities:', '  - api-design  # core', '  - "testing"  # quoted', 'tools:', '  - Read']);
      expect(entry.capabilities).toEqual(['api-design', 'testing']);
    });
  });
});
