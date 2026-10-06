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
 *     green 인데 실동작은 더 나빠진다.
 *     → **이 구멍은 `command-body-tool-parity.test.js` 가 닫았다**(2026-08-16).
 *     그쪽은 반대 방향 — 본문이 `Name(` 로 호출하는데 `allowed-tools` 에 없는
 *     경우 — 을 본다. 다만 **`agents/*.md` 본문은 여전히 아무도 안 본다**:
 *     그 게이트도 `commands/` 만 덮는다. 여기서 green 인 것을 "본문도 정합"의
 *     근거로 쓰지 마라.
 *  3. **파서가 읽지 못하는 표기법.** 읽지 못하면 `null` 이 아니라 **RED** 다
 *     (아래 "파싱 실패는 RED" 참조). 표기법을 넓히면 이 문단도 같이 고쳐라.
 *  4. **`mcp__*` · 와일드카드 · 괄호 taxonomy 는 검사 대상이 아니다.**
 *     `mcp__*` 는 세션별 MCP 서버 구성에 따라 달라지고, `*` 는 "All tools"
 *     표기이며, `Task(Explore)` 류는 도구명+인자 taxonomy 라 괄호 앞 기본명만
 *     본다. 즉 괄호 **안**의 서브에이전트명 오탈자는 이 게이트가 못 잡는다.
 *  5. **allowlist 가 실제 하네스와 함께 틀릴 수 있다.** 목록과 리포가 사이좋게
 *     같이 낡으면 전부 green 이다. 자기검증 describe 는 파서가 헛돌지 않는지만
 *     보증하지, 목록이 옳은지는 보증하지 못한다.
 *  6. **`commands/` 와 `agents/` 밖은 통째로 스코프 밖이다.** `lib/` · `scripts/`
 *     의 코드 상수, 훅이 주입하는 지시 문자열, 문서 산문은 한 줄도 보지 않는다.
 *     2026-08-15 전역 census 실측: 프론트매터가 전부 green 인 상태에서 실행 경로에
 *     유령 이름이 남아 있었다 — `scripts/hooks/auto-team-trigger.js` 가 모델에게
 *     `TeamCreate` 호출을 지시했고, `lib/runtime/middleware/subagents.js` 의
 *     `DEFAULT_POLICIES` 가 `artibot.config.json#/team/delegationModeSelection`
 *     와 어긋나 있었다. **이 게이트의 green 을 "리포에 유령 이름이 없다"의 근거로
 *     쓰지 마라.** 그 주장을 하려면 `--include` 없는 전역 grep 이 필요하다.
 *  7. **엄격 방언 패스(`scanStrictAgentDialect`)가 못 보는 것** (lane 1A, 2026-10-07):
 *     - 호스트의 실제 분할 규칙. 근거는 n=5 관측("첫 `---` 에서 닫힌다")뿐이고, `---` 없는
 *       주석과 비호스트 키를 호스트가 어떻게 다루는지는 미확인이다(W0 프로브 P0a). 그래서
 *       이 패스는 호스트 모델이 아니라 **더 엄격한 문법**(`checkStrictAgentFrontmatter`)을
 *       기준으로 삼고, 주석은 `---` 가 없어도 오류로 본다.
 *     - `commands/*.md` 프론트매터. 80파일 census(2026-10-07 01:23): 주석 0 · `---` 0 이라
 *       주석 규칙만으로는 지금도 통과하지만, `go.md` 가 `description: >`(접힌 스칼라)를 써서
 *       문법 4종 전체를 강제하면 1파일이 RED 다. 범위를 에이전트로 한정한 이유다.
 *     - `artibot-cowork` 에이전트 12파일. 같은 결함 상태라 `PLUGIN_ROOTS` 의 `strict:false`
 *       와 만료일로 면제했다. 도구명 스캔은 이 면제와 무관하게 12파일을 계속 훑는다.
 *     - 본문. 닫는 `---` 아래는 보지 않는다.
 *     - 키의 **의미**. 문법만 맞으면 `maxTurns` 같은 키가 다시 들어와도 통과한다. 호스트가
 *       그 키를 적용하기 시작하는 것은 이 패스가 아니라 오너 결정 사항이다.
 *
 * @module tests/firewall/frontmatter-tool-names
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  KNOWN_TOOL_NAMES,
  normalizeToolName,
  parseAgentTools,
  parseCommandTools,
  STALE_TOOL_NAMES,
} from './frontmatter-tools.js';
// 엄격 방언 오라클은 CI 스크립트(`validate-agents.js`)와 **같은 함수**를 쓴다. 사본을 두면
// 한쪽만 조여지는 순간 둘이 어긋난다 — 이 파일이 만들어진 이유와 같다.
import { checkStrictAgentFrontmatter, STRICT_AGENT_RULE_HINTS } from '../../scripts/ci/ci-utils.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 파서와 도구명 정본은 `frontmatter-tools.js` 로 옮겼다. `command-body-tool-parity`
// 게이트가 같은 술어를 필요로 하는데, 테스트 파일끼리 import 하면 vitest 가 이
// 파일의 describe 를 그쪽 스위트에도 등록해 같은 테스트가 두 번 돈다.
// 하위 호환을 위해 재수출한다 — 기존 인용(`#KNOWN_TOOL_NAMES` 등)이 계속 유효하다.
export {
  KNOWN_TOOL_NAMES,
  STALE_TOOL_NAMES,
  normalizeToolName,
  parseAgentTools,
  parseCommandTools,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
/** `plugins/` — 이 리포가 출하하는 모든 플러그인의 부모. */
const PLUGINS_DIR = join(__dirname, '..', '..', '..');

/**
 * 검사 대상 플러그인 루트.
 *
 * **cowork 를 포함하는 이유**: `artibot-cowork` 는 artibot 의 미러가 아니라
 * 루트 `.claude-plugin/marketplace.json` 에 자기 엔트리를 가진 **독립 출하
 * 플러그인**이다(별도 `plugin.json`·CHANGELOG·릴리스 워크플로). 출하되는 이상
 * 프론트매터가 가리키는 도구도 실재해야 한다. 릴리스 주기가 다르다는 것은
 * 게이트를 면제할 이유가 아니라 **드리프트가 더 조용히 쌓일 이유**다 —
 * 실제로 2026-08-15 첫 확장 시점에 cowork orchestrator 는 `tools:` 에
 * `Agent` 를 한 줄도 선언하지 않은 채 폐지된 `Task(...)` 10건과
 * `TeamCreate`/`TeamDelete` 로만 팀원을 스폰하게 돼 있었다(= 스폰 불능).
 */
const PLUGIN_ROOTS = [
  { id: 'artibot', dir: join(PLUGINS_DIR, 'artibot'), strict: true },
  {
    id: 'artibot-cowork',
    dir: join(PLUGINS_DIR, 'artibot-cowork'),
    // 엄격 방언 면제 (lane 1A, 2026-10-07). 면제는 사유와 만료일 없이는 존재할 수 없고, 만료일이
    // 지나면 '면제가 만료되지 않았다' 가 RED 가 된다. `strict` 를 빼먹어도 면제로 읽히므로
    // 사유·만료일 단언이 그 구멍을 막는다. 면제는 이 루트의 agents/*.md 를 **엄격 방언 패스에서
    // 뺄 뿐**이다. 도구명 스캔(`scanDeclaredToolNames`)은 관대 파서로 12파일 전부를 계속
    // 훑고, 그 분모는 변하지 않는다.
    strict: false,
    strictExemption: {
      until: '2026-11-30',
      reason:
        '독립 출하 플러그인이라 별도 레인에서 고친다. 2026-10-07 01:2x 실측: 에이전트 12/12 가 ' +
        'artibot 과 같은 결함 상태(frontmatter 주석 23줄 + 인라인 1, `---` 포함 16줄).',
    },
  },
];

/** `.md` 파일 목록. INDEX.md 는 자동생성 색인이라 에이전트가 아니다. */
function agentFiles(root) {
  return readdirSync(join(root.dir, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .filter((f) => f !== 'INDEX.md');
}

function commandFiles(root) {
  return readdirSync(join(root.dir, 'commands')).filter((f) => f.endsWith('.md'));
}

/**
 * 스캔 대상 파일 하나를 기술한다. `rel` 은 플러그인 id 를 접두로 달아 두 루트의
 * 동명 파일(`commands/analyze.md` 가 양쪽에 있다)을 구별할 수 있게 한다.
 *
 * @param {{id: string, dir: string}} root
 * @returns {Array<{rel: string, abs: string, parse: Function}>}
 */
function sourcesFor(root) {
  return [
    ...commandFiles(root).map((f) => ({
      rel: `${root.id}/commands/${f}`,
      abs: join(root.dir, 'commands', f),
      parse: parseCommandTools,
    })),
    ...agentFiles(root).map((f) => ({
      rel: `${root.id}/agents/${f}`,
      abs: join(root.dir, 'agents', f),
      parse: parseAgentTools,
    })),
  ];
}

/**
 * 전 플러그인의 전 파일을 훑어 allowlist 밖 이름을 모은다.
 *
 * @param {Set<string>} allowlist 뮤테이션 테스트가 주입할 수 있게 인자로 받는다.
 * @returns {{ violations: Array<{file: string, name: string}>, unparsed: Array<{file: string, reason: string}>, scanned: number }}
 */
export function scanDeclaredToolNames(allowlist = KNOWN_TOOL_NAMES) {
  const violations = [];
  const unparsed = [];
  let scanned = 0;

  const sources = PLUGIN_ROOTS.flatMap(sourcesFor);

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

/**
 * 면제 만료 판정. 날짜를 못 읽으면 **만료로 본다**(fail-closed) — 면제가 날짜 오타 하나로
 * 영구화되는 길을 막는다. 만료일은 KST 기준 그날 23:59:59 까지 유효하다.
 *
 * @param {{ until?: string } | undefined} exemption
 * @param {Date} [now] 자기검증이 시계를 주입할 수 있게 인자로 받는다.
 * @returns {boolean}
 */
export function strictExemptionExpired(exemption, now = new Date()) {
  const end = Date.parse(`${exemption?.until}T23:59:59+09:00`);
  return Number.isNaN(end) || now.getTime() > end;
}

/**
 * strict 루트의 `agents/*.md` 를 엄격 방언(`checkStrictAgentFrontmatter`)으로 훑는다.
 * 면제 루트는 훑지 않는다(`exempt` 에 id 만 남는다).
 *
 * @param {typeof PLUGIN_ROOTS} [roots]
 * @param {(abs: string) => string} [read] 뮤테이션 자기검증이 읽기를 가로챌 수 있게 인자로 받는다.
 * @returns {{ violations: Array<{file: string, line: number, rule: string, text: string}>, scanned: number, exempt: string[] }}
 */
export function scanStrictAgentDialect(roots = PLUGIN_ROOTS, read = (abs) => readFileSync(abs, 'utf-8')) {
  const violations = [];
  const exempt = [];
  let scanned = 0;
  for (const root of roots) {
    if (!root.strict) {
      exempt.push(root.id);
      continue;
    }
    for (const f of agentFiles(root)) {
      scanned += 1;
      const rel = `${root.id}/agents/${f}`;
      for (const v of checkStrictAgentFrontmatter(read(join(root.dir, 'agents', f))).violations) {
        violations.push({ file: rel, ...v });
      }
    }
  }
  return { violations, scanned, exempt };
}

/** 엄격 방언 위반을 파일 단위로 묶고, 규칙마다 이유를 한 번씩 붙인다. */
function formatStrictViolations(violations) {
  const byFile = new Map();
  for (const v of violations) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file).push(`      :${v.line} [${v.rule}] ${v.text.trim()}`);
  }
  const rules = [...new Set(violations.map((v) => v.rule))]
    .map((r) => `  ${r}: ${STRICT_AGENT_RULE_HINTS[r]}`)
    .join('\n');
  const files = [...byFile.entries()].map(([file, rows]) => `  ${file}\n${rows.join('\n')}`).join('\n');
  return `${rules}\n${files}`;
}

describe('프론트매터 도구명 — 파싱 가능성', () => {
  // 파싱 실패는 null 이 아니라 RED 다. lockstep 게이트가 "못 읽음"과 "목록 없음"을
  // 구별하지 못해 노출을 남긴 선례를 반복하지 않는다.
  it('모든 커맨드·에이전트가 도구 선언을 파싱 가능한 형태로 한다', () => {
    const failures = PLUGIN_ROOTS.flatMap(sourcesFor)
      .map((s) => ({ s, r: s.parse(readFileSync(s.abs, 'utf-8')) }))
      .filter((x) => !x.r.ok)
      .map((x) => `${x.s.rel}: ${x.r.reason}`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  // 분모가 줄면(디렉터리 오타, 필터 실수, 루트 누락) 게이트가 조용히 아무것도 안
  // 보게 된다. 루트별로 따로 못박아, 한쪽이 통째로 빠져도 합계가 우연히 맞아
  // 넘어가는 일이 없게 한다.
  const FLOOR = {
    artibot: { commands: 70, agents: 20 },
    'artibot-cowork': { commands: 15, agents: 10 },
  };

  it.each(PLUGIN_ROOTS)('$id 루트가 커맨드와 에이전트 양쪽을 덮는다', (root) => {
    expect(commandFiles(root).length).toBeGreaterThan(FLOOR[root.id].commands);
    expect(agentFiles(root).length).toBeGreaterThan(FLOOR[root.id].agents);
  });

  it('스캔 분모가 전 루트의 파일 수 합과 정확히 같다', () => {
    const { scanned } = scanDeclaredToolNames();
    const expected = PLUGIN_ROOTS.reduce(
      (sum, root) => sum + commandFiles(root).length + agentFiles(root).length,
      0,
    );
    expect(scanned).toBe(expected);
  });
});

describe('프론트매터 도구명 — 실재 검증', () => {
  it('선언된 모든 도구명이 알려진 하네스 도구다', () => {
    const { violations } = scanDeclaredToolNames();
    expect(violations, `알 수 없는 도구명:\n${formatViolations(violations)}`).toEqual([]);
  });
});

describe('프론트매터 엄격 방언 — agents/*.md (strict 루트만)', () => {
  // 배경: 호스트는 frontmatter 를 주석 안의 첫 `---` 에서 닫는다(n=5). 위 도구명 게이트의 파서는
  // 주석을 정상으로 읽어서 30/30 이 결함 상태일 때도 green 이었다 — 게이트 오라클이 호스트보다
  // 관대했다. 이 패스는 오라클을 호스트보다 엄격하게 둔다. 못 보는 것은 파일 머리글 7번.
  it('artibot 은 strict 이고, 면제 루트는 사유와 만료일을 가진다', () => {
    expect(PLUGIN_ROOTS.find((r) => r.id === 'artibot').strict).toBe(true);
    for (const root of PLUGIN_ROOTS) expect(typeof root.strict, `${root.id}: strict 가 boolean 이 아니다`).toBe('boolean');
    for (const root of PLUGIN_ROOTS.filter((r) => !r.strict)) {
      expect(root.strictExemption?.reason?.length ?? 0, `${root.id}: 면제 사유가 없다`).toBeGreaterThan(20);
      expect(Number.isNaN(Date.parse(root.strictExemption?.until)), `${root.id}: 만료일이 날짜가 아니다`).toBe(false);
    }
  });

  it.each(PLUGIN_ROOTS.filter((r) => !r.strict))('$id 의 strict 면제가 만료되지 않았다', (root) => {
    expect(
      strictExemptionExpired(root.strictExemption),
      `${root.id} 면제가 ${root.strictExemption.until} 에 만료됐다 — 에이전트를 고쳐 strict:true 로 올리거나 오너가 연장을 결정하라`,
    ).toBe(false);
  });

  it('strict 루트의 모든 에이전트가 엄격 방언을 지킨다', () => {
    const { violations } = scanStrictAgentDialect();
    expect(violations, `엄격 방언 위반:\n${formatStrictViolations(violations)}`).toEqual([]);
  });

  it('엄격 검사 분모가 strict 루트의 에이전트 파일 수와 정확히 같고 floor 를 넘는다', () => {
    const { scanned } = scanStrictAgentDialect();
    const expected = PLUGIN_ROOTS.filter((r) => r.strict).reduce((n, r) => n + agentFiles(r).length, 0);
    expect(scanned).toBe(expected);
    // 위 FLOOR.artibot.agents 와 같은 값이다. 분모가 줄면 게이트가 조용히 아무것도 안 본다.
    expect(scanned).toBeGreaterThan(20);
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

  // 관대 경로(D1 · cowork 면제) 전용이다. strict 루트에서는 같은 입력이 오류다 — 아래
  // '(반전)' 자기검증. 이 동작이 호스트보다 관대한 오라클의 원형이므로 면제 만료와 함께 지운다.
  it('(관대 경로 — D1·cowork 면제 전용) 항목 뒤 주석과 이어지는 주석 행을 벗긴다', () => {
    // 면제 루트(cowork orchestrator)에 실재하는 형태. 안 벗기면 도구명이 주석을 머금는다.
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

  // 음성 대조. 위 뮤테이션은 "어딘가에서" 위반이 잡히는 것만 보증하므로, 루트를
  // 하나 더 붙였는데 경로가 틀려 0건을 훑고 있어도 artibot 쪽 위반만으로 통과한다.
  // 루트별로 위반이 **귀속**되는지까지 봐야 스코프 확장이 실효라는 증거가 된다.
  it.each(PLUGIN_ROOTS)('$id 의 파일이 실제로 스캔된다 (루트별 귀속 확인)', (root) => {
    const shrunk = new Set(KNOWN_TOOL_NAMES);
    shrunk.delete('Read');
    const { violations } = scanDeclaredToolNames(shrunk);

    const fromRoot = violations.filter((v) => v.file.startsWith(`${root.id}/`) && v.name === 'Read');
    expect(fromRoot.length, `${root.id} 에서 Read 위반이 0건 — 이 루트는 스캔되지 않고 있다`).toBeGreaterThan(0);
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

describe('스캐너 자기검증 — 엄격 방언', () => {
  const MARKER = '# --- X ---';
  /** `tools:` 바로 아래에 대시 주석 한 줄을 넣는다 (CRLF·LF 모두). */
  const inject = (text) => text.replace(/^tools:(\r?\n)/m, `$&  ${MARKER}$1`);

  it('(반전) 항목 뒤 주석과 이어지는 주석 행은 엄격 방언에서 오류다', () => {
    // 예전에는 이 픽스처를 "정상으로 읽는다"는 자기검증이었다. 바로 그 관대함이 호스트와의
    // 격차였고, 30/30 결함 상태에서 게이트가 green 이던 이유다.
    const text = [
      '---',
      'tools:',
      '  # --- Communication ---',
      '  - SendMessage   # DM (type:"message")',
      '                  # shutdown',
      '  - Read',
      '---',
      'body',
    ].join('\n');
    const rules = new Set(checkStrictAgentFrontmatter(text).violations.map((v) => v.rule));
    expect(rules).toEqual(new Set(['dashes', 'comment', 'inline-comment']));
  });

  it('모든 strict 에이전트에 `# --- X ---` 를 주입하면 파일마다 위반 2건이 새로 잡힌다', () => {
    const baseline = scanStrictAgentDialect();
    const mutated = scanStrictAgentDialect(PLUGIN_ROOTS, (abs) => {
      const original = readFileSync(abs, 'utf-8');
      const injected = inject(original);
      // 뮤테이션이 **적용됐는지** 독립 확인한다. 안 들어갔으면 아래 차분은 아무것도 증명하지 않는다.
      expect(injected, `${abs}: 주입이 적용되지 않았다`).not.toBe(original);
      expect(injected).toContain(MARKER);
      return injected;
    });
    expect(mutated.scanned).toBe(baseline.scanned);
    // 기준선과의 차분. 파일마다 `dashes` 1 + `comment` 1.
    expect(mutated.violations.length - baseline.violations.length).toBe(2 * baseline.scanned);
    // 마커 줄에 붙은 위반만 센다. 실제 파일에 같은 마커가 이미 있어도(= 이미 RED) 이 단언이
    // 따로 흔들리지 않게 기준선의 마커 위반을 뺀다.
    const hitsOf = (scan) => scan.violations.filter((v) => v.text.includes(MARKER));
    expect(hitsOf(mutated).length - hitsOf(baseline).length).toBe(2 * baseline.scanned);
    expect(new Set(hitsOf(mutated).map((v) => v.file)).size).toBe(baseline.scanned);
  });

  it('면제 루트는 주입해도 엄격 패스에 잡히지 않는다 — 면제가 유일한 이유임을 보인다', () => {
    const mutated = scanStrictAgentDialect(PLUGIN_ROOTS, (abs) => inject(readFileSync(abs, 'utf-8')));
    expect(mutated.exempt).toEqual(PLUGIN_ROOTS.filter((r) => !r.strict).map((r) => r.id));
    expect(mutated.violations.some((v) => v.file.startsWith('artibot-cowork/'))).toBe(false);
    // 같은 주입을 cowork 를 strict 로 올린 루트 목록에 넣으면 잡힌다 = 면제가 없으면 RED 다.
    const promoted = PLUGIN_ROOTS.map((r) => ({ ...r, strict: true }));
    const all = scanStrictAgentDialect(promoted, (abs) => inject(readFileSync(abs, 'utf-8')));
    expect(all.violations.some((v) => v.file.startsWith('artibot-cowork/'))).toBe(true);
  });

  it('만료 판정 자체가 동작한다 (주입된 시계, 날짜 불량은 만료로 본다)', () => {
    const exemption = { until: '2026-11-30' };
    expect(strictExemptionExpired(exemption, new Date('2026-11-30T12:00:00+09:00'))).toBe(false);
    expect(strictExemptionExpired(exemption, new Date('2026-12-01T00:00:01+09:00'))).toBe(true);
    expect(strictExemptionExpired({ until: 'soon' }, new Date('2026-01-01T00:00:00Z'))).toBe(true);
    expect(strictExemptionExpired(undefined, new Date('2026-01-01T00:00:00Z'))).toBe(true);
  });
});
