/**
 * 검사 목적: `commands/*.md` 의 `allowed-tools:` 와 `agents/*.md` 의 `tools:` 가
 * 선언하는 도구 이름이 **하네스에 실재하는 이름인가**.
 *
 * 하네스가 도구를 개명·폐지해도 프론트매터는 따라가지 않는다. 그러면 선언은
 * 조용히 유령을 가리키고, 아무 것도 RED 가 되지 않는다. 실측 2026-08-15 기준
 * `scripts/ci/validate-commands.js#REQUIRED_FIELDS` 는 `description` 과
 * `argument-hint` 만 보고, `scripts/ci/` 전역에 `allowed-tools` 문자열이 0건이다.
 * 이 파일이 그 구멍을 닫는다.
 *
 * ── 형태 (rules §10) ────────────────────────────────────────────────────────
 * 스크립트형이 아니라 `tests/firewall/` vitest 다. 선례: `check-unused-ratchet`
 * 이 `node_modules` 부재 시 자기 기준선을 파괴하며 통과한 적이 있다. 파일이
 * 없으면 red = fail-closed 인 형태만 쓴다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ──────────────────
 *
 *  1. **라이브 제공 여부는 못 본다.** 이건 "CI 가 아는 목록 밖 이름"만 잡는
 *     오탈자/구명칭 검출기다. 목록에 있는 이름이 실제 세션에서 제공되는지는
 *     검증할 수 없다 — 하네스 인벤토리는 세션·모델·MCP 구성에 종속이라 CI 가
 *     알 방법이 없다. `KNOWN_TOOL_NAMES` 는 **수동 사본**이고 다음 개명에 다시
 *     낡는다. 재확인 방법은 그 상수 주석에 있다.
 *  2. **본문 산문의 죽은 호출은 못 본다.** 프론트매터만 스캔한다. 선언을
 *     지워도 본문이 여전히 그 도구를 호출하라고 지시할 수 있고, 그때 게이트는
 *     green 인데 실동작은 더 나빠진다. 본문 정합은 사람이 봐야 한다.
 *  3. **파서가 읽지 못하는 표기법.** 읽지 못하면 `null` 이 아니라 **RED** 다
 *     (아래 "파싱 실패는 RED" 참조). 표기법을 넓히면 이 문단도 같이 고쳐라.
 *  4. **`mcp__*` · 와일드카드 · 괄호 taxonomy 는 검사 대상이 아니다.**
 *     `mcp__*` 는 세션별 MCP 서버 구성에 따라 달라지고, `*` 는 "All tools"
 *     표기이며, `Task(Explore)` 류는 도구명+인자 taxonomy 라 괄호 앞 기본명만
 *     본다. 즉 괄호 **안**의 서브에이전트명 오탈자는 이 게이트가 못 잡는다.
 *  5. **allowlist 가 실제 하네스와 함께 틀릴 수 있다.** 목록과 리포가 사이좋게
 *     같이 낡으면 전부 green 이다. 자기검증 describe 는 파서가 헛돌지 않는지만
 *     보증하지, 목록이 옳은지는 보증하지 못한다.
 *
 * @module tests/firewall/frontmatter-tool-names
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');
const COMMANDS_DIR = join(PLUGIN_ROOT, 'commands');
const AGENTS_DIR = join(PLUGIN_ROOT, 'agents');

/**
 * 하네스가 제공하는 도구 이름 정본.
 *
 * **원격/하네스 상태의 수동 사본이다** — `protected_refs`·`REQUIRED_CONTEXTS` 와
 * 같은 성격이고, 같은 방식으로 낡는다.
 *
 * 재확인 방법:
 *   Claude Code 세션에서 `ToolSearch("select:<name>")` 로 개별 조회하거나,
 *   세션 시작 시 로드된 도구 목록 + deferred 목록을 대조한다.
 *   최종 확인 2026-08-15 (리더 세션 + 본 세션 ToolSearch 2중).
 *
 * **allowlist 인 이유**(rules §8): 금지 목록은 미래 항목에 fail-open 이다.
 * 새 도구가 하네스에 추가되면 이 게이트는 RED 가 되고, 정본에 한 줄 추가하는
 * 것이 정상 워크플로다. 그 RED 는 결함이 아니라 설계다.
 */
const KNOWN_TOOL_NAMES = new Set([
  // 본 세션에서 로드 상태로 직접 관측.
  'Agent',
  'Artifact',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'PowerShell',
  'Read',
  'Skill',
  'ToolSearch',
  'Write',
  // 본 세션에서 deferred 목록으로 직접 관측.
  'CronCreate',
  'CronDelete',
  'CronList',
  'EndConversation',
  'EnterWorktree',
  'ExitWorktree',
  'Monitor',
  'NotebookEdit',
  'SendMessage',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'WebFetch',
  'WebSearch',
  // 리드 세션 실측 2026-08-15. 서브에이전트 세션에는 노출되지 않아 이 파일을 쓴
  // 세션에서는 관측되지 않았다 — 부재가 곧 폐지가 아닌 사례이며, 그래서 등급을
  // 나눠 적는다. 목록에서 빼려면 **먼저 리드 세션에서 재확인**하라.
  'AskUserQuestion', // 리드 세션에서 2회 실호출 성공. commands/go.md 가 선언.
  'ExitPlanMode', // 리드 세션 deferred 도구 목록에 실재.
  'Workflow', // 리드 세션 최상위 도구로 스키마까지 로드됨. commands/dynamic.md 가 선언.
]);

/**
 * 하네스에서 사라졌거나 개명된 이름 → 현행 대체.
 *
 * **예외 목록이 아니다.** 이 이름들은 `KNOWN_TOOL_NAMES` 에 없으므로 그대로
 * 실패한다. 이 표가 하는 일은 실패 메시지에 "무엇으로 바꿔야 하는가"를 붙이는
 * 것뿐이다. 여기에 이름을 추가해도 게이트는 통과되지 않는다.
 */
const STALE_TOOL_NAMES = new Map([
  ['TeamCreate', '삭제 — 세션은 암묵적 단일 팀이다. Agent(name=…) 로 팀원을 스폰하라'],
  ['TeamDelete', '삭제 — SendMessage 로 shutdown_request 를 보내라'],
  ['TodoWrite', 'TaskCreate / TaskUpdate / TaskList'],
  ['Task', 'Agent (개명). subagent_type 인자는 그대로다'],
]);

/**
 * 프론트매터 블록만 떼어낸다. 없으면 null (호출부가 RED 로 처리).
 * @param {string} text
 * @returns {string | null}
 */
function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

/**
 * YAML 스칼라에서 주석과 따옴표를 벗긴다.
 *
 * `agents/orchestrator.md:28` 처럼 항목 뒤에 `# DM (type:"message")` 가 붙는
 * 형태가 실재한다. 벗기지 않으면 도구명이 주석까지 포함한 문자열이 되어
 * 엉뚱한 이름으로 RED 가 난다.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripComment(raw) {
  return raw.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
}

/**
 * 인라인 flow 시퀀스 `[A, B, C]` 를 항목 배열로. flow 가 아니면 null.
 * @param {string} value
 * @returns {string[] | null}
 */
function parseFlowSequence(value) {
  const trimmed = value.trim();
  if (!/^\[.*\]$/s.test(trimmed)) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map(stripComment).filter((s) => s !== '');
}

/**
 * `commands/*.md` 의 `allowed-tools:` 를 읽는다.
 *
 * @param {string} text
 * @returns {{ ok: true, tools: string[] } | { ok: false, reason: string }}
 */
export function parseCommandTools(text) {
  const block = frontmatter(text);
  if (block === null) return { ok: false, reason: '프론트매터 블록이 없다' };

  const line = block.split(/\r?\n/).find((l) => /^allowed-tools:/.test(l));
  if (line === undefined) return { ok: false, reason: 'allowed-tools 키가 없다' };

  const parsed = parseFlowSequence(line.replace(/^allowed-tools:/, ''));
  if (parsed === null) {
    return { ok: false, reason: `allowed-tools 가 인라인 flow 형태가 아니다: ${line}` };
  }
  return { ok: true, tools: parsed };
}

/**
 * `agents/*.md` 의 `tools:` 를 읽는다. 인라인 flow 와 블록 시퀀스 양쪽.
 *
 * 블록 시퀀스는 `- name` 행만 항목으로 친다. 들여쓴 주석 행(`#` 로 시작)과
 * 앞 항목의 주석이 이어지는 행은 건너뛰고, 들여쓰기가 끝나면 블록도 끝난다.
 *
 * @param {string} text
 * @returns {{ ok: true, tools: string[] } | { ok: false, reason: string }}
 */
export function parseAgentTools(text) {
  const block = frontmatter(text);
  if (block === null) return { ok: false, reason: '프론트매터 블록이 없다' };

  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((l) => /^tools:/.test(l));
  if (start === -1) return { ok: false, reason: 'tools 키가 없다' };

  const inline = lines[start].replace(/^tools:/, '').trim();
  if (inline !== '') {
    const flow = parseFlowSequence(inline);
    if (flow !== null) return { ok: true, tools: flow };
    // 인라인인데 flow 가 아니면 쉼표 구분 스칼라로 본다.
    return { ok: true, tools: inline.split(',').map(stripComment).filter((s) => s !== '') };
  }

  const tools = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) break; // 들여쓰기 종료 = 다음 키
    if (/^\s*#/.test(line)) continue; // 주석 전용 행
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item) {
      const name = stripComment(item[1]);
      if (name !== '') tools.push(name);
      continue;
    }
    // `- name` 도 아니고 주석도 아닌 들여쓴 행은 앞 항목 주석의 연속으로 본다.
    if (/^\s+#/.test(line)) continue;
    return { ok: false, reason: `tools 블록에서 읽지 못한 행: ${JSON.stringify(line)}` };
  }
  return { ok: true, tools };
}

/**
 * 선언 항목 하나를 검사 대상 기본명으로 정규화한다.
 *
 * @param {string} declared
 * @returns {{ skip: true } | { skip: false, base: string }}
 */
export function normalizeToolName(declared) {
  const name = declared.trim();
  if (name === '' || name === '*') return { skip: true }; // "All tools" 표기
  if (name.startsWith('mcp__')) return { skip: true }; // 세션별 MCP 구성 종속
  const base = name.replace(/\(.*$/, '').trim(); // Task(Explore) → Task
  if (base === '') return { skip: true };
  return { skip: false, base };
}

/** `.md` 파일 목록. INDEX.md 는 자동생성 색인이라 에이전트가 아니다. */
function agentFiles() {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== 'INDEX.md');
}

function commandFiles() {
  return readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));
}

/**
 * 전 파일을 훑어 allowlist 밖 이름을 모은다.
 *
 * @param {Set<string>} allowlist 뮤테이션 테스트가 주입할 수 있게 인자로 받는다.
 * @returns {{ violations: Array<{file: string, name: string}>, unparsed: Array<{file: string, reason: string}>, scanned: number }}
 */
export function scanDeclaredToolNames(allowlist = KNOWN_TOOL_NAMES) {
  const violations = [];
  const unparsed = [];
  let scanned = 0;

  const sources = [
    ...commandFiles().map((f) => ({ rel: `commands/${f}`, abs: join(COMMANDS_DIR, f), parse: parseCommandTools })),
    ...agentFiles().map((f) => ({ rel: `agents/${f}`, abs: join(AGENTS_DIR, f), parse: parseAgentTools })),
  ];

  for (const source of sources) {
    scanned += 1;
    const result = source.parse(readFileSync(source.abs, 'utf-8'));
    if (!result.ok) {
      unparsed.push({ file: source.rel, reason: result.reason });
      continue;
    }
    for (const declared of result.tools) {
      const normalized = normalizeToolName(declared);
      if (normalized.skip) continue;
      if (!allowlist.has(normalized.base)) {
        violations.push({ file: source.rel, name: normalized.base });
      }
    }
  }

  return { violations, unparsed, scanned };
}

/** 위반 목록을 사람이 고칠 수 있는 형태로. */
function formatViolations(violations) {
  const byName = new Map();
  for (const v of violations) {
    if (!byName.has(v.name)) byName.set(v.name, []);
    byName.get(v.name).push(v.file);
  }
  return [...byName.entries()]
    .map(([name, files]) => {
      const fix = STALE_TOOL_NAMES.get(name);
      const head = fix ? `${name} → ${fix}` : `${name} (알려진 도구 목록에 없다 — 오탈자이거나 하네스 개명이다)`;
      return `  ${head}\n${files.map((f) => `      ${f}`).join('\n')}`;
    })
    .join('\n');
}

describe('프론트매터 도구명 — 파싱 가능성', () => {
  // 파싱 실패는 null 이 아니라 RED 다. lockstep 게이트가 "못 읽음"과 "목록 없음"을
  // 구별하지 못해 노출을 남긴 선례를 반복하지 않는다.
  it('모든 커맨드가 allowed-tools 를 파싱 가능한 형태로 선언한다', () => {
    const failures = commandFiles()
      .map((f) => ({ f, r: parseCommandTools(readFileSync(join(COMMANDS_DIR, f), 'utf-8')) }))
      .filter((x) => !x.r.ok)
      .map((x) => `commands/${x.f}: ${x.r.reason}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('모든 에이전트가 tools 를 파싱 가능한 형태로 선언한다', () => {
    const failures = agentFiles()
      .map((f) => ({ f, r: parseAgentTools(readFileSync(join(AGENTS_DIR, f), 'utf-8')) }))
      .filter((x) => !x.r.ok)
      .map((x) => `agents/${x.f}: ${x.r.reason}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('스코프가 커맨드와 에이전트 양쪽을 덮는다', () => {
    // 분모가 줄면(디렉터리 오타, 필터 실수) 게이트가 조용히 아무것도 안 보게 된다.
    const { scanned } = scanDeclaredToolNames();
    expect(commandFiles().length).toBeGreaterThan(70);
    expect(agentFiles().length).toBeGreaterThan(20);
    expect(scanned).toBe(commandFiles().length + agentFiles().length);
  });
});

describe('프론트매터 도구명 — 실재 검증', () => {
  it('선언된 모든 도구명이 알려진 하네스 도구다', () => {
    const { violations } = scanDeclaredToolNames();
    expect(violations, `알 수 없는 도구명:\n${formatViolations(violations)}`).toEqual([]);
  });
});

describe('스캐너 자기검증 — 파서', () => {
  it('인라인 flow 를 읽는다', () => {
    expect(parseCommandTools('---\nallowed-tools: [Read, Glob, Bash]\n---\nbody')).toEqual({
      ok: true,
      tools: ['Read', 'Glob', 'Bash'],
    });
  });

  it('블록 시퀀스를 읽는다', () => {
    expect(parseAgentTools('---\ntools:\n  - Read\n  - Grep\nmodel: opus\n---\nbody')).toEqual({
      ok: true,
      tools: ['Read', 'Grep'],
    });
  });

  it('항목 뒤 주석과 이어지는 주석 행을 벗긴다', () => {
    // agents/orchestrator.md 에 실재하는 형태. 안 벗기면 도구명이 주석을 머금는다.
    const text = ['---', 'tools:', '  # --- Communication ---', '  - SendMessage   # DM (type:"message")', '                  # shutdown', '  - Read', '---', 'body'].join('\n');
    expect(parseAgentTools(text)).toEqual({ ok: true, tools: ['SendMessage', 'Read'] });
  });

  it('괄호 한정자는 기본명만 본다', () => {
    expect(normalizeToolName('Task(Explore)')).toEqual({ skip: false, base: 'Task' });
    expect(normalizeToolName('Bash(git:*)')).toEqual({ skip: false, base: 'Bash' });
  });

  it('mcp__ 접두사와 와일드카드는 건너뛴다', () => {
    expect(normalizeToolName('mcp__pencil__batch_get')).toEqual({ skip: true });
    expect(normalizeToolName('*')).toEqual({ skip: true });
  });

  it('프론트매터가 없거나 키가 없으면 ok:false 다 (조용한 통과 아님)', () => {
    expect(parseCommandTools('# 제목만 있는 문서').ok).toBe(false);
    expect(parseCommandTools('---\ndescription: x\n---\n').ok).toBe(false);
    expect(parseAgentTools('---\nname: x\n---\n').ok).toBe(false);
  });

  it('읽지 못한 표기법은 ok:false 다', () => {
    // 블록도 flow 도 아닌 형태를 통과시키면 그 파일은 스캔에서 통째로 빠진다.
    expect(parseCommandTools('---\nallowed-tools: Read, Glob\n---\n').ok).toBe(false);
  });
});

describe('스캐너 자기검증 — 게이트가 헛돌지 않는다', () => {
  it('allowlist 를 축소하면 그 이름이 위반으로 잡힌다', () => {
    // 뮤테이션. 이게 RED 를 못 내면 위 "실재 검증" 이 항상 통과하는 헛돌이라는 뜻이다.
    //
    // 기준선과의 **차분**으로 본다. 절대값으로 보면 아직 남아 있는 다른 위반이
    // 섞여 들어와, 이 테스트가 실제로 무엇을 증명하는지 흐려진다.
    const baseline = scanDeclaredToolNames().violations.length;
    const shrunk = new Set(KNOWN_TOOL_NAMES);
    shrunk.delete('Read');
    const { violations } = scanDeclaredToolNames(shrunk);

    const added = violations.filter((v) => v.name === 'Read');
    expect(added.length).toBeGreaterThan(0);
    expect(violations.length).toBe(baseline + added.length);
  });

  it('빈 allowlist 면 거의 모든 파일이 위반이다', () => {
    const { violations } = scanDeclaredToolNames(new Set());
    expect(violations.length).toBeGreaterThan(100);
  });

  it('STALE 표는 예외 목록이 아니다 — 거기 있는 이름도 allowlist 에 없으면 실패한다', () => {
    // 이 표에 이름을 추가해 게이트를 통과시키는 편집을 막는다.
    for (const stale of STALE_TOOL_NAMES.keys()) {
      expect(KNOWN_TOOL_NAMES.has(stale), `${stale} 이 allowlist 에 들어가 있다`).toBe(false);
    }
  });
});
