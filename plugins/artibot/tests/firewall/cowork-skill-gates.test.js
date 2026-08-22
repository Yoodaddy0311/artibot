/**
 * 검사 목적: `skill:check` 와 `scripts/validate.js` 가 **cowork 를 실제로 세는가**.
 *
 * ── 왜 필요했나 (2026-08-16 실측) ────────────────────────────────────────────
 * `skill:check` 는 세 스크립트의 체인이다(`package.json#scripts.skill:check`):
 *
 *   node scripts/gen-skill-docs.js --check
 *   node scripts/ci/lint-skill-descriptions.js
 *   node scripts/ci/lint-skill-size.js
 *
 * 셋 다 대상 디렉터리를 `<이 플러그인 루트>/skills` 로 **하드코딩**했고,
 * `scripts/validate.js` 의 agents/skills/commands 검증기도 같았다. 그 결과
 * `plugins/artibot-cowork/` 의 스킬 46 · 커맨드 21 · 에이전트 12 는 어느 게이트도
 * 거치지 않았는데, 게이트는 매번 PASS 를 찍었다.
 *
 * 편입 전/후 분모(2026-08-16 측정):
 *
 *   gen-skill-docs   113 → 159 skills   (artibot=113 artibot-cowork=46)
 *   lint-skill-size  113 → 159 skills
 *   lint-skill-desc  113 → 159 skills
 *   validate.js      28  → 40  agents   (artibot=28  artibot-cowork=12)
 *                    113 → 159 skills
 *                    78  → 99  commands (artibot=78  artibot-cowork=21)
 *
 * 재현(리포 루트에서):
 *   $ node plugins/artibot/scripts/gen-skill-docs.js --check | tail -1
 *   $ node plugins/artibot/scripts/ci/lint-skill-size.js
 *   $ node plugins/artibot/scripts/ci/lint-skill-descriptions.js | tail -3
 *   $ cd plugins/artibot && node scripts/validate.js
 *
 * ── 이름 충돌이 이 게이트의 핵심 제약이다 ───────────────────────────────────
 * 두 플러그인은 스킬 이름 **31개**를 공유한다(`daily` `clarify` `delegation`
 * `principles` …). 측정:
 *   $ cd plugins && comm -12 <(ls artibot/skills|sort) <(ls artibot-cowork/skills|sort) | wc -l
 *   → 31
 * 래칫 베이스라인은 이름을 키로 쓰므로, 한정하지 않으면 `daily` 항목 하나가
 * **양쪽 플러그인의 위반을 동시에 면제**하고, 한쪽을 고치면 다른 쪽이 회귀로 보인다.
 * 그래서 `qualify()` 가 본체는 맨이름, 그 외는 `<root>/<name>` 으로 키를 만든다.
 *
 * ── 베이스라인은 **자라기만** 했다 (제거 0건 증명) ──────────────────────────
 * `check-unused-ratchet` 이 `node_modules` 부재 시 `Baseline tightened 59 → 0.
 * PASS.` 로 **자기 기준선을 파괴하며 통과**한 선례가 있다. cowork 를 편입하며
 * `--update-baseline` 을 돌렸으므로, 기존 85개가 조용히 날아가지 않았음을
 * 증명해야 이 게이트를 신뢰할 수 있다. 재현(리포 루트에서):
 *
 *   $ node -e "
 *     const {execSync}=require('child_process');
 *     for(const f of ['skill-lint-baseline.json','skill-redflags-baseline.json']){
 *       const p='plugins/artibot/scripts/ci/'+f;
 *       const o=new Set(JSON.parse(execSync('git show HEAD:'+p,{encoding:'utf8'})).skills);
 *       const n=new Set(require('./'+p).skills);
 *       console.log(f, 'HEAD='+o.size, 'now='+n.size,
 *         'removed='+[...o].filter(x=>!n.has(x)).length);
 *     }"
 *
 *   skill-lint-baseline.json:     HEAD=0  now=7   removed=0 added=7  addedAllCowork=true
 *   skill-redflags-baseline.json: HEAD=85 now=130 removed=0 added=45 addedAllCowork=true
 *
 * 아래 `사라진 항목은 실제로 해소된 것뿐이다` 테스트가 이 불변식을 HEAD 대조로
 * 강제한다 — 주석은 썩지만 테스트는 안 썩는다. (2026-08-22: 불변식을 "제거 0건"
 * 에서 "조용한 제거 0건"으로 정밀화 — 축소강제 게이트와의 충돌 해소. 해당
 * 테스트 위 주석 참조.)
 *
 * ── 이 게이트가 못 보는 것 ──────────────────────────────────────────────────
 *  1. **내용 품질을 보지 않는다.** frontmatter 계약과 줄 수만 본다. 설명이 실제로
 *     스킬을 잘 활성화시키는지는 R1 휴리스틱의 근사치일 뿐이다.
 *  2. **model-policy 는 여전히 본체 전용이다.** cowork 에이전트 12종은
 *     `artibot.config.json#/agents/modelPolicy` 로스터(28종)에 없다 — 이유는
 *     `scripts/validate.js` 상단 주석 참조. cowork 의 `model:` 드리프트는 미검증.
 *  3. **manifest / hooks / config 도 본체 전용이다.** cowork 는 설계상 훅이 없다.
 *  4. `MIN_ENTITY_COUNTS` 는 **하한**이지 정확한 재고가 아니다. 스킬이 46 → 41 로
 *     줄어도 통과한다. 정확한 수 주장은 `validate-readme-claims.js` 담당인데
 *     그쪽은 아직 cowork 를 세지 않는다(별건).
 *  5. **이 파일이 삭제되면 게이트도 사라진다.** vitest 파일 기반 게이트의 공통 한계.
 *
 * @module tests/firewall/cowork-skill-gates
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  assertEntityFloors,
  countByRoot,
  listAllSkillFiles,
  listEntityRoots,
  MIN_ENTITY_COUNTS,
  PRIMARY_ROOT,
  qualify,
} from '../../scripts/ci/skill-scan-roots.js';
import { collectAllSkillSizes, MAX_SKILL_LINES } from '../../scripts/ci/lint-skill-size.js';
import {
  lintDescription,
  lintEveryRoot,
  readBaseline,
  redFlagViolatingSkillNames,
  violatingSkillNames,
} from '../../scripts/ci/lint-skill-descriptions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');

const COWORK = 'artibot-cowork';

/**
 * 베이스라인에서 사라진 이름 중 **정당하지 않은** 것만 남긴다.
 *
 * 정당한 제거 = 그 스킬이 지금 위반하지 않는다(축소강제가 요구하는 화석 청소).
 * 정당하지 않은 제거 = 아직 위반 중인데 면제가 사라졌다 → 다음 회귀를 못 잡는다.
 * 판정을 함수로 빼둔 이유는 아래 `게이트 자기검증` 에서 같은 함수로 음성 대조를
 * 돌리기 위함이다 — 단언 안에 인라인으로 쓰면 자기검증이 동어반복이 된다.
 *
 * @param {string[]} headEntries - HEAD 커밋의 베이스라인 항목.
 * @param {Set<string>} nowEntries - 워킹트리 베이스라인 항목.
 * @param {Set<string>} currentViolators - 지금 실제로 위반 중인 이름.
 * @returns {string[]} 조용히 사라진(=부당한) 항목.
 */
function illegitimateRemovals(headEntries, nowEntries, currentViolators) {
  return headEntries.filter((n) => !nowEntries.has(n) && currentViolators.has(n));
}

describe('cowork is inside the skill/command/agent gates', () => {
  // ── 분모 (양성 대조) ──────────────────────────────────────────────────────
  // "위반 0건"이 "검사 0건"과 구분되려면 먼저 분모가 0이 아님을 증명해야 한다.
  describe('분모: 반드시 존재하는 것이 실제로 세어진다', () => {
    it('cowork 스킬이 세어진다', () => {
      const perRoot = countByRoot(listAllSkillFiles());
      expect(perRoot[COWORK]).toBeGreaterThanOrEqual(MIN_ENTITY_COUNTS[COWORK].skills);
      expect(perRoot[PRIMARY_ROOT]).toBeGreaterThanOrEqual(MIN_ENTITY_COUNTS[PRIMARY_ROOT].skills);
    });

    it.each(['commands', 'agents'])('cowork %s 디렉터리가 스캔 대상에 들어온다', (kind) => {
      const roots = listEntityRoots(kind).map((r) => r.name);
      expect(roots).toContain(COWORK);
      expect(roots).toContain(PRIMARY_ROOT);
    });

    it('세 스킬 게이트가 모두 같은 모집단을 본다 (한 곳만 편입되는 드리프트 차단)', () => {
      const discovered = listAllSkillFiles().length;
      expect(collectAllSkillSizes()).toHaveLength(discovered);
      expect(lintEveryRoot().results).toHaveLength(discovered);
    });
  });

  // ── 이름 충돌 ────────────────────────────────────────────────────────────
  describe('충돌하는 스킬 이름이 루트별로 구분된다', () => {
    it('두 플러그인이 실제로 이름을 공유한다 (이 전제가 깨지면 아래 단언은 공허하다)', () => {
      const byRoot = new Map();
      for (const { rootName, name } of listAllSkillFiles()) {
        if (!byRoot.has(rootName)) byRoot.set(rootName, new Set());
        byRoot.get(rootName).add(name);
      }
      const shared = [...byRoot.get(PRIMARY_ROOT)].filter((n) => byRoot.get(COWORK).has(n));
      expect(shared.length).toBeGreaterThan(0);
      expect(shared).toContain('daily');
    });

    it('키가 루트별로 유일하다', () => {
      const keys = listAllSkillFiles().map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('본체는 맨이름, 그 외는 접두어가 붙는다', () => {
      expect(qualify(PRIMARY_ROOT, 'daily')).toBe('daily');
      expect(qualify(COWORK, 'daily')).toBe(`${COWORK}/daily`);
    });
  });

  // ── 래칫 베이스라인 ──────────────────────────────────────────────────────
  describe('래칫 베이스라인이 cowork 를 한정된 키로 담는다', () => {
    it.each(['skill-lint-baseline.json', 'skill-redflags-baseline.json'])(
      '%s 에 cowork 항목이 접두어와 함께 들어있다',
      (file) => {
        const entries = readBaseline(join(PLUGIN_ROOT, 'scripts', 'ci', file));
        const cowork = entries.filter((n) => n.startsWith(`${COWORK}/`));
        expect(cowork.length).toBeGreaterThan(0);
        // 접두어 없는 항목은 전부 본체 스킬이어야 한다 — cowork 이름이 맨이름으로
        // 새어 들어가면 31개 충돌 이름에서 조용한 상호 면제가 생긴다.
        const bare = entries.filter((n) => !n.includes('/'));
        const mainNames = new Set(
          listAllSkillFiles().filter((s) => s.rootName === PRIMARY_ROOT).map((s) => s.name),
        );
        for (const n of bare) expect(mainNames.has(n)).toBe(true);
      },
    );

    // 지켜야 할 것은 "제거 0건"이 아니라 **조용한 제거 0건**이다. cowork 를
    // 더하며 돌린 `--update-baseline` 이 아직 위반 중인 항목을 지웠다면, 그
    // 스킬의 위반이 조용히 "고쳐진 것"으로 둔갑하고 다음 회귀를 잡지 못한다.
    //
    // 2026-08-22 개정: 원래 이 단언은 **모든** 제거를 금지했다. 같은 날
    // `lint-skill-descriptions.js#evaluateGates` 에 축소강제가 들어가면서
    // (베이스라인에 남은 화석 = FAIL, 해소책은 `--update-baseline`), 두 게이트가
    // 서로 충족 불가가 됐다 — 린터는 "지워라", 이 테스트는 "지우지 마라".
    // 게이트를 깎는 대신 불변식을 정확히 다시 썼다: 제거는 그 이름이 **지금
    // 위반하지 않을 때만** 정당하다. 막으려던 공격(위반이 살아있는데 베이스라인이
    // 날아감 = `check-unused-ratchet` 자기파괴 선례)은 그대로 FAIL 하고,
    // 정당한 축소만 통과한다.
    it.each([
      ['skill-lint-baseline.json', 'desc'],
      ['skill-redflags-baseline.json', 'redflag'],
    ])('%s 에서 사라진 항목은 실제로 해소된 것뿐이다 (조용한 제거 0건)', (file, kind) => {
      const rel = `plugins/artibot/scripts/ci/${file}`;
      // 실패를 삼키지 않는다. `git show` 가 죽었을 때 조용히 return 하면 이
      // 테스트는 통과하면서 아무것도 비교하지 않는다 — 정확히 이 파일이
      // 막으려는 종류의 공허한 그린이다.
      const head = JSON.parse(
        execFileSync('git', ['show', `HEAD:${rel}`], {
          cwd: join(PLUGIN_ROOT, '..', '..'),
          encoding: 'utf8',
          maxBuffer: 1024 * 1024 * 32,
        }),
      );
      expect(Array.isArray(head.skills)).toBe(true);
      const now = new Set(readBaseline(join(PLUGIN_ROOT, 'scripts', 'ci', file)));

      // 분모 먼저. 스캐너가 엉뚱한 곳을 보면 "현재 위반 0건"이 되어 **모든**
      // 제거가 정당해 보인다 — 이 단언 없이는 아래 검사가 fail-open 한다.
      const { results, perRoot } = lintEveryRoot();
      expect(assertEntityFloors('skills', perRoot)).toEqual([]);

      const current = new Set(
        kind === 'desc' ? violatingSkillNames(results) : redFlagViolatingSkillNames(results),
      );
      // 규칙 자기검증: 평가기가 죽으면 위반 0건이 되어 모든 제거가 정당해 보인다.
      // assertEntityFloors 는 population 만 보므로 이 구멍을 못 막는다.
      expect(lintDescription('Parses -> renders.').violations.some((v) => v.severity === 'error')).toBe(true);
      // 지금도 위반 중인데 베이스라인에서 사라진 이름 = 조용한 면제 취소.
      expect(illegitimateRemovals(head.skills, now, current)).toEqual([]);
    });
  });

  // ── 자기검증 / 음성 대조 ─────────────────────────────────────────────────
  // 위 단언들은 규칙이 실제로 위반을 잡을 때만 의미가 있다. 아래는 각 실패 모드를
  // 인위적으로 만들어 RED 가 나오는지 확인한다. 공유 워킹트리를 건드리지 않기 위해
  // 전부 순수 함수 입력으로 한다 (§10.5(a): 동시 편집 트리에서 파일을 변조하면
  // 다른 관측자가 그 창에서 잰 값을 플레이크로 오판한다).
  describe('게이트 자기검증', () => {
    it('아직 위반 중인 항목이 베이스라인에서 사라지면 FAIL 한다 (음성 대조)', () => {
      const head = ['still-violating', 'fossil'];
      const current = new Set(['still-violating']);
      // 베이스라인 통째 wipe = `check-unused-ratchet` 자기파괴 선례.
      expect(illegitimateRemovals(head, new Set(), current)).toEqual(['still-violating']);
    });

    it('해소된 항목의 제거는 통과시킨다 (축소강제와 충돌하지 않는다)', () => {
      const head = ['still-violating', 'fossil'];
      const current = new Set(['still-violating']);
      // 화석만 지운 상태 — 축소강제가 요구하는 바로 그 편집.
      expect(illegitimateRemovals(head, new Set(['still-violating']), current)).toEqual([]);
    });

    it('루트가 통째로 빠지면 분모 단언이 FAIL 한다', () => {
      const failures = assertEntityFloors('skills', { [PRIMARY_ROOT]: 113 });
      expect(failures.join('\n')).toMatch(/artibot-cowork/);
      expect(failures.length).toBeGreaterThan(0);
    });

    it('루트는 스캔됐지만 수가 하한 미달이면 FAIL 한다', () => {
      const failures = assertEntityFloors('skills', { [PRIMARY_ROOT]: 113, [COWORK]: 1 });
      expect(failures.join('\n')).toMatch(/below floor/);
    });

    it('모르는 루트가 나타나면 FAIL 한다 (새 플러그인이 무검사 0으로 통과하지 못한다)', () => {
      const failures = assertEntityFloors('skills', {
        [PRIMARY_ROOT]: 113,
        [COWORK]: 46,
        'artibot-newthing': 5,
      });
      expect(failures.join('\n')).toMatch(/artibot-newthing/);
      expect(failures.join('\n')).toMatch(/MIN_ENTITY_COUNTS/);
    });

    it('없다고 선언한 루트에서 항목이 발견되면 FAIL 한다', () => {
      const failures = assertEntityFloors('skills', { [PRIMARY_ROOT]: 113, [COWORK]: 46, _shared: 3 });
      expect(failures.join('\n')).toMatch(/_shared/);
    });

    it('현재 실측 분모는 통과한다 (위 FAIL 들이 항상-FAIL 이 아님을 증명)', () => {
      expect(assertEntityFloors('skills', countByRoot(listAllSkillFiles()))).toEqual([]);
    });

    it('줄 수 상한 규칙이 실제로 초과분을 잡는다', () => {
      const oversized = { key: `${COWORK}/__self_check__`, lines: MAX_SKILL_LINES + 1 };
      const withinLimit = { key: `${COWORK}/__self_check2__`, lines: MAX_SKILL_LINES };
      const over = [oversized, withinLimit].filter((s) => s.lines > MAX_SKILL_LINES);
      expect(over).toEqual([oversized]);
    });
  });

  // ── 배선 ────────────────────────────────────────────────────────────────
  // 게이트가 옳아도 아무도 부르지 않으면 아무 일도 일어나지 않는다.
  describe('배선', () => {
    it('skill:check 가 세 스크립트를 모두 부른다', () => {
      const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
      const chain = pkg.scripts['skill:check'];
      expect(chain).toContain('gen-skill-docs.js');
      expect(chain).toContain('lint-skill-descriptions.js');
      expect(chain).toContain('lint-skill-size.js');
      expect(pkg.scripts.ci).toContain('skill:check');
      expect(pkg.scripts.ci).toContain('scripts/validate.js');
    });
  });
});
