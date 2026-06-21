/**
 * Genesis `.claude/` scaffold generator — turns a structured blueprint `spec`
 * (produced by `/go` session 1) into an executable `.claude/` project tree:
 * `CLAUDE.md` + `.claude/{rules,skills,agents,hooks,commands,settings.json}`.
 *
 * Pure generation only — no idea synthesis, no clock-driven content. The caller
 * (command/model) builds the `spec`; this module renders deterministic text and
 * writes it (the IO boundary). Korean-path safe (`path.join` only), atomic
 * (temp sibling + rename, see `_shared.atomicWriteText`).
 *
 * ★ DATA POLICY (code-enforced):
 *   - ZERO network: no fetch / http / https / net imports, no URL coercion.
 *   - Hooks are emitted as `.mjs` Node stubs (Windows-safe), NOT `.sh`. Each
 *     stub reads stdin JSON and writes `{"continue":true}` to stdout with NO
 *     external call — a pure pass-through skeleton for the user to fill in.
 *   - `.mcp.json` is NEVER auto-wired to an external MCP server. If the spec
 *     carries MCP entries (even with URLs), this module emits ONLY a commented
 *     template with an empty `mcpServers:{}` and pushes a warning telling the
 *     user that external MCP requires manual review + allowlist. No URL/endpoint
 *     from the spec is ever written into output. There is no code path that
 *     copies a spec-provided URL into a file.
 *
 * @module lib/genesis/scaffold-gen
 */

import path from 'node:path';
import {
  atomicWriteText,
  cell,
  humanStamp,
  resolveNow,
  slugify,
} from './_shared.js';

/**
 * @typedef {object} RuleSpec
 * @property {string} name - Rule slug/title.
 * @property {string} [content] - Rule body markdown.
 */

/**
 * @typedef {object} SkillSpec
 * @property {string} name - Skill name (becomes `.claude/skills/<slug>/SKILL.md`).
 * @property {string} [description] - Frontmatter description (trigger-rich).
 * @property {string} [body] - Skill body markdown.
 */

/**
 * @typedef {object} AgentSpec
 * @property {string} name - Agent name (becomes `.claude/agents/<slug>.md`).
 * @property {string} [role] - One-line role; seeds the description.
 * @property {string} [body] - Agent body markdown.
 */

/**
 * @typedef {object} HookSpec
 * @property {string} event - Hook event name (e.g. `PreToolUse`, `SessionStart`).
 */

/**
 * @typedef {object} CommandSpec
 * @property {string} name - Command name (becomes `.claude/commands/<slug>.md`).
 * @property {string} [description] - Frontmatter description.
 * @property {string} [body] - Command body markdown.
 */

/**
 * @typedef {object} ScaffoldSpec
 * @property {string} [projectName] - Human project name.
 * @property {string} [domain] - Domain context (drives generated CLAUDE.md).
 * @property {string} [claudeMd] - Explicit CLAUDE.md body (overrides generated).
 * @property {RuleSpec[]} [rules]
 * @property {SkillSpec[]} [skills]
 * @property {AgentSpec[]} [agents]
 * @property {HookSpec[]} [hooks]
 * @property {CommandSpec[]} [commands]
 * @property {object} [settings] - Extra keys merged into `.claude/settings.json`.
 */

/** Known Claude Code hook events; used to normalize/validate the event name. */
const KNOWN_HOOK_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'Notification',
]);

/** Coerce a maybe-array into an array (missing field ⇒ empty, never throws). */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Trim + fall back to a default for a maybe-string. */
function str(value, fallback = '') {
  const s = String(value ?? '').trim();
  return s || fallback;
}

/**
 * Normalize a hook event name to a known event, defaulting to a safe stub event.
 * Matching is case-insensitive against {@link KNOWN_HOOK_EVENTS}.
 * @param {string} event
 * @returns {string}
 */
function normalizeHookEvent(event) {
  const raw = str(event);
  if (!raw) return 'PostToolUse';
  for (const known of KNOWN_HOOK_EVENTS) {
    if (known.toLowerCase() === raw.toLowerCase()) return known;
  }
  // Unknown event: keep a filesystem-safe token but do not invent a URL/handler.
  return raw.replace(/[^A-Za-z0-9_-]+/g, '') || 'PostToolUse';
}

/**
 * Render the project `CLAUDE.md`. Uses `spec.claudeMd` verbatim when provided,
 * otherwise synthesizes a minimal domain-context file. Pure.
 * @param {ScaffoldSpec} spec
 * @returns {string}
 */
export function renderClaudeMd(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  if (str(s.claudeMd)) return `${str(s.claudeMd)}\n`;
  const name = str(s.projectName, '프로젝트');
  const domain = str(s.domain, '(도메인 미지정)');
  const lines = [
    `# ${name}`,
    '',
    '> Genesis 스캐폴드 — 도메인 컨텍스트 (자동 생성). 자유롭게 수정하세요.',
    '',
    '## 도메인',
    '',
    domain,
    '',
    '## 구조',
    '',
    '이 프로젝트는 `.claude/` 하위에 rules · skills · agents · hooks · commands 를',
    '갖춘 실행 가능한 Claude Code 워크스페이스로 부트스트랩되었습니다.',
    '',
    '| 디렉터리 | 책임 |',
    '|---|---|',
    '| `.claude/rules/` | 프로젝트 규칙 (항상 적용) |',
    '| `.claude/skills/` | 자동 트리거 스킬 (frontmatter description 기반) |',
    '| `.claude/agents/` | 위임 가능한 전문 에이전트 |',
    '| `.claude/hooks/` | 이벤트 훅 (`.mjs`, stdin/stdout JSON) |',
    '| `.claude/commands/` | 슬래시 커맨드 |',
    '',
    '## 데이터 정책',
    '',
    '외부 MCP 서버·외부 DB·외부 엔드포인트로의 자동 연결은 없습니다.',
    '`.mcp.json`은 빈 템플릿이며, 외부 연결이 필요하면 수동 검수 후 allowlist 하세요.',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Render a single rule file. Pure.
 * @param {RuleSpec} rule
 * @returns {string}
 */
export function renderRule(rule) {
  const r = rule && typeof rule === 'object' ? rule : {};
  const title = str(r.name, 'rule');
  const body = str(r.content, '> (규칙 본문을 작성하세요.)');
  return `# ${title}\n\n${body}\n`;
}

/**
 * Render a `SKILL.md`. The frontmatter `description` is the load-bearing
 * activation lever — we ensure a trigger-rich, multi-sentence default so the
 * description linter (R1 trigger floor) can pass. Pure.
 * @param {SkillSpec} skill
 * @returns {string}
 */
export function renderSkill(skill) {
  const sk = skill && typeof skill === 'object' ? skill : {};
  const name = slugify(sk.name);
  const human = str(sk.name, name);
  const desc = str(sk.description)
    || `${human} 작업을 돕는 스킬. 관련 요청을 감지하면 자동으로 활성화된다. `
      + `자동 트리거: "${human}", "${human} 해줘", "${human} 만들어", `
      + `"${human} 설정", "do ${human}", "set up ${human}".`;
  const body = str(sk.body, `## ${human}\n\n> (스킬 절차를 작성하세요.)`);
  // YAML block scalar (|) keeps multi-line descriptions intact.
  const fm = [
    '---',
    `name: ${name}`,
    'description: |',
    ...desc.split(/\r?\n/).map((line) => `  ${line}`),
    '---',
  ].join('\n');
  return `${fm}\n\n# ${human}\n\n${body}\n`;
}

/**
 * Render an agent `.md` with frontmatter + role body. Pure.
 * @param {AgentSpec} agent
 * @returns {string}
 */
export function renderAgent(agent) {
  const a = agent && typeof agent === 'object' ? agent : {};
  const name = slugify(a.name);
  const human = str(a.name, name);
  const role = str(a.role, `${human} 전문 에이전트`);
  const desc = `${role}. ${human} 관련 작업에 위임하세요.`;
  const body = str(a.body, `## 역할\n\n${role}\n\n## 작업 절차\n\n> (절차를 작성하세요.)`);
  const fm = [
    '---',
    `name: ${name}`,
    'description: |',
    `  ${desc}`,
    '---',
  ].join('\n');
  return `${fm}\n\n# ${human}\n\n${body}\n`;
}

/**
 * Render a command `.md` with frontmatter. Pure.
 * @param {CommandSpec} command
 * @returns {string}
 */
export function renderCommand(command) {
  const c = command && typeof command === 'object' ? command : {};
  const name = slugify(c.name);
  const human = str(c.name, name);
  const desc = str(c.description, `${human} 커맨드`);
  const body = str(c.body, `## ${human}\n\n> (커맨드 동작을 작성하세요.)`);
  const fm = [
    '---',
    `description: ${cell(desc)}`,
    '---',
  ].join('\n');
  return `${fm}\n\n# /${name}\n\n${body}\n`;
}

/**
 * Render a hook as a `.mjs` Node stub. The stub reads stdin JSON and writes
 * `{"continue":true}` — a pure pass-through with ZERO external calls. Windows
 * safe (no shebang dependency on a POSIX shell; runs via `node`). Pure.
 * @param {string} event - Normalized event name.
 * @returns {string}
 */
export function renderHookStub(event) {
  const ev = normalizeHookEvent(event);
  return [
    '#!/usr/bin/env node',
    '/**',
    ` * ${ev} hook — Genesis scaffold stub.`,
    ' *',
    ' * Reads the Claude Code hook payload from stdin and writes a pass-through',
    ' * decision to stdout. ZERO external calls (DATA POLICY). Fill in your own',
    ' * local logic below; keep all IO inside this project.',
    ' */',
    '',
    "import process from 'node:process';",
    '',
    'async function readStdin() {',
    "  const chunks = [];",
    "  for await (const chunk of process.stdin) chunks.push(chunk);",
    "  const raw = Buffer.concat(chunks).toString('utf-8').trim();",
    '  if (!raw) return {};',
    '  try { return JSON.parse(raw); } catch { return {}; }',
    '}',
    '',
    'async function main() {',
    '  const payload = await readStdin();',
    `  // event: ${ev}`,
    '  // TODO: inspect the payload and implement local-only logic here.',
    '  void payload;',
    "  process.stdout.write(JSON.stringify({ continue: true }) + '\\n');",
    '}',
    '',
    "main().catch(() => {",
    "  process.stdout.write(JSON.stringify({ continue: true }) + '\\n');",
    '});',
    '',
  ].join('\n');
}

/**
 * Build the `.claude/settings.json` object, registering each hook to its `.mjs`
 * stub via a `node` command. Pure — returns a plain object (caller serializes).
 * @param {HookSpec[]} hooks - Hook specs.
 * @param {object} [extra] - Extra keys merged in (spec.settings).
 * @returns {object}
 */
export function buildSettings(hooks, extra) {
  const hookEntries = {};
  for (const h of asArray(hooks)) {
    const ev = normalizeHookEvent(h?.event);
    if (!hookEntries[ev]) hookEntries[ev] = [];
    hookEntries[ev].push({
      hooks: [
        { type: 'command', command: `node .claude/hooks/${ev}.mjs` },
      ],
    });
  }
  const base = { hooks: hookEntries };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    return { ...extra, ...base, hooks: { ...(extra.hooks || {}), ...hookEntries } };
  }
  return base;
}

/**
 * Render the `.mcp.json` template. ★ DATA POLICY: NEVER wires an external MCP
 * server. Always emits an empty `mcpServers:{}` plus an inline note. No spec URL
 * is ever read here — the function takes no URL input by design. Pure.
 * @returns {string}
 */
export function renderMcpTemplate() {
  const obj = {
    _note:
      '외부 MCP는 자동 배선되지 않습니다. 외부 MCP 서버는 수동 검수 + allowlist가 '
      + '필요합니다. 신뢰하는 서버만 mcpServers 아래에 직접 추가하세요.',
    mcpServers: {},
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/**
 * Generate an executable `.claude/` project scaffold from a blueprint `spec`.
 *
 * Writes (under `projectRoot`):
 *   - `CLAUDE.md`
 *   - `.claude/rules/<name>.md` (per rule)
 *   - `.claude/skills/<name>/SKILL.md` (per skill)
 *   - `.claude/agents/<name>.md` (per agent)
 *   - `.claude/hooks/<Event>.mjs` (per hook — `.mjs`, never `.sh`)
 *   - `.claude/commands/<name>.md` (per command)
 *   - `.claude/settings.json` (valid JSON; registers hooks)
 *   - `.claude/.mcp.json` (empty template only — DATA POLICY)
 *
 * Pure generation + local atomic writes. No network. Missing spec fields degrade
 * gracefully to empty (never throws on absent arrays).
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute project root.
 * @param {ScaffoldSpec} args.spec - Blueprint spec.
 * @param {(() => Date)|Date} [args.now] - Injectable clock (deterministic tests).
 * @returns {Promise<{ ok: boolean, written: string[], warnings: string[], error?: string }>}
 */
export async function writeClaudeScaffold({ projectRoot, spec, now } = {}) {
  const written = [];
  const warnings = [];
  try {
    if (!projectRoot) return { ok: false, written, warnings, error: 'projectRoot required' };
    const s = spec && typeof spec === 'object' ? spec : {};
    const when = resolveNow(now);
    const stamp = humanStamp(when);
    const claudeDir = path.join(projectRoot, '.claude');

    /** Write helper that records the path. */
    const write = async (filePath, content) => {
      await atomicWriteText(filePath, content);
      written.push(filePath);
    };

    // 1. CLAUDE.md (root)
    await write(path.join(projectRoot, 'CLAUDE.md'), renderClaudeMd(s));

    // 2. Rules
    const usedRuleSlugs = new Set();
    for (const rule of asArray(s.rules)) {
      let slug = slugify(rule?.name);
      while (usedRuleSlugs.has(slug)) slug = `${slug}-2`;
      usedRuleSlugs.add(slug);
      await write(path.join(claudeDir, 'rules', `${slug}.md`), renderRule(rule));
    }

    // 3. Skills (each in its own directory)
    const usedSkillSlugs = new Set();
    for (const skill of asArray(s.skills)) {
      let slug = slugify(skill?.name);
      while (usedSkillSlugs.has(slug)) slug = `${slug}-2`;
      usedSkillSlugs.add(slug);
      await write(path.join(claudeDir, 'skills', slug, 'SKILL.md'), renderSkill(skill));
    }

    // 4. Agents
    const usedAgentSlugs = new Set();
    for (const agent of asArray(s.agents)) {
      let slug = slugify(agent?.name);
      while (usedAgentSlugs.has(slug)) slug = `${slug}-2`;
      usedAgentSlugs.add(slug);
      await write(path.join(claudeDir, 'agents', `${slug}.md`), renderAgent(agent));
    }

    // 5. Hooks (.mjs — Windows-safe, never .sh)
    const usedHookEvents = new Set();
    for (const hook of asArray(s.hooks)) {
      const ev = normalizeHookEvent(hook?.event);
      if (usedHookEvents.has(ev)) continue; // one stub per event
      usedHookEvents.add(ev);
      await write(path.join(claudeDir, 'hooks', `${ev}.mjs`), renderHookStub(ev));
    }

    // 6. Commands
    const usedCmdSlugs = new Set();
    for (const command of asArray(s.commands)) {
      let slug = slugify(command?.name);
      while (usedCmdSlugs.has(slug)) slug = `${slug}-2`;
      usedCmdSlugs.add(slug);
      await write(path.join(claudeDir, 'commands', `${slug}.md`), renderCommand(command));
    }

    // 7. settings.json (valid JSON, registers hooks)
    const settings = buildSettings(s.hooks, s.settings);
    await write(path.join(claudeDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);

    // 8. .mcp.json — ★ DATA POLICY: empty template only, never external wiring.
    await write(path.join(claudeDir, '.mcp.json'), renderMcpTemplate());
    const hasMcpInSpec = Array.isArray(s.mcp) ? s.mcp.length > 0
      : (s.mcp && typeof s.mcp === 'object' ? Object.keys(s.mcp).length > 0 : false);
    if (hasMcpInSpec) {
      warnings.push(
        '외부 MCP는 자동 배선되지 않았습니다 — `.mcp.json`은 빈 템플릿입니다. '
        + '외부 MCP 서버는 수동 검수 + allowlist가 필요합니다 (DATA POLICY).',
      );
    }

    return { ok: true, written, warnings, stamp };
  } catch (err) {
    return { ok: false, written, warnings, error: err?.message || String(err) };
  }
}
