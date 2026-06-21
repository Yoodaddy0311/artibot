/**
 * Tests for the genesis `.claude/` scaffold generator (writeClaudeScaffold +
 * pure renderers). Mirrors the genesis test house style: mkdtemp Korean-path
 * tmp root, FIXED `now`, afterEach rm.
 *
 * Verification focus:
 *   - Expected file tree exists (CLAUDE.md, rules, skills/SKILL.md, agents,
 *     hooks `.mjs`, commands, settings.json).
 *   - Hooks are `.mjs`, NOT `.sh`.
 *   - settings.json is valid JSON.
 *   - DATA POLICY: spec-provided external MCP URLs never reach `.mcp.json`
 *     (zero external URLs) + a warning is emitted.
 *   - Missing spec fields degrade gracefully (no throw).
 *
 * @module tests/genesis/scaffold-gen
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSettings,
  renderClaudeMd,
  renderHookStub,
  renderMcpTemplate,
  renderSkill,
  writeClaudeScaffold,
} from '../../lib/genesis/scaffold-gen.js';

const FIXED = new Date(2026, 5, 21, 9, 5); // 2026-06-21 09:05 local
const fixedNow = () => FIXED;

// Korean-path-safe temp root (non-ASCII segment mirrors production paths).
function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), '제네시스-scaffold-'));
}

const SPEC = {
  projectName: '광고 온톨로지 OS',
  domain: '광고 캠페인 도메인 지식을 온톨로지로 관리하는 시스템',
  rules: [
    { name: 'Data Policy', content: '외부 DB로 데이터 전송 금지.' },
    { name: '코드 스타일', content: 'ESM only.' },
  ],
  skills: [
    { name: 'ontology-edit', description: '온톨로지 편집 스킬. 자동 트리거: "온톨로지 수정", "edit ontology".' },
    { name: '리포트 생성' },
  ],
  agents: [
    { name: 'ontology-architect', role: '온톨로지 구조 설계 전문가' },
    { name: '검수자' },
  ],
  hooks: [{ event: 'PostToolUse' }, { event: 'SessionStart' }],
  commands: [
    { name: 'build-ontology', description: '온톨로지 빌드' },
    { name: '검수' },
  ],
};

describe('scaffold-gen / pure renderers', () => {
  it('renderClaudeMd uses spec.claudeMd verbatim when provided', () => {
    const md = renderClaudeMd({ claudeMd: '# Custom\n\nbody' });
    expect(md).toContain('# Custom');
    expect(md).toContain('body');
  });

  it('renderClaudeMd synthesizes domain context when no claudeMd', () => {
    const md = renderClaudeMd({ projectName: 'P', domain: 'D' });
    expect(md).toContain('# P');
    expect(md).toContain('D');
    expect(md).toContain('.claude/');
  });

  it('renderSkill emits frontmatter name + trigger-rich description', () => {
    const md = renderSkill({ name: 'My Skill' });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('name: my-skill');
    expect(md).toContain('description: |');
    expect(md).toContain('자동 트리거'); // default description carries triggers
  });

  it('renderHookStub emits a .mjs Node stub with stdin read + continue:true', () => {
    const stub = renderHookStub('PreToolUse');
    expect(stub).toContain('process.stdin');
    expect(stub).toContain('continue: true');
    expect(stub).not.toMatch(/fetch\(|http\.request|https\.request/);
  });

  it('renderMcpTemplate is empty (no external server) and valid JSON', () => {
    const parsed = JSON.parse(renderMcpTemplate());
    expect(parsed.mcpServers).toEqual({});
  });

  it('buildSettings registers each hook event to its .mjs stub', () => {
    const settings = buildSettings([{ event: 'PostToolUse' }]);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('node .claude/hooks/PostToolUse.mjs');
  });
});

describe('scaffold-gen / writeClaudeScaffold', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes the full expected .claude/ file tree', async () => {
    const res = await writeClaudeScaffold({ projectRoot: root, spec: SPEC, now: fixedNow });
    expect(res.ok).toBe(true);

    const expectPath = (...p) => expect(existsSync(path.join(root, ...p))).toBe(true);
    expectPath('CLAUDE.md');
    expectPath('.claude', 'rules', 'data-policy.md');
    expectPath('.claude', 'skills', 'ontology-edit', 'SKILL.md');
    expectPath('.claude', 'agents', 'ontology-architect.md');
    expectPath('.claude', 'hooks', 'PostToolUse.mjs');
    expectPath('.claude', 'hooks', 'SessionStart.mjs');
    expectPath('.claude', 'commands', 'build-ontology.md');
    expectPath('.claude', 'settings.json');

    // every written path is reported
    expect(res.written.some((w) => w.endsWith('CLAUDE.md'))).toBe(true);
    expect(res.written.some((w) => w.endsWith(path.join('skills', 'ontology-edit', 'SKILL.md')))).toBe(true);
  });

  it('emits hooks as .mjs, never .sh', async () => {
    await writeClaudeScaffold({ projectRoot: root, spec: SPEC, now: fixedNow });
    const hookDir = path.join(root, '.claude', 'hooks');
    const files = readdirSync(hookDir);
    expect(files).toContain('PostToolUse.mjs');
    expect(files.every((f) => f.endsWith('.mjs'))).toBe(true);
    expect(files.some((f) => f.endsWith('.sh'))).toBe(false);
  });

  it('settings.json is valid JSON and registers hooks', async () => {
    await writeClaudeScaffold({ projectRoot: root, spec: SPEC, now: fixedNow });
    const raw = readFileSync(path.join(root, '.claude', 'settings.json'), 'utf-8');
    const parsed = JSON.parse(raw); // throws if invalid → test fails
    expect(parsed.hooks.PostToolUse).toBeDefined();
    expect(parsed.hooks.SessionStart).toBeDefined();
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toContain('.claude/hooks/PostToolUse.mjs');
  });

  it('SKILL.md frontmatter carries a trigger-rich description (lint-passable)', async () => {
    await writeClaudeScaffold({ projectRoot: root, spec: SPEC, now: fixedNow });
    const skillMd = readFileSync(
      path.join(root, '.claude', 'skills', '리포트-생성', 'SKILL.md'),
      'utf-8',
    );
    expect(skillMd).toContain('description: |');
    expect(skillMd).toContain('자동 트리거');
  });

  describe('DATA POLICY gate', () => {
    it('never writes external MCP URLs into .mcp.json and warns', async () => {
      const evilSpec = {
        ...SPEC,
        mcp: [
          { name: 'evil', url: 'https://evil.example.com/mcp' },
          { name: 'leak', endpoint: 'http://10.0.0.1:9999/sse' },
        ],
      };
      const res = await writeClaudeScaffold({ projectRoot: root, spec: evilSpec, now: fixedNow });
      expect(res.ok).toBe(true);

      const mcpPath = path.join(root, '.claude', '.mcp.json');
      expect(existsSync(mcpPath)).toBe(true);
      const raw = readFileSync(mcpPath, 'utf-8');

      // ZERO external URLs / endpoints from the spec leaked through.
      expect(raw).not.toContain('evil.example.com');
      expect(raw).not.toContain('10.0.0.1');
      expect(raw).not.toContain('http://');
      expect(raw).not.toContain('https://');

      // empty mcpServers + a warning surfaced.
      const parsed = JSON.parse(raw);
      expect(parsed.mcpServers).toEqual({});
      expect(res.warnings.some((w) => /MCP/.test(w))).toBe(true);
    });

    it('whole scaffold output contains no spec-provided external URL', async () => {
      const evilSpec = { ...SPEC, mcp: { x: { url: 'https://evil.example.com/mcp' } } };
      await writeClaudeScaffold({ projectRoot: root, spec: evilSpec, now: fixedNow });
      // Walk every generated file; none may contain the injected host.
      const stack = [root];
      const seen = [];
      while (stack.length) {
        const dir = stack.pop();
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else seen.push(readFileSync(full, 'utf-8'));
        }
      }
      expect(seen.join('\n')).not.toContain('evil.example.com');
    });
  });

  describe('graceful degradation', () => {
    it('does not throw on an empty spec', async () => {
      const res = await writeClaudeScaffold({ projectRoot: root, spec: {}, now: fixedNow });
      expect(res.ok).toBe(true);
      expect(existsSync(path.join(root, 'CLAUDE.md'))).toBe(true);
      expect(existsSync(path.join(root, '.claude', 'settings.json'))).toBe(true);
    });

    it('does not throw on undefined spec', async () => {
      const res = await writeClaudeScaffold({ projectRoot: root, now: fixedNow });
      expect(res.ok).toBe(true);
    });

    it('returns {ok:false} when projectRoot missing', async () => {
      const res = await writeClaudeScaffold({ spec: SPEC });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/projectRoot/);
      expect(res.written).toEqual([]);
    });
  });
});
