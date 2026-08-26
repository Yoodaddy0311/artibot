/**
 * 프론트매터 도구 선언 파서 + 하네스 도구명 정본.
 *
 * ── 왜 별도 모듈인가 ────────────────────────────────────────────────────────
 * 원래 이 코드는 `frontmatter-tool-names.test.js` 안에 있었다. 두 번째 게이트
 * (`command-body-tool-parity.test.js`)가 **같은 파서와 같은 도구명 정본**을 필요로
 * 하는데, 테스트 파일에서 테스트 파일을 import 하면 vitest 가 그쪽 `describe` 를
 * **호출한 쪽 스위트에 다시 등록**해 같은 테스트가 두 번 돈다. 그래서 술어만
 * 여기로 빼고 두 게이트가 이 모듈을 함께 import 한다 (사본 금지 — 한쪽만
 * 조여지면 다른 쪽이 조용히 느슨해진다).
 *
 * 파일명이 `*.test.js` 가 아니므로 vitest `include`
 * (`tests/**\/*.test.{js,mjs}` — `vitest.config.js:89`) 에 걸리지 않는다.
 * 즉 이 파일 자체는 테스트가 아니라 라이브러리다.
 *
 * @module tests/firewall/frontmatter-tools
 */

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
export const KNOWN_TOOL_NAMES = new Set([
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
  'ListAgents', // 리드 세션 도구 목록에 실재(2026-08-26 리더 실측 — 21:29 실호출, 피어 세션 4행 출력), 서브에이전트 컨텍스트에는 부재. commands/split.md 가 선언.
]);

/**
 * 하네스에서 사라졌거나 개명된 이름 → 현행 대체.
 *
 * **예외 목록이 아니다.** 이 이름들은 `KNOWN_TOOL_NAMES` 에 없으므로 그대로
 * 실패한다. 이 표가 하는 일은 실패 메시지에 "무엇으로 바꿔야 하는가"를 붙이는
 * 것뿐이다. 여기에 이름을 추가해도 게이트는 통과되지 않는다.
 */
export const STALE_TOOL_NAMES = new Map([
  ['TeamCreate', '삭제 — 세션은 암묵적 단일 팀이다. Agent(name=…) 로 팀원을 스폰하라'],
  ['TeamDelete', '삭제 — SendMessage 로 shutdown_request 를 보내라'],
  ['TodoWrite', 'TaskCreate / TaskUpdate / TaskList'],
  ['Task', 'Agent (개명). subagent_type 인자는 그대로다'],
]);

/**
 * 문서를 프론트매터 블록과 본문으로 가른다.
 *
 * `bodyOffset` 은 본문 첫 줄이 **파일 기준 몇 번째 줄인가**(1-based)다. 본문
 * 상대 줄번호로 위반을 보고하면 사람이 파일에서 찾지 못한다 — 실제로 이 게이트를
 * 만들 때 census 초안이 sc.md 의 위반을 `L126` 으로 냈는데 파일에서는 `L131`
 * 이었다(프론트매터 5줄 차이). 그 오차를 여기서 한 번에 없앤다.
 *
 * @param {string} text
 * @returns {{ block: string, body: string, bodyOffset: number } | null}
 */
export function splitFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const consumed = match[0];
  return {
    block: match[1],
    body: text.slice(consumed.length),
    // consumed 안의 개행 수 = 본문 앞에 있는 줄 수. 본문 첫 줄은 그 다음 줄이다.
    bodyOffset: consumed.split('\n').length,
  };
}

/**
 * 프론트매터 블록만 떼어낸다. 없으면 null (호출부가 RED 로 처리).
 * @param {string} text
 * @returns {string | null}
 */
export function frontmatter(text) {
  const split = splitFrontmatter(text);
  return split ? split.block : null;
}

/**
 * YAML 스칼라에서 주석과 따옴표를 벗긴다.
 *
 * `agents/orchestrator.md` 처럼 항목 뒤에 `# DM (type:"message")` 가 붙는
 * 형태가 실재한다. 벗기지 않으면 도구명이 주석까지 포함한 문자열이 되어
 * 엉뚱한 이름으로 RED 가 난다.
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripComment(raw) {
  return raw.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
}

/**
 * 인라인 flow 시퀀스 `[A, B, C]` 를 항목 배열로. flow 가 아니면 null.
 * @param {string} value
 * @returns {string[] | null}
 */
export function parseFlowSequence(value) {
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
