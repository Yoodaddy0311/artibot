/**
 * Tests for scripts/export-to-tool.mjs — cross-tool agent exporter.
 *
 * Covers:
 *   1. parseFrontmatter (scalar / block-scalar / nested-list / inline-array)
 *   2. parseArgs (all CLI flags, including --agents and --dry-run)
 *   3. convertCursor / convertCodex / convertOpenCode / convertAntigravity (pure functions)
 *   4. runExport end-to-end with both --dry-run and real file writes
 *   5. Error cases: unsupported tool, missing agent, missing --out without --dry-run
 *   6. Team Collaboration stripping for codex + opencode
 *   7. Skills + commands export via --include flag
 *   8. Platform-specific ref replacement in skills/commands
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/* eslint-disable sort-imports */
import {
  CONVERTERS,
  collectAgents,
  collectCommands,
  collectSkills,
  convertAntigravity,
  convertCodex,
  convertCommandForPlatform,
  convertCursor,
  convertOpenCode,
  convertSkillForPlatform,
  parseArgs,
  parseFrontmatter,
  parseInclude,
  runExport,
  stripPlatformRefs,
  stripTeamCollaboration,
  toKebabCase,
} from '../../scripts/export-to-tool.mjs';
/* eslint-enable sort-imports */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(prefix) {
  const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeFixtureAgents(dir, fixtures) {
  for (const [file, content] of Object.entries(fixtures)) {
    await writeFile(path.join(dir, file), content, 'utf8');
  }
}

const FIX_MINIMAL = `---
name: minimal-agent
description: A bare-minimum agent with only required fields.
---

# Body

Only a heading.
`;

const FIX_STANDARD = `---
name: standard-agent
description: Standard agent with tools and model info.
model: sonnet
category: expert
tools:
  - Read
  - Write
  - Edit
---

## Core

Standard body.
`;

const FIX_RICH = `---
name: rich-agent
description: |
  Multi-line description
  that spans several lines.
model: opus
modelTier: premium
category: manager
tools:
  - Read
  - Write
  - SendMessage          # for team coordination
  - TaskCreate
permissionMode: delegate
maxTurns: 25
skills:
  - orchestration
  - delegation
---

## Role

Rich agent body.

## Team Collaboration

This section depends on Claude Agent Teams API:
- TaskCreate
- SendMessage

## Anti-Patterns

Keep me.
`;

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe('export-to-tool/parseFrontmatter', () => {
  it('parses scalar fields', () => {
    const { frontmatter, body } = parseFrontmatter(FIX_MINIMAL);
    expect(frontmatter.name).toBe('minimal-agent');
    expect(frontmatter.description).toBe('A bare-minimum agent with only required fields.');
    expect(body).toContain('# Body');
  });

  it('parses nested list (tools array)', () => {
    const { frontmatter } = parseFrontmatter(FIX_STANDARD);
    expect(frontmatter.tools).toEqual(['Read', 'Write', 'Edit']);
    expect(frontmatter.model).toBe('sonnet');
    expect(frontmatter.category).toBe('expert');
  });

  it('parses block scalar (description: |) and strips inline list comments', () => {
    const { frontmatter } = parseFrontmatter(FIX_RICH);
    expect(frontmatter.description).toContain('Multi-line description');
    expect(frontmatter.description).toContain('several lines.');
    // inline comment stripped
    expect(frontmatter.tools).toEqual(['Read', 'Write', 'SendMessage', 'TaskCreate']);
    expect(frontmatter.skills).toEqual(['orchestration', 'delegation']);
    expect(frontmatter.permissionMode).toBe('delegate');
    expect(frontmatter.maxTurns).toBe('25');
    expect(frontmatter.modelTier).toBe('premium');
  });

  it('parses inline array syntax [a, b, c]', () => {
    const src = `---
name: inline
capabilities: [planning, dispatch]
---
body`;
    const { frontmatter } = parseFrontmatter(src);
    expect(frontmatter.capabilities).toEqual(['planning', 'dispatch']);
  });

  it('returns empty frontmatter and full body when no frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter('no frontmatter here\n\nbody');
    expect(frontmatter).toEqual({});
    expect(body).toBe('no frontmatter here\n\nbody');
  });

  it('returns empty frontmatter when closing delimiter missing', () => {
    const { frontmatter } = parseFrontmatter('---\nname: foo\nincomplete');
    expect(frontmatter).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('export-to-tool/parseArgs', () => {
  it('parses all flags', () => {
    const args = parseArgs(['--tool', 'cursor', '--out', './foo', '--agents', 'a,b', '--include', 'all', '--dry-run']);
    expect(args.tool).toBe('cursor');
    expect(args.out).toBe('./foo');
    expect(args.agents).toBe('a,b');
    expect(args.include).toBe('all');
    expect(args.dryRun).toBe(true);
    expect(args.help).toBe(false);
  });

  it('defaults missing flags to null/false', () => {
    const args = parseArgs([]);
    expect(args.tool).toBeNull();
    expect(args.out).toBeNull();
    expect(args.agents).toBeNull();
    expect(args.include).toBe('agents');
    expect(args.dryRun).toBe(false);
  });

  it('recognises --help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toKebabCase
// ---------------------------------------------------------------------------

describe('export-to-tool/toKebabCase', () => {
  it('converts camelCase and spaces', () => {
    expect(toKebabCase('fooBar')).toBe('foo-bar');
    expect(toKebabCase('Foo Bar Baz')).toBe('foo-bar-baz');
    expect(toKebabCase('already-kebab')).toBe('already-kebab');
  });
});

// ---------------------------------------------------------------------------
// stripTeamCollaboration
// ---------------------------------------------------------------------------

describe('export-to-tool/stripTeamCollaboration', () => {
  it('removes Team Collaboration section up to next h2', () => {
    const body = `## A

keep

## Team Collaboration

drop me
drop too

## B

keep b
`;
    const out = stripTeamCollaboration(body, ['Note A']);
    expect(out).not.toContain('drop me');
    expect(out).not.toContain('drop too');
    expect(out).toContain('<!-- Note A -->');
    expect(out).toContain('## B');
    expect(out).toContain('keep b');
    expect(out).toContain('## A');
  });

  it('returns input unchanged when no Team Collaboration section', () => {
    const body = '## Just A\n\nhi\n';
    const out = stripTeamCollaboration(body, ['x']);
    expect(out).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Pure converters — using fixture agents
// ---------------------------------------------------------------------------

describe('export-to-tool/convertCursor', () => {
  it('minimal agent produces valid .mdc', () => {
    const parsed = parseFrontmatter(FIX_MINIMAL);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model || 'opus',
      modelTier: parsed.frontmatter.modelTier || '',
      category: parsed.frontmatter.category || '',
      tools: parsed.frontmatter.tools || [],
      permissionMode: '',
      maxTurns: '',
      skills: [],
      body: parsed.body,
    };
    const { fileName, content } = convertCursor(agent);
    expect(fileName).toBe('minimal-agent.mdc');
    expect(content).toMatch(/^---\ndescription:/);
    expect(content).toContain('alwaysApply: false');
    expect(content).toContain('globs: ["**/*"]');
    expect(content).toContain('(none declared)');
    expect(content).toContain('# Body');
  });

  it('rich agent preserves body and tools note', () => {
    const parsed = parseFrontmatter(FIX_RICH);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model,
      modelTier: parsed.frontmatter.modelTier,
      category: parsed.frontmatter.category,
      tools: parsed.frontmatter.tools,
      permissionMode: parsed.frontmatter.permissionMode,
      maxTurns: parsed.frontmatter.maxTurns,
      skills: parsed.frontmatter.skills,
      body: parsed.body,
    };
    const { content } = convertCursor(agent);
    expect(content).toContain('Artibot source tools: Read, Write, SendMessage, TaskCreate');
    expect(content).toContain('opus (premium)');
    expect(content).toContain('## Role');
    // Cursor keeps the whole body (including Team Collaboration) by design
    expect(content).toContain('Team Collaboration');
  });
});

describe('export-to-tool/convertCodex', () => {
  it('produces YAML frontmatter with name/description/model/tools', () => {
    const parsed = parseFrontmatter(FIX_STANDARD);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model,
      modelTier: '',
      category: parsed.frontmatter.category,
      tools: parsed.frontmatter.tools,
      permissionMode: '',
      maxTurns: '',
      skills: [],
      body: parsed.body,
    };
    const { fileName, content } = convertCodex(agent);
    expect(fileName).toBe('standard-agent.md');
    expect(content).toMatch(/^---\nname: standard-agent\n/);
    expect(content).toContain('description: "Standard agent with tools and model info."');
    expect(content).toContain('model: sonnet');
    expect(content).toContain('tools:\n  - Read\n  - Write\n  - Edit');
  });

  it('preserves Claude-specific fields as HTML comments', () => {
    const parsed = parseFrontmatter(FIX_RICH);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model,
      modelTier: parsed.frontmatter.modelTier,
      category: parsed.frontmatter.category,
      tools: parsed.frontmatter.tools,
      permissionMode: parsed.frontmatter.permissionMode,
      maxTurns: parsed.frontmatter.maxTurns,
      skills: parsed.frontmatter.skills,
      body: parsed.body,
    };
    const { content } = convertCodex(agent);
    expect(content).toContain('<!-- Claude-specific: modelTier=premium -->');
    expect(content).toContain('<!-- Claude-specific: permissionMode=delegate -->');
    expect(content).toContain('<!-- Claude-specific: maxTurns=25 -->');
    expect(content).toContain('<!-- Claude-specific: skills=orchestration, delegation -->');
  });

  it('strips Team Collaboration section and adds fallback note', () => {
    const parsed = parseFrontmatter(FIX_RICH);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model,
      modelTier: parsed.frontmatter.modelTier,
      category: parsed.frontmatter.category,
      tools: parsed.frontmatter.tools,
      permissionMode: parsed.frontmatter.permissionMode,
      maxTurns: parsed.frontmatter.maxTurns,
      skills: parsed.frontmatter.skills,
      body: parsed.body,
    };
    const { content } = convertCodex(agent);
    expect(content).not.toContain('## Team Collaboration');
    expect(content).toContain('not supported in Codex');
    expect(content).toContain('## Anti-Patterns');
  });
});

describe('export-to-tool/convertOpenCode', () => {
  it('keeps minimal frontmatter and buries rest as artibot-meta comment', () => {
    const parsed = parseFrontmatter(FIX_RICH);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model,
      modelTier: parsed.frontmatter.modelTier,
      category: parsed.frontmatter.category,
      tools: parsed.frontmatter.tools,
      permissionMode: parsed.frontmatter.permissionMode,
      maxTurns: parsed.frontmatter.maxTurns,
      skills: parsed.frontmatter.skills,
      body: parsed.body,
    };
    const { fileName, content } = convertOpenCode(agent);
    expect(fileName).toBe('rich-agent.md');
    // minimal frontmatter
    expect(content).toMatch(/^---\nname: rich-agent\n/);
    expect(content).toContain('tools:\n  - Read');
    // but NOT permissionMode in frontmatter
    expect(content).not.toMatch(/^permissionMode:/m);
    // artibot-meta comment carries the rest
    expect(content).toContain('artibot-meta: model=opus; modelTier=premium; category=manager');
    expect(content).toContain('skills=orchestration, delegation');
    // Team Collaboration stripped
    expect(content).not.toContain('## Team Collaboration');
  });
});

// ---------------------------------------------------------------------------
// convertAntigravity
// ---------------------------------------------------------------------------

describe('export-to-tool/convertAntigravity', () => {
  it('produces YAML frontmatter with name/description/model/tools', () => {
    const parsed = parseFrontmatter(FIX_STANDARD);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model,
      modelTier: '',
      category: parsed.frontmatter.category,
      tools: parsed.frontmatter.tools,
      permissionMode: '',
      maxTurns: '',
      skills: [],
      body: parsed.body,
    };
    const { fileName, content } = convertAntigravity(agent);
    expect(fileName).toBe('standard-agent.md');
    expect(content).toMatch(/^---\nname: standard-agent\n/);
    expect(content).toContain('description: "Standard agent with tools and model info."');
    expect(content).toContain('model: sonnet');
    expect(content).toContain('tools:\n  - Read\n  - Write\n  - Edit');
  });

  it('strips Team Collaboration section and adds Agent Manager note', () => {
    const parsed = parseFrontmatter(FIX_RICH);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model,
      modelTier: parsed.frontmatter.modelTier,
      category: parsed.frontmatter.category,
      tools: parsed.frontmatter.tools,
      permissionMode: parsed.frontmatter.permissionMode,
      maxTurns: parsed.frontmatter.maxTurns,
      skills: parsed.frontmatter.skills,
      body: parsed.body,
    };
    const { content } = convertAntigravity(agent);
    expect(content).not.toContain('## Team Collaboration');
    expect(content).toContain('not available in Antigravity');
    expect(content).toContain('Agent Manager');
    expect(content).toContain('## Anti-Patterns');
  });

  it('replaces Claude Code references with Google Antigravity', () => {
    const agent = {
      name: 'test-agent',
      description: 'test',
      model: 'opus',
      modelTier: '',
      category: '',
      tools: [],
      permissionMode: '',
      maxTurns: '',
      skills: [],
      body: 'Use Claude Code to run tests.\n\nCall TaskCreate() to spawn work.',
    };
    const { content } = convertAntigravity(agent);
    expect(content).toContain('Google Antigravity');
    expect(content).not.toContain('Claude Code');
    expect(content).toContain('Create task in Agent Manager');
    expect(content).not.toContain('TaskCreate()');
  });

  it('translates Agent(...) spawn calls into the Agent Manager verb', () => {
    // REGRESSION GUARD. `Agent(` is the current spelling of "spawn a teammate";
    // the replacers were keyed on the retired `TeamCreate(`/`Task(` only, so the
    // export SUCCEEDED while shipping an untranslated Claude-only call — a
    // fail-open no-op. Measured 2026-08-15 before the fix: 69 `Agent(` reached
    // the antigravity output.
    const agent = {
      name: 'test-agent',
      description: 'test',
      model: 'opus',
      modelTier: '',
      category: '',
      tools: [],
      permissionMode: '',
      maxTurns: '',
      skills: [],
      // createAgent( must survive: /Agent\(/ without the \b boundary would
      // rewrite its tail. (TaskUpdate etc. ARE translated here on purpose —
      // Antigravity has an Agent Manager equivalent — so they are not pinned.)
      body: 'Spawn with Agent(planner, name="p").\ncreateAgent({ x }) stays.',
    };
    const { content } = convertAntigravity(agent);
    expect(content).toContain('Spawn agents via Agent Manager');
    expect(content).not.toContain('Agent(planner');
    expect(content).toContain('createAgent({ x })');
  });

  it('preserves Claude-specific fields as HTML comments', () => {
    const parsed = parseFrontmatter(FIX_RICH);
    const agent = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      model: parsed.frontmatter.model,
      modelTier: parsed.frontmatter.modelTier,
      category: parsed.frontmatter.category,
      tools: parsed.frontmatter.tools,
      permissionMode: parsed.frontmatter.permissionMode,
      maxTurns: parsed.frontmatter.maxTurns,
      skills: parsed.frontmatter.skills,
      body: parsed.body,
    };
    const { content } = convertAntigravity(agent);
    expect(content).toContain('<!-- Claude-specific: modelTier=premium -->');
    expect(content).toContain('<!-- Claude-specific: permissionMode=delegate -->');
    expect(content).toContain('<!-- Claude-specific: skills=orchestration, delegation -->');
  });
});

// ---------------------------------------------------------------------------
// parseInclude
// ---------------------------------------------------------------------------

describe('export-to-tool/parseInclude', () => {
  it('defaults to agents-only', () => {
    expect(parseInclude(undefined)).toEqual(new Set(['agents']));
    expect(parseInclude('agents')).toEqual(new Set(['agents']));
  });

  it('"all" expands to agents+skills+commands', () => {
    expect(parseInclude('all')).toEqual(new Set(['agents', 'skills', 'commands']));
  });

  it('parses comma-separated values', () => {
    expect(parseInclude('skills,commands')).toEqual(new Set(['skills', 'commands']));
  });

  it('rejects invalid values', () => {
    expect(() => parseInclude('agents,bogus')).toThrow(/invalid --include value: bogus/);
  });
});

// ---------------------------------------------------------------------------
// stripPlatformRefs + convertSkillForPlatform + convertCommandForPlatform
// ---------------------------------------------------------------------------

describe('export-to-tool/stripPlatformRefs', () => {
  it('replaces Claude paths with platform-specific equivalents', () => {
    const input = 'Load from .claude/skills/foo. See CLAUDE.md. Use Claude Code.';
    const out = stripPlatformRefs(input, 'codex');
    expect(out).toContain('.codex/skills/foo');
    expect(out).toContain('AGENTS.md');
    expect(out).toContain('Codex CLI');
    expect(out).not.toContain('Claude Code');
    expect(out).not.toContain('CLAUDE.md');
  });

  it('handles antigravity mapping', () => {
    const input = 'See .claude/skills/bar and CLAUDE.md for Claude Code.';
    const out = stripPlatformRefs(input, 'antigravity');
    expect(out).toContain('.antigravity/skills/bar');
    expect(out).toContain('.antigravity/rules.md');
    expect(out).toContain('Google Antigravity');
  });
});

describe('export-to-tool/convertSkillForPlatform', () => {
  it('places skill in skills/<dirName>/SKILL.md with platform refs', () => {
    const skill = {
      dirName: 'my-skill',
      name: 'my-skill',
      content: '---\nname: my-skill\n---\nUse .claude/skills/my-skill in Claude Code.',
    };
    const result = convertSkillForPlatform(skill, 'codex');
    expect(result.fileName).toMatch(/skills[\\/]my-skill[\\/]SKILL\.md$/);
    expect(result.content).toContain('.codex/skills/my-skill');
    expect(result.content).not.toContain('.claude/skills/');
  });
});

describe('export-to-tool/convertCommandForPlatform', () => {
  it('places command in commands/<name>.md with platform refs', () => {
    const command = {
      name: 'build',
      content: '---\ndescription: Build project\n---\nRun Claude Code build.',
    };
    const result = convertCommandForPlatform(command, 'antigravity');
    expect(result.fileName).toMatch(/commands[\\/]build\.md$/);
    expect(result.content).toContain('Google Antigravity');
    expect(result.content).not.toContain('Claude Code');
  });
});

// ---------------------------------------------------------------------------
// collectAgents + runExport (end-to-end)
// ---------------------------------------------------------------------------

describe('export-to-tool/collectAgents + runExport', () => {
  let fixturesDir;
  let outDir;

  beforeEach(async () => {
    fixturesDir = await makeTmpDir('artibot-export-fixtures');
    outDir = await makeTmpDir('artibot-export-out');
    await writeFixtureAgents(fixturesDir, {
      'minimal-agent.md': FIX_MINIMAL,
      'standard-agent.md': FIX_STANDARD,
      'rich-agent.md': FIX_RICH,
      // should be ignored
      'INDEX.md': '# index',
      'notes.txt': 'ignore me',
    });
  });

  afterEach(async () => {
    await rm(fixturesDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it('collectAgents discovers only .md files, ignores INDEX.md', async () => {
    const agents = await collectAgents(fixturesDir);
    const names = agents.map((a) => a.name).sort();
    expect(names).toEqual(['minimal-agent', 'rich-agent', 'standard-agent']);
  });

  it('collectAgents filter selects subset', async () => {
    const agents = await collectAgents(fixturesDir, 'rich-agent,minimal-agent');
    expect(agents.map((a) => a.name).sort()).toEqual(['minimal-agent', 'rich-agent']);
  });

  it('collectAgents throws for missing agent in filter', async () => {
    await expect(collectAgents(fixturesDir, 'does-not-exist')).rejects.toThrow(
      /agent not found: does-not-exist/,
    );
  });

  it('runExport dry-run does not write files', async () => {
    const summary = await runExport(
      { tool: 'cursor', out: null, agents: null, dryRun: true },
      { agentsDir: fixturesDir },
    );
    expect(summary.agentCount).toBe(3);
    expect(summary.dryRun).toBe(true);
    expect(summary.files).toHaveLength(3);
    // outDir remains empty
    const entries = await readdir(outDir);
    expect(entries).toEqual([]);
  });

  it('runExport writes cursor files with .mdc extension', async () => {
    const summary = await runExport(
      { tool: 'cursor', out: outDir, agents: null, dryRun: false },
      { agentsDir: fixturesDir },
    );
    expect(summary.agentCount).toBe(3);
    const files = (await readdir(outDir)).sort();
    expect(files).toEqual(['minimal-agent.mdc', 'rich-agent.mdc', 'standard-agent.mdc']);
    const mdc = await readFile(path.join(outDir, 'rich-agent.mdc'), 'utf8');
    expect(mdc).toContain('alwaysApply: false');
    expect(mdc).toContain('## Role');
  });

  it('runExport writes codex files with .md extension', async () => {
    const summary = await runExport(
      { tool: 'codex', out: outDir, agents: 'rich-agent', dryRun: false },
      { agentsDir: fixturesDir },
    );
    expect(summary.agentCount).toBe(1);
    const files = await readdir(outDir);
    expect(files).toEqual(['rich-agent.md']);
    const md = await readFile(path.join(outDir, 'rich-agent.md'), 'utf8');
    expect(md).toContain('name: rich-agent');
    expect(md).toContain('not supported in Codex');
  });

  it('runExport writes opencode files with minimal frontmatter', async () => {
    const summary = await runExport(
      { tool: 'opencode', out: outDir, agents: null, dryRun: false },
      { agentsDir: fixturesDir },
    );
    expect(summary.agentCount).toBe(3);
    const md = await readFile(path.join(outDir, 'rich-agent.md'), 'utf8');
    expect(md).toContain('artibot-meta:');
    expect(md).not.toMatch(/^permissionMode:/m);
  });

  it('runExport writes antigravity files with Agent Manager refs', async () => {
    const summary = await runExport(
      { tool: 'antigravity', out: outDir, agents: 'rich-agent', dryRun: false },
      { agentsDir: fixturesDir },
    );
    expect(summary.agentCount).toBe(1);
    const files = await readdir(outDir);
    expect(files).toEqual(['rich-agent.md']);
    const md = await readFile(path.join(outDir, 'rich-agent.md'), 'utf8');
    expect(md).toContain('name: rich-agent');
    expect(md).toContain('not available in Antigravity');
    expect(md).not.toContain('Claude Code');
  });

  it('runExport rejects unsupported tool', async () => {
    await expect(
      runExport({ tool: 'nonsense', out: outDir, agents: null, dryRun: true }, { agentsDir: fixturesDir }),
    ).rejects.toThrow(/unsupported tool: nonsense/);
  });

  it('runExport requires --out unless --dry-run', async () => {
    await expect(
      runExport({ tool: 'cursor', out: null, agents: null, dryRun: false }, { agentsDir: fixturesDir }),
    ).rejects.toThrow(/--out is required/);
  });

  it('runExport creates output dir if it does not exist', async () => {
    const nestedOut = path.join(outDir, 'nested', 'deep');
    expect(existsSync(nestedOut)).toBe(false);
    await runExport(
      { tool: 'opencode', out: nestedOut, agents: 'minimal-agent', dryRun: false },
      { agentsDir: fixturesDir },
    );
    expect(existsSync(nestedOut)).toBe(true);
    const files = await readdir(nestedOut);
    expect(files).toEqual(['minimal-agent.md']);
  });

  it('CONVERTERS registry exposes all four converters', () => {
    expect(typeof CONVERTERS.cursor).toBe('function');
    expect(typeof CONVERTERS.codex).toBe('function');
    expect(typeof CONVERTERS.opencode).toBe('function');
    expect(typeof CONVERTERS.antigravity).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Skills + commands export (--include)
// ---------------------------------------------------------------------------

describe('export-to-tool/skills+commands export', () => {
  let agentsDir;
  let skillsDir;
  let commandsDir;
  let outDir;

  beforeEach(async () => {
    agentsDir = await makeTmpDir('artibot-export-agents');
    skillsDir = await makeTmpDir('artibot-export-skills');
    commandsDir = await makeTmpDir('artibot-export-commands');
    outDir = await makeTmpDir('artibot-export-out');

    // agents
    await writeFile(path.join(agentsDir, 'test-agent.md'), FIX_MINIMAL, 'utf8');

    // skills: create skill directories with SKILL.md
    await mkdir(path.join(skillsDir, 'coding-standards'));
    await writeFile(
      path.join(skillsDir, 'coding-standards', 'SKILL.md'),
      '---\nname: coding-standards\ndescription: Standards\n---\nUse .claude/skills/coding-standards in Claude Code.',
      'utf8',
    );
    await mkdir(path.join(skillsDir, 'tdd-workflow'));
    await writeFile(
      path.join(skillsDir, 'tdd-workflow', 'SKILL.md'),
      '---\nname: tdd-workflow\ndescription: TDD\n---\nSee CLAUDE.md for Claude Code workflow.',
      'utf8',
    );

    // commands
    await writeFile(
      path.join(commandsDir, 'build.md'),
      '---\ndescription: Build project\n---\nRun Claude Code build pipeline.',
      'utf8',
    );
    await writeFile(
      path.join(commandsDir, 'test.md'),
      '---\ndescription: Run tests\n---\nExecute Claude Code tests.',
      'utf8',
    );
    await writeFile(path.join(commandsDir, 'index.md'), '# index (should be skipped)', 'utf8');
  });

  afterEach(async () => {
    await rm(agentsDir, { recursive: true, force: true });
    await rm(skillsDir, { recursive: true, force: true });
    await rm(commandsDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  it('collectSkills discovers skill directories with SKILL.md', async () => {
    const skills = await collectSkills(skillsDir);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['coding-standards', 'tdd-workflow']);
  });

  it('collectCommands discovers .md files, ignores index.md', async () => {
    const commands = await collectCommands(commandsDir);
    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(['build', 'test']);
  });

  it('runExport with --include all exports agents+skills+commands', async () => {
    const summary = await runExport(
      { tool: 'codex', out: outDir, agents: null, include: 'all', dryRun: false },
      { agentsDir, skillsDir, commandsDir },
    );
    expect(summary.agentCount).toBe(1);
    expect(summary.skillCount).toBe(2);
    expect(summary.commandCount).toBe(2);
    expect(summary.include).toEqual(['agents', 'skills', 'commands']);
    expect(summary.files).toHaveLength(5);

    // agents go in agents/ subdir when include > 1 type
    const agentFiles = summary.files.filter((f) => f.type === 'agent');
    expect(agentFiles[0].fileName).toMatch(/^agents[\\/]/);

    // skills go in skills/<dir>/SKILL.md
    const skillFiles = summary.files.filter((f) => f.type === 'skill');
    expect(skillFiles).toHaveLength(2);
    expect(skillFiles.some((f) => f.fileName.includes('coding-standards'))).toBe(true);

    // commands go in commands/<name>.md
    const cmdFiles = summary.files.filter((f) => f.type === 'command');
    expect(cmdFiles).toHaveLength(2);
  });

  it('skills content has platform-specific refs (codex)', async () => {
    await runExport(
      { tool: 'codex', out: outDir, agents: null, include: 'skills', dryRun: false },
      { agentsDir, skillsDir, commandsDir },
    );
    const skillFile = path.join(outDir, 'skills', 'coding-standards', 'SKILL.md');
    const content = await readFile(skillFile, 'utf8');
    expect(content).toContain('.codex/skills/coding-standards');
    expect(content).toContain('Codex CLI');
    expect(content).not.toContain('.claude/skills/');
    expect(content).not.toContain('Claude Code');
  });

  it('commands content has platform-specific refs (antigravity)', async () => {
    await runExport(
      { tool: 'antigravity', out: outDir, agents: null, include: 'commands', dryRun: false },
      { agentsDir, skillsDir, commandsDir },
    );
    const cmdFile = path.join(outDir, 'commands', 'build.md');
    const content = await readFile(cmdFile, 'utf8');
    expect(content).toContain('Google Antigravity');
    expect(content).not.toContain('Claude Code');
  });

  it('--include skills only does not export agents or commands', async () => {
    const summary = await runExport(
      { tool: 'cursor', out: outDir, agents: null, include: 'skills', dryRun: true },
      { agentsDir, skillsDir, commandsDir },
    );
    expect(summary.agentCount).toBe(0);
    expect(summary.skillCount).toBe(2);
    expect(summary.commandCount).toBe(0);
    expect(summary.files.every((f) => f.type === 'skill')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-agent smoke (uses actual plugins/artibot/agents/) — regression guard
// ---------------------------------------------------------------------------

describe('export-to-tool/real-agents smoke', () => {
  it('collectAgents finds ≥20 agents under plugins/artibot/agents/', async () => {
    const agentsDir = path.join(PLUGIN_ROOT, 'agents');
    const agents = await collectAgents(agentsDir);
    expect(agents.length).toBeGreaterThanOrEqual(20);
    for (const a of agents) {
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  it('runExport dry-run succeeds on all real agents for every tool', async () => {
    const realAgentsDir = path.join(PLUGIN_ROOT, 'agents');
    for (const tool of ['cursor', 'codex', 'opencode', 'antigravity']) {
      const summary = await runExport(
        { tool, out: null, agents: null, dryRun: true },
        { agentsDir: realAgentsDir },
      );
      expect(summary.agentCount).toBeGreaterThanOrEqual(20);
      expect(summary.files.every((f) => f.bytes > 0)).toBe(true);
    }
  });

  it('runExport --include all dry-run succeeds on real plugin', async () => {
    const summary = await runExport(
      { tool: 'codex', out: null, agents: null, include: 'all', dryRun: true },
      {
        agentsDir: path.join(PLUGIN_ROOT, 'agents'),
        skillsDir: path.join(PLUGIN_ROOT, 'skills'),
        commandsDir: path.join(PLUGIN_ROOT, 'commands'),
      },
    );
    expect(summary.agentCount).toBeGreaterThanOrEqual(20);
    expect(summary.skillCount).toBeGreaterThanOrEqual(100);
    expect(summary.commandCount).toBeGreaterThanOrEqual(60);
    expect(summary.files.every((f) => f.bytes > 0)).toBe(true);
  });
});
