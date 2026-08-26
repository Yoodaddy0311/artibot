/**
 * 검사 목적: `/team` 이 지시하는 팀원 이름이 **세션 판별자를 포함하는가**, 그리고
 * 그 규약이 만들어내는 이름이 출하 중인 에이전트·커맨드 이름과 겹치지 않는가.
 *
 * ── 왜 이 게이트가 필요한가 (공식 스키마 인용) ─────────────────────────────
 * `SendMessage` 스키마는 이름 충돌을 **조용히** 해소한다:
 *
 *   "if the same name also names an in-process agent, the bare name always wins"
 *
 * 그런데 판별자가 없던 규약 `team-{task-slug}-{role}` 은 작업 설명에서 **결정적으로**
 * 생성된다. 같은 리포에서 두 세션이 같은 커맨드를 돌리면 같은 이름이 나오고, 교차
 * 세션 지시가 오류 없이 자기 세션 팀원에게 배달된다. 오배달은 **사후 탐지되지 않는다**
 * — 실패가 아니라 성공처럼 보이기 때문이다.
 *
 * 오늘 실제로 돌던 autopilot 팀원 이름 `ap-ft9t2b-worker-1` 은 세션 접미 `ft9t2b` 를
 * 이미 포함해 안전했다. `commands/autopilot.md` 의 `autopilot-{sessionId}-{role}` 도
 * 마찬가지다. **성문화되지 않은 쪽은 `/team` 뿐이었고**, 이 게이트가 그것을 고정한다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ─────────────────
 *
 *  1. **모델이 규약을 실제로 따르는지는 검증하지 못한다.** 여기서 확인하는 것은
 *     마크다운에 지시가 **적혀 있다**는 것뿐이다. 문서 존재 ≠ 준수. 리더는 프롬프트를
 *     읽는 모델이므로 실행 시 이름을 다르게 지을 수 있고, 그 이탈은 이 파일이 아니라
 *     런타임 관측(`ListAgents` 출력)으로만 잡힌다.
 *  2. **사용자가 손으로 지은 이름은 대상 밖이다.** 규약은 `/team` 리더의 스폰에만
 *     적용된다. 사람이 직접 스폰하며 붙인 이름의 충돌은 막지 못한다.
 *  3. **`team-*-…` 축약형은 문서 자신의 정의를 믿고 통과시킨다.** `*` 가 런 접두사
 *     (`{task-slug}-{sid}`) 를 뜻한다는 것은 team.md 산문이 정의한 바이고, 이 게이트는
 *     그 정의가 맞다고 **가정**한다. 정의 문장이 사라지면 (a) 검사가 red 로 잡지만,
 *     `*` 를 쓴 개별 예시가 판별자를 실어 나르는지는 구조적으로 확인할 수 없다.
 *  4. **실행하지 않는다.** 두 세션을 실제로 띄워 오배달을 재현하지 않았다. 충돌
 *     메커니즘의 근거는 위 스키마 문장이지 실측 재현이 아니다.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const TEAM_MD = join(PLUGIN_ROOT, 'commands', 'team.md');

// 파일 부재·읽기 실패는 fail-closed 다. 조용한 스킵 가드를 두지 않는다 — 규약
// 문서가 사라졌는데 green 을 내는 게이트는 없느니만 못하다.
const teamMd = readFileSync(TEAM_MD, 'utf-8');

/**
 * 출하 에이전트 이름. `agents/*.md` 의 프론트매터 `name:` 이 정본이다.
 *
 * `agent-name-references.test.js#shippedAgents` 가 같은 일을 하지만 **import 하지
 * 않는다** — 그 파일은 최상위 `describe` 를 가진 테스트 모듈이라, import 하면 그
 * 스위트가 이 파일 안에서 한 번 더 등록돼 이중 계수된다 (`vitest.config.js` 주석이
 * 기록한 15168/7674 사고와 같은 형태). 스캔 **방식**만 가져온다.
 */
function shippedAgentNames() {
  const names = new Set();
  for (const f of readdirSync(join(PLUGIN_ROOT, 'agents'))) {
    if (!f.endsWith('.md') || f === 'INDEX.md') continue;
    const m = readFileSync(join(PLUGIN_ROOT, 'agents', f), 'utf-8').match(/^name:\s*(.+)$/m);
    if (m) names.add(m[1].trim());
  }
  return names;
}

/** `commands/*.md` 파일명이 곧 커맨드 이름이다. */
function shippedCommandNames() {
  return new Set(
    readdirSync(join(PLUGIN_ROOT, 'commands'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3)),
  );
}

/** team.md 가 지시하는 팀원 이름 규약을 그대로 적용한다. */
function teammateName(taskSlug, sid, role) {
  return `team-${taskSlug}-${sid}-${role}`;
}

/** 스폰 예시의 `name="..."` 값을 전부 뽑는다. */
function spawnNameLiterals(src) {
  return [...src.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
}

describe('명명 규약 — 세션 판별자가 문서에 성문화돼 있다', () => {
  it('정본 스폰 예시의 name 에 {sid} 가 들어간다', () => {
    expect(teamMd).toMatch(/name="team-\{task-slug\}-\{sid\}-\{role\}"/);
  });

  it('판별자가 필요한 근거로 "bare name wins" 를 인용한다', () => {
    // 근거가 빠지면 다음 편집자가 "장식적인 접미사"로 보고 지운다.
    // 공백에 관대하게: 인용문이 줄바꿈으로 접히는 것은 정상적인 편집이고,
    // 그때마다 red 가 되면 게이트가 리플로우를 처벌하게 된다.
    expect(teamMd).toMatch(/bare name\s+always\s+wins/);
  });

  it('{sid} 의 정본 소스로 훅 페이로드 session_id 를 지목한다', () => {
    expect(teamMd).toMatch(/session_id/);
    expect(teamMd).toMatch(/resolveSessionId/);
  });

  it('machineId 를 판별자로 쓰지 말라고 명시한다', () => {
    // `cross-machine.js#machineId` 는 {hostname}_{username} 이라 같은 PC 의 두
    // 세션이 같은 값을 낸다 — 기계는 가르지만 세션은 가르지 못한다.
    expect(teamMd).toMatch(/machineId/);
    expect(teamMd).toMatch(/hostname\}_\{username|같은 PC 의 두\s*\n?\s*세션이 같은 값/);
  });

  it('`team-*-…` 축약의 `*` 가 {sid} 를 포함한 런 접두사임을 정의한다', () => {
    expect(teamMd).toMatch(/\{task-slug\}-\{sid\}\).*가리킨다|별표 자리에도 `\{sid\}` 가 들어간다/s);
  });

  it('모든 스폰 예시 name 이 판별자를 싣거나 런 접두사 축약을 쓴다', () => {
    const names = spawnNameLiterals(teamMd).filter((n) => n.startsWith('team-'));
    // 분모 단언: 예시를 하나도 못 찾으면 "위반 0" 이 "검사 0" 을 뜻하게 된다.
    expect(names.length, '팀원 스폰 예시 name 을 하나도 찾지 못했다').toBeGreaterThanOrEqual(4);

    const bare = names.filter((n) => !n.includes('{sid}') && !n.includes('*'));
    expect(bare, `판별자 없는 스폰 이름: ${JSON.stringify(bare)}`).toEqual([]);
  });
});

describe('명명 규약 — 두 세션이 같은 이름을 만들지 않는다', () => {
  it('slug 와 role 이 같아도 sid 가 다르면 이름이 다르다', () => {
    const a = teammateName('auth-refactor', 'afd778', 'backend');
    const b = teammateName('auth-refactor', '3fa9c1', 'backend');

    expect(a).not.toBe(b);
  });

  it('같은 세션 안에서는 결정적이다 (SendMessage 주소가 안정적이어야 한다)', () => {
    // 판별자가 매 호출 랜덤이면 충돌은 사라지지만 주소도 같이 사라진다.
    expect(teammateName('auth-refactor', 'afd778', 'backend'))
      .toBe(teammateName('auth-refactor', 'afd778', 'backend'));
  });

  it('한 런의 서로 다른 역할끼리도 이름이 갈린다', () => {
    const roles = ['backend', 'frontend', 'reviewer'].map((r) => teammateName('x', 'afd778', r));

    expect(new Set(roles).size).toBe(roles.length);
  });
});

describe('명명 규약 — 출하 이름과 교집합 0', () => {
  const agents = shippedAgentNames();
  const commands = shippedCommandNames();

  // 분모 먼저. "교집합 0" 이 "아무것도 안 읽었다" 로 통과하는 것을 막는다.
  it('스캔한 출하 목록이 하한을 넘는다 ("교집합 0" ≠ "0개 스캔")', () => {
    expect(agents.size, '에이전트를 하나도 읽지 못했다').toBeGreaterThanOrEqual(28);
    expect(commands.size, '커맨드를 하나도 읽지 못했다').toBeGreaterThanOrEqual(78);
  });

  // 역할 자리에 에이전트 타입명을 그대로 쓰는 것은 흔하고 자연스럽다
  // (`Agent(subagent_type="artibot:architect", name="team-…-architect")`).
  // 그래도 완성된 이름은 접두사·slug·sid 때문에 맨이름과 절대 같아질 수 없다 —
  // 규약이 **구조적으로** 충돌을 막는다는 것이 이 단언의 내용이다.
  it('역할 자리에 에이전트 타입명을 넣어도 완성 이름은 출하 에이전트명과 겹치지 않는다', () => {
    const collisions = [...agents]
      .map((role) => teammateName('any-task', 'afd778', role))
      .filter((name) => agents.has(name));

    expect(collisions).toEqual([]);
  });

  it('역할 자리에 커맨드명을 넣어도 완성 이름은 출하 커맨드명과 겹치지 않는다', () => {
    const collisions = [...commands]
      .map((role) => teammateName('any-task', 'afd778', role))
      .filter((name) => commands.has(name));

    expect(collisions).toEqual([]);
  });

  it('slug 자리에 출하 이름을 넣어도 마찬가지다', () => {
    const shipped = new Set([...agents, ...commands]);
    const collisions = [...shipped]
      .map((slug) => teammateName(slug, 'afd778', 'worker'))
      .filter((name) => shipped.has(name));

    expect(collisions).toEqual([]);
  });
});
