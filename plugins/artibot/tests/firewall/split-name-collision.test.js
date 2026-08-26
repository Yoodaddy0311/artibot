/**
 * Firewall — `/split` 줄기·팀원 이름이 출하 에이전트/커맨드 이름과 겹치지 않고,
 * 세션 판별자 `{sid}` 를 싣는가. 그리고 **문서(`commands/split.md`)의 이름 규약이
 * 모듈(`lib/git/repo-identity.js`)과 같은 이름을 내는가.**
 *
 * ── 왜 이 게이트가 필요한가 ─────────────────────────────────────────────────
 * `SendMessage` 스키마: *"if the same name also names an in-process agent, the bare
 * name always wins"*. 같은 리포에서 두 창(세션)이 같은 커맨드를 돌리면 같은 팀원
 * 이름이 나오고, 교차 세션 지시가 **오류 없이** 자기 세션 팀원에게 배달된다 —
 * 오배달은 성공처럼 보여 사후 탐지되지 않는다. `/split` 은 정의상 **같은 리포에
 * 창 N개**를 여는 커맨드라 이 충돌이 기본 상태다.
 *
 * `teammate-name-session-discriminator.test.js` 가 `/team`·`/autopilot`·`/ultraplan`·
 * `/sc` 4캐리어를, `split-limb-naming.test.js` 가 모듈 쪽 이름 생성을 지킨다. 그 파일은
 * 자기 한계 #3 에 "`commands/split.md` 가 실제로 `limbNames` 를 쓰는지는 보지 않는다 —
 * 문서↔모듈 결합은 별도 단언이 필요하다" 고 적었고, **이 파일이 그 결합을 단언한다**:
 *
 *   - worktree `split-{repoShort}-{limb}` = `repo-identity.js#splitWorktreeName`
 *   - 브랜치 `worktree-split-{repoShort}-{limb}` = `repo-identity.js#splitLimbBranch`
 *     (프로브 P2: 내장 `--worktree` 는 `worktree-` 접두로 자동 명명, `/` 허용 미확인)
 *   - 줄기 창 안 팀원 `split-{repoShort}-{limb}-{sid}-{role}` — `/team` 의 `team-…` 과 접두 분리
 *   - split.md 의 모든 `name="…"` 리터럴이 `{sid}` 를 싣는다 (`*` 축약 불허)
 *   - 위 규약으로 만든 이름은 출하 에이전트·커맨드 맨이름과 교집합 0
 *   - 브랜치 접두는 `worktree-manager.js` 가 지우는 `autopilot/` 접두 밖
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ───────────────────────────────────────
 *
 *  1. **모델이 규약대로 이름을 짓는지는 못 본다.** 문서에 적혀 있다는 것뿐이다.
 *  2. **하네스가 붙이는 세션 이름(`{worktree 디렉터리명}-{hex2}`, n=4 관측)은 규칙이
 *     미확인이다.** 여기서는 우리가 정하는 이름(worktree·브랜치·팀원)만 본다.
 *  3. **사용자가 손으로 지은 worktree·세션 이름은 대상 밖이다.**
 *  4. **실행하지 않는다.** 두 창을 실제로 띄워 오배달을 재현하지 않았다.
 *  5. **`repo-identity.js` 를 import 한다** — 그 모듈이 같은 랜딩에 없으면 이 파일은
 *     import 단계에서 red 다. 그것은 결합 단언의 대가이지 결함이 아니다(문서만
 *     랜딩되고 모듈이 없으면 문서의 인용이 유령이 된다).
 *
 * @module tests/firewall/split-name-collision
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { splitLimbBranch, splitWorktreeName } from '../../lib/git/repo-identity.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(PLUGIN_ROOT, rel), 'utf-8');

const splitMd = read('commands/split.md');
const worktreeManagerSrc = read('lib/autopilot/worktree-manager.js');

/** split.md 가 지시하는 규약을 그대로 함수로 옮긴 것 — 아래에서 모듈 출력과 대조한다. */
export function docWorktreeName(repoShort, limb) {
  return `split-${repoShort}-${limb}`;
}
export function docBranchName(repoShort, limb) {
  return `worktree-${docWorktreeName(repoShort, limb)}`;
}
export function limbTeammateName(repoShort, limb, sid, role) {
  return `split-${repoShort}-${limb}-${sid}-${role}`;
}
/** `/team` 규약 — 두 규약이 같은 입력에서 같은 이름을 내지 않음을 대조하기 위해 둔다. */
function teamTeammateName(taskSlug, sid, role) {
  return `team-${taskSlug}-${sid}-${role}`;
}

/** 문서가 명시한 limb 정규식을 문서에서 직접 읽는다 (손 사본 금지). */
function documentedLimbRegex() {
  const m = splitMd.match(/`\^\[a-z0-9\]\[a-z0-9-\]\{1,30\}\$`/);
  return m ? /^[a-z0-9][a-z0-9-]{1,30}$/ : null;
}

function shippedAgentNames() {
  const names = new Set();
  for (const f of readdirSync(path.join(PLUGIN_ROOT, 'agents'))) {
    if (!f.endsWith('.md') || f === 'INDEX.md') continue;
    const m = read(`agents/${f}`).match(/^name:\s*(.+)$/m);
    if (m) names.add(m[1].trim());
  }
  return names;
}

function shippedCommandNames() {
  return new Set(
    readdirSync(path.join(PLUGIN_ROOT, 'commands'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3)),
  );
}

function spawnNameLiterals(src) {
  return [...src.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
}

const agents = shippedAgentNames();
const commands = shippedCommandNames();
const shipped = new Set([...agents, ...commands]);

describe('규약이 문서에 성문화돼 있다', () => {
  it('worktree 이름 split-{repoShort}-{limb} 과 브랜치 worktree-split-{repoShort}-{limb} 을 명시한다', () => {
    expect(splitMd).toMatch(/worktree 이름 `split-\{repoShort\}-\{limb\}`/);
    expect(splitMd).toMatch(/브랜치 `worktree-split-\{repoShort\}-\{limb\}`/);
  });

  it('이름의 정본으로 lib/git/repo-identity.js 를 지목한다', () => {
    expect(splitMd).toMatch(/lib\/git\/repo-identity\.js#splitWorktreeName/);
    expect(splitMd).toMatch(/lib\/git\/repo-identity\.js#splitLimbBranch/);
    expect(splitMd).toMatch(/lib\/git\/repo-identity\.js#repoShortName/);
  });

  it('limb 정규식을 명시하고 `/` 를 금지한다 (P2)', () => {
    const re = documentedLimbRegex();
    expect(re, '문서에 limb 정규식이 없다').not.toBeNull();
    expect(re.test('auth-api')).toBe(true);
    expect(re.test('split/auth')).toBe(false);
    expect(re.test('Auth')).toBe(false);
    expect(re.test('a')).toBe(false);
  });

  it('줄기 창 팀원 이름 규약을 명시하고 bare-name-wins 근거를 인용한다', () => {
    expect(splitMd).toMatch(/name="split-\{repoShort\}-\{limb\}-\{sid\}-\{role\}"/);
    expect(splitMd).toMatch(/bare name\s+always\s+wins/);
  });

  it('split.md 의 모든 name= 리터럴이 {sid} 를 싣는다 (`*` 축약 불허)', () => {
    const names = spawnNameLiterals(splitMd);
    expect(names.length, 'name= 리터럴이 하나도 없다 — 분모 0').toBeGreaterThanOrEqual(1);
    const bare = names.filter((n) => !/\{sid\}/.test(n));
    expect(bare, `판별자 없는 이름: ${JSON.stringify(bare)}`).toEqual([]);
  });
});

describe('문서 규약 ↔ repo-identity.js 결합', () => {
  const cases = [['artibot', 'auth'], ['ontology', 'ingest-api'], ['x1', 'a-b-c']];

  it.each(cases)('worktree 이름이 같다 (%s, %s)', (repoShort, limb) => {
    expect(docWorktreeName(repoShort, limb)).toBe(splitWorktreeName(repoShort, limb));
  });

  it.each(cases)('브랜치 이름이 같다 (%s, %s)', (repoShort, limb) => {
    expect(docBranchName(repoShort, limb)).toBe(splitLimbBranch(repoShort, limb));
  });
});

describe('두 세션이 같은 이름을 만들지 않는다', () => {
  it('limb 와 role 이 같아도 sid 가 다르면 이름이 다르다', () => {
    expect(limbTeammateName('r', 'auth', 'afd778', 'backend'))
      .not.toBe(limbTeammateName('r', 'auth', '3fa9c1', 'backend'));
  });

  it('같은 세션 안에서는 결정적이다', () => {
    expect(limbTeammateName('r', 'auth', 'afd778', 'backend'))
      .toBe(limbTeammateName('r', 'auth', 'afd778', 'backend'));
  });

  it('/team 규약과 /split 규약은 같은 입력에서 다른 이름을 낸다 (접두 분리)', () => {
    const split = limbTeammateName('r', 'auth', 'afd778', 'backend');
    const team = teamTeammateName('auth', 'afd778', 'backend');
    expect(split).not.toBe(team);
    expect(split.startsWith('split-')).toBe(true);
    expect(team.startsWith('team-')).toBe(true);
  });

  it('줄기 창의 세션 이름 접두(split-{repoShort}-{limb}-)와 팀원 이름은 형태가 달라 같아질 수 없다', () => {
    const wt = docWorktreeName('r', 'auth');
    // 하네스 세션 이름 `{worktree}-{hex2}` — 팀원 이름은 `{worktree}-{sid6}-{role}` 이라 hex2 형태가 아니다.
    expect(limbTeammateName('r', 'auth', 'afd778', 'backend')).not.toMatch(new RegExp(`^${wt}-[0-9a-f]{2}$`));
  });
});

describe('출하 이름과 교집합 0', () => {
  it('스캔한 출하 목록이 하한을 넘는다 ("교집합 0" ≠ "0개 스캔")', () => {
    expect(agents.size).toBeGreaterThanOrEqual(28);
    expect(commands.size).toBeGreaterThanOrEqual(78);
    expect(commands.has('split'), 'commands/split.md 가 출하 목록에 없다').toBe(true);
  });

  it('출하 이름을 limb 로 써도 worktree 이름은 출하 이름과 겹치지 않는다', () => {
    const collisions = [...shipped].map((limb) => docWorktreeName('artibot', limb)).filter((n) => shipped.has(n));
    expect(collisions).toEqual([]);
  });

  it('출하 이름을 role 로 써도 완성 팀원 이름은 출하 이름과 겹치지 않는다', () => {
    const collisions = [...shipped]
      .map((role) => limbTeammateName('artibot', 'any-limb', 'afd778', role))
      .filter((n) => shipped.has(n));
    expect(collisions).toEqual([]);
  });

  it('출하 이름을 limb 로 써도 마찬가지다', () => {
    const collisions = [...shipped]
      .map((limb) => limbTeammateName('artibot', limb, 'afd778', 'worker'))
      .filter((n) => shipped.has(n));
    expect(collisions).toEqual([]);
  });
});

describe('브랜치 접두 — worktree-manager 의 삭제 allowlist 밖', () => {
  it('worktree-manager.js 의 자동 삭제 접두를 소스에서 읽는다 (손 사본 금지)', () => {
    const m = worktreeManagerSrc.match(/const AUTOPILOT_BRANCH_PREFIX = '([^']+)'/);
    expect(m, 'AUTOPILOT_BRANCH_PREFIX 상수를 찾지 못했다').not.toBeNull();
    const prefix = m[1];
    // 줄기 브랜치는 그 접두로 시작하지 않는다 → deleteAutopilotBranch 가 지우지 못한다.
    expect(docBranchName('artibot', 'auth').startsWith(prefix)).toBe(false);
    // 반대로 autopilot 브랜치는 시작한다 — 대조가 동어반복이 아님을 보이는 음성 대조.
    expect(`${prefix}abc`.startsWith(prefix)).toBe(true);
  });
});
