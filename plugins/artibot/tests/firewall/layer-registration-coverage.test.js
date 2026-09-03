/**
 * 5-Layer eslint 게이트의 **등록 커버리지** — allowlist 누락으로 인한 fail-open 차단.
 *
 * ── 왜 이 파일이 있는가 ─────────────────────────────────────────────────────
 * `eslint.config.js` 의 레이어 규칙은 경로 allowlist(`files[]`)로 적용된다.
 * 즉 새 `lib/<x>/` 디렉터리를 만들고 어느 블록에도 넣지 않으면, 그 디렉터리에는
 * **레이어 규칙이 0개 적용된다.** eslint 는 아무 말도 하지 않는다 — "규칙 위반
 * 없음"과 "규칙이 아예 없음"이 똑같이 조용하기 때문이다. 이것이 부정 목록이
 * 아니라 허용 목록을 쓰는 게이트의 고유 실패 모드다.
 *
 * 실측(2026-08-22, master fa3ef15e): `lib/*` 1-depth 25개 중 23개가 L1~L4 에
 * 등록돼 있고, `runtime`(L5 = 최상위라 제한할 상위 레이어가 없음)과 **`genesis`**
 * 가 미등록이었다. genesis 는 설계상 면제가 아니라 그냥 빠진 것이었고, 이 게이트를
 * 켜면서 L2 에 등록했다(사유는 `eslint.config.js` L2 블록 주석).
 *
 * ── 이 게이트가 못 보는 것 ──────────────────────────────────────────────────
 *  1. **등록된 레이어가 "올바른" 레이어인지는 못 본다.** `lib/cognitive` 를 L2 로
 *     잘못 등록해도 여기서는 통과한다. 판정은 여전히 사람이 한다 — 이 게이트가
 *     막는 것은 오배치가 아니라 **무배치**다.
 *  2. ~~**규칙의 내용을 못 본다.**~~ — 2026-09-02 에 부분적으로 닫았다. 아래
 *     `상위 레이어 금지 열거 완전성` 이 각 블록의 `group` 을 **다른 블록의 files[]**
 *     로부터 유도해 대조한다. 즉 "등록은 됐는데 그 위 레이어에서 금지되지 않은
 *     디렉터리" 는 이제 red 다. 실측 계기: L1 이 상위 24 개 중 `supervisor` 를,
 *     L2 가 L3 의 `handoff` 를 각각 빠뜨리고 있었다(둘 다 이 검사로 발견).
 *     **여전히 못 보는 것**: `message` 문구, `group` 이외의 규칙 옵션, 그리고
 *     레이어 순서 자체(블록 배열 순서 = 레이어 순서라는 전제는 아래에서 앵커로
 *     고정하지만, 그 앵커가 옳은 순서인지는 사람이 판단한다).
 *  3. **1-depth 만 본다.** `lib/a/b/` 는 `lib/a/**` 에 포함되므로 별도 등록 대상이
 *     아니지만, 만약 서브디렉터리가 독립 레이어여야 한다면 그 판단은 못 한다.
 *  4. **eslint 가 실제로 이 config 를 적용하는지는 못 본다.** config 객체를 읽을
 *     뿐 lint 를 돌리지 않는다. 그 확인은 `npm run lint` 의 몫이다.
 *  5. **등록됐지만 아직 없는 디렉터리는 못 본다 — 의도된 방향이다.** 2026-09-02
 *     (PRD T-10)에 v5 Phase 0 신규 11 개가 파일 생성 **전에** 등록됐다. 존재하지
 *     않는 경로를 가리키는 glob 은 eslint 에서 무해하고, 반대 순서(생성 먼저)는
 *     그 디렉터리가 레이어 규칙 0개로 린트되는 창을 만든다. 그래서 "등록됐으나
 *     디스크에 없음" 은 통과이고, **"디스크에 있는데 미등록" 은 여전히 red** 다
 *     — 완화는 미래 방향으로만 열려 있고 fail-open 방향으로는 닫혀 있다.
 *
 * @module tests/firewall/layer-registration-coverage
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import eslintConfig from '../../eslint.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const LIB_DIR = join(PLUGIN_ROOT, 'lib');

/**
 * 레이어 규칙 블록 = `files[]` 로 대상을 좁히면서 `no-restricted-imports` 를 거는
 * config 항목. 2026-08-22 기준 정확히 4개(L1~L4)다. L5(runtime)는 최상위라
 * 금지할 상위 레이어가 없어 블록 자체가 없는 것이 정상이다.
 */
const LAYER_BLOCKS = eslintConfig.filter(
  (block) => Array.isArray(block?.files) && block?.rules?.['no-restricted-imports'],
);

/**
 * 레이어 등록이 면제되는 `lib/*` 1-depth 디렉터리.
 *
 * `runtime` = L5. 5-Layer 규약이 "상위는 하위만 import 한다"이므로 최상위에는
 * 금지할 상위가 없다 → 제한 블록이 없는 것이 설계상 정상이며 누락이 아니다.
 * (`plugins/artibot/CLAUDE.md#5-Layer Architecture` 표의 Layer 5 행)
 *
 * **여기에 이름을 추가하는 것은 게이트를 끄는 행위다.** 새 디렉터리가 RED 로
 * 잡히면 기본 처분은 "적절한 레이어에 등록"이고, 면제는 L5 처럼 구조적으로
 * 제한 블록이 존재할 수 없을 때만이다.
 *
 * @type {Set<string>}
 */
const EXEMPT = new Set(['runtime']);

/** 스캔이 아무것도 못 찾았을 때 통과하지 않도록 하는 분모 하한(실측 25). */
const MIN_LIB_DIRS = 20;

/**
 * `lib/` 바로 아래 디렉터리 이름 목록.
 *
 * @returns {string[]} 정렬된 1-depth 디렉터리 이름.
 */
function listLibDirs() {
  return readdirSync(LIB_DIR)
    .filter((name) => statSync(join(LIB_DIR, name)).isDirectory())
    .sort();
}

/**
 * 한 디렉터리를 대상으로 삼는 레이어 블록의 인덱스 목록.
 *
 * 판정을 순수 함수로 빼둔 이유는 아래 `게이트 자기검증` 에서 **같은 함수**에
 * 가상 입력(등록 하나를 제거한 blocks)을 넣어 RED 를 확인하기 위함이다.
 * 단언 안에 인라인으로 쓰면 자기검증이 동어반복이 된다.
 *
 * @param {string} dir - `lib/` 1-depth 디렉터리 이름.
 * @param {Array<{files: string[]}>} blocks - 레이어 블록 목록.
 * @returns {number[]} 매칭된 블록 인덱스.
 */
export function blocksRegistering(dir, blocks) {
  const prefix = `lib/${dir}/`;
  const hits = [];
  blocks.forEach((block, i) => {
    const matched = block.files.some((p) => typeof p === 'string' && p.startsWith(prefix));
    if (matched) hits.push(i);
  });
  return hits;
}

/**
 * 한 레이어 블록이 `files[]` 로 **등록**하는 `lib/` 1-depth 디렉터리 집합.
 *
 * 디스크가 아니라 config 에서 유도한다는 점이 중요하다: 아직 생성되지 않은
 * 디렉터리(T-10 의 신규 11 개)도 등록돼 있으면 여기 잡히고, 따라서 상위 레이어의
 * 금지 열거에 있어야 한다는 요구도 지금 걸린다 — 디렉터리가 생기는 순간이 아니라.
 *
 * @param {{files?: unknown[]}} block - 레이어 블록.
 * @returns {Set<string>} 등록된 디렉터리 이름 집합.
 */
export function registeredDirs(block) {
  const dirs = new Set();
  for (const pattern of block?.files ?? []) {
    if (typeof pattern !== 'string') continue;
    const m = /^lib\/([^/]+)\//.exec(pattern);
    if (m) dirs.add(m[1]);
  }
  return dirs;
}

/**
 * 한 레이어 블록이 `no-restricted-imports` 로 **금지**하는 디렉터리 이름 집합.
 *
 * `'**\/<name>/**'` 형태만 이름으로 환원한다. 다른 형태의 패턴이 섞이면 조용히
 * 무시하는 대신 그대로 남겨 두는데(아래 죽은-항목 검사가 그것을 잡는다), 이는
 * 파서가 못 읽은 항목이 "금지돼 있다"로 오독되는 쪽보다 안전하기 때문이다.
 *
 * @param {{rules: Record<string, unknown[]>}} block - 레이어 블록.
 * @returns {string[]} 금지 group 원문 항목.
 */
export function forbiddenPatterns(block) {
  const [, options] = block.rules['no-restricted-imports'];
  return options.patterns.flatMap((p) => p.group);
}

/**
 * `'**\/name/**'` → `'name'`. 그 형태가 아니면 null.
 *
 * @param {string} pattern - group 항목.
 * @returns {string|null} 디렉터리 이름.
 */
export function patternToDir(pattern) {
  const m = /^\*\*\/([^/*]+)\/\*\*$/.exec(pattern);
  return m ? m[1] : null;
}

/**
 * 블록 i 가 금지해야 하는 디렉터리 = 자기보다 위 레이어 블록들이 등록한 전부
 * + `runtime`(L5 는 최상위라 자기 블록이 없다 — §EXEMPT 와 같은 사유).
 *
 * @param {number} index - 블록 인덱스(= 레이어 순서, 아래 앵커 테스트로 고정).
 * @param {Array<object>} blocks - 레이어 블록 목록.
 * @returns {Set<string>} 금지 대상 디렉터리 이름.
 */
export function requiredForbidden(index, blocks) {
  const required = new Set(['runtime']);
  for (let j = index + 1; j < blocks.length; j += 1) {
    for (const dir of registeredDirs(blocks[j])) required.add(dir);
  }
  return required;
}

/**
 * 금지 열거의 구멍 = "위 레이어에 등록됐는데 이 블록이 금지하지 않는" 디렉터리.
 *
 * 단언 안에 인라인으로 두지 않는 이유는 `blocksRegistering` 과 같다: 아래
 * `게이트 자기검증` 이 **바로 이 함수**에 구멍을 낸 가상 blocks 를 넣어 red 를
 * 확인해야 하기 때문이다. 단언과 자기검증이 서로 다른 코드를 보면, 자기검증이
 * 그린인 것은 단언이 살아있다는 증거가 되지 못한다.
 *
 * @param {Array<object>} blocks - 레이어 블록 목록(배열 순서 = 레이어 순서).
 * @returns {string[]} 사람이 읽을 수 있는 구멍 설명. 빈 배열이면 완전하다.
 */
export function findForbidGaps(blocks) {
  const gaps = [];
  blocks.forEach((block, i) => {
    const forbidden = new Set(forbiddenPatterns(block).map(patternToDir).filter(Boolean));
    for (const dir of requiredForbidden(i, blocks)) {
      if (!forbidden.has(dir)) gaps.push(`block ${i} 이 ${dir} 을 금지하지 않음`);
    }
  });
  return gaps;
}

describe('5-Layer eslint 게이트: lib/* 등록 커버리지', () => {
  // ── fail-closed 전제 ──────────────────────────────────────────────────────
  // 아래 단언들이 의미를 가지려면 (a) config 를 실제로 읽었고 (b) 디렉터리를
  // 실제로 열거했어야 한다. 둘 중 하나가 0 이면 "위반 0건"은 "검사 0건"의 다른
  // 이름이다 — 그래서 0 은 통과가 아니라 실패다.
  it('config 와 디렉터리 열거가 둘 다 비어있지 않다 (fail-closed 분모)', () => {
    expect(Array.isArray(eslintConfig)).toBe(true);
    expect(eslintConfig.length).toBeGreaterThan(0);
    expect(LAYER_BLOCKS.length).toBeGreaterThanOrEqual(4);
    expect(listLibDirs().length).toBeGreaterThanOrEqual(MIN_LIB_DIRS);
  });

  it('모든 lib/* 1-depth 디렉터리는 정확히 한 레이어 블록에 등록되거나 명시 면제다', () => {
    const unregistered = [];
    const doubleRegistered = [];
    for (const dir of listLibDirs()) {
      const hits = blocksRegistering(dir, LAYER_BLOCKS);
      if (EXEMPT.has(dir)) continue;
      if (hits.length === 0) unregistered.push(dir);
      // 두 블록에 걸리면 서로 다른 두 레이어 규칙이 동시에 적용된다 — 어느 쪽이
      // 의도인지 config 만 봐서는 알 수 없으므로 이것도 결함이다.
      if (hits.length > 1) doubleRegistered.push(`${dir} (blocks ${hits.join(',')})`);
    }
    expect(
      unregistered,
      '레이어 미등록 = 그 디렉터리에 레이어 규칙 0개 적용(fail-open). ' +
        'eslint.config.js 의 알맞은 files[] 에 추가하라. 면제 확대는 마지막 수단이다.',
    ).toEqual([]);
    expect(doubleRegistered, '한 디렉터리가 두 레이어 블록에 동시에 등록됨').toEqual([]);
  });

  it('면제 allowlist 는 실제로 미등록인 것만 담는다 (죽은 면제 금지)', () => {
    const libDirs = new Set(listLibDirs());
    for (const dir of EXEMPT) {
      // 면제 대상이 사라졌거나(디렉터리 삭제) 실은 등록돼 있다면(면제 불필요),
      // 그 항목은 아무도 안 읽는 화석이 된다.
      expect(libDirs.has(dir), `면제 목록의 '${dir}' 가 lib/ 에 없다`).toBe(true);
      expect(
        blocksRegistering(dir, LAYER_BLOCKS),
        `'${dir}' 는 면제 목록에 있는데 실제로는 등록돼 있다 — 면제를 지워라`,
      ).toEqual([]);
    }
  });

  it('genesis 가 L2 에 등록되어 있다 (2026-08-22 발견분 회귀 가드)', () => {
    // 이 단언은 위 일반 규칙과 중복처럼 보이지만 목적이 다르다: 일반 규칙은
    // "어딘가에 등록"만 보고, 이것은 그때 내린 배치 판정 자체를 고정한다.
    const hits = blocksRegistering('genesis', LAYER_BLOCKS);
    expect(hits).toHaveLength(1);
    const block = LAYER_BLOCKS[hits[0]];
    const groups = block.rules['no-restricted-imports'][1].patterns.flatMap((p) => p.group);
    // L2 = learning(L3)/cognitive(L4)/runtime(L5) 를 금지하는 블록.
    expect(groups).toContain('**/learning/**');
    expect(groups).toContain('**/cognitive/**');
    expect(groups).toContain('**/runtime/**');
  });

  // ── 상위 레이어 금지 열거 완전성 (E-01) ────────────────────────────────────
  // 등록(files[])과 금지(group[])는 손으로 유지하는 **서로 다른 두 목록**이고,
  // 한쪽만 갱신해도 config 는 유효하고 lint 는 조용하다. 그 침묵이 곧 구멍이다:
  // 하위 레이어의 금지 목록에서 빠진 디렉터리는 그 하위가 자유롭게 import 할 수
  // 있는 디렉터리다. 여기서는 금지 목록을 **다른 블록의 등록에서 유도**해 대조한다
  // — 손목록끼리 비교하면 둘 다 틀렸을 때 그린이 되기 때문이다.
  describe('상위 레이어 금지 열거 완전성', () => {
    // 아래 검사들은 "배열 순서 = 레이어 순서"를 전제한다. 전제를 검사 없이 쓰면
    // 블록을 재배치하는 순간 검사가 조용히 뒤집히므로, 먼저 못박는다.
    it('블록 배열 순서가 레이어 순서와 일치한다 (일반 검사의 전제)', () => {
      expect(LAYER_BLOCKS).toHaveLength(4);
      expect([...registeredDirs(LAYER_BLOCKS[0])].sort()).toEqual(['core', 'utils']);
      expect(registeredDirs(LAYER_BLOCKS[1]).has('adapters')).toBe(true);
      expect([...registeredDirs(LAYER_BLOCKS[2])].sort()).toEqual(['handoff', 'learning']);
      expect([...registeredDirs(LAYER_BLOCKS[3])].sort()).toEqual(['cognitive', 'topology']);
    });

    it('각 블록은 자기보다 위 레이어에 등록된 디렉터리를 전부 금지한다', () => {
      const gaps = findForbidGaps(LAYER_BLOCKS);
      expect(
        gaps,
        '등록만 되고 하위 레이어의 금지 열거에 없는 디렉터리 = 그 하위가 상위를 ' +
          'import 해도 규칙 0개(fail-open). eslint.config.js 의 해당 group 에 ' +
          "'**/<name>/**' 을 추가하라. 실측 2026-09-02 에 이 검사가 L1 의 " +
          'supervisor 누락과 L2 의 handoff 누락을 잡았다.',
      ).toEqual([]);
    });

    it('금지 열거에 죽은 항목이 없다 (등록되지 않은 이름을 금지하지 않는다)', () => {
      const dead = [];
      LAYER_BLOCKS.forEach((block, i) => {
        const required = requiredForbidden(i, LAYER_BLOCKS);
        for (const pattern of forbiddenPatterns(block)) {
          const dir = patternToDir(pattern);
          // 형태를 못 읽은 항목도 화석 후보다 — 조용히 통과시키지 않는다.
          if (dir === null) dead.push(`block ${i}: 해석 불가 패턴 ${pattern}`);
          else if (!required.has(dir)) dead.push(`block ${i}: ${dir}`);
        }
      });
      expect(
        dead,
        '어느 상위 블록에도 등록되지 않은 이름을 금지하고 있다 — 디렉터리가 사라졌거나 ' +
          "레이어가 바뀐 흔적이다. 남겨두면 다음 사람이 '이미 다 열거돼 있다'고 " +
          '오독하는 근거가 된다.',
      ).toEqual([]);
    });
  });

  // ── v5 Phase 0 신규 11 디렉터리 배치 고정 (2026-09-02, PRD T-10) ───────────
  // 위 완전성 검사는 "등록됐다면 금지도 돼 있다"만 본다. 어느 레이어에 등록됐는지는
  // 보지 않으므로, 설계 §1-8 이 내린 배치 판정은 여기서 따로 고정한다.
  describe('v5 Phase 0 신규 디렉터리 배치', () => {
    const NEW_L2 = [
      'checkpoint', 'economics', 'mission', 'project-state', 'recovery',
      'replay', 'review', 'routing', 'scorecard', 'verification',
    ];

    it.each(NEW_L2)('%s 는 L2 에 등록되어 있다', (dir) => {
      expect(registeredDirs(LAYER_BLOCKS[1]).has(dir)).toBe(true);
    });

    it('topology 는 L4 에 등록되어 있다 (cognitive 소비자라 L2 가 될 수 없다)', () => {
      expect(registeredDirs(LAYER_BLOCKS[3]).has('topology')).toBe(true);
      expect(registeredDirs(LAYER_BLOCKS[1]).has('topology')).toBe(false);
    });

    it('신규 11 개가 전부 L1 금지 열거에 있다 (E-01 회귀 가드)', () => {
      const l1 = new Set(forbiddenPatterns(LAYER_BLOCKS[0]).map(patternToDir));
      for (const dir of [...NEW_L2, 'topology']) {
        expect(l1.has(dir), `L1 금지 열거에 ${dir} 없음`).toBe(true);
      }
    });

    it('supervisor 가 L1 금지 열거에 있다 (E-01 발견분 회귀 가드)', () => {
      // 2026-09-02 이전 실측: L2 files[] 에는 등록돼 있는데 L1 group 에는 없어서
      // lib/core 가 ../supervisor/* 를 import 해도 아무 규칙도 걸리지 않았다.
      expect(registeredDirs(LAYER_BLOCKS[1]).has('supervisor')).toBe(true);
      expect(
        forbiddenPatterns(LAYER_BLOCKS[0]).map(patternToDir).includes('supervisor'),
      ).toBe(true);
    });
  });

  // ── 게이트 자기검증 (음성 대조) ────────────────────────────────────────────
  // 위 단언은 규칙이 실제로 위반을 잡을 때만 의미가 있다. 공유 워킹트리의
  // eslint.config.js 를 변조하지 않기 위해 전부 순수 함수 입력으로 한다
  // (§10.5(a): 동시 편집 트리를 건드리면 다른 관측자가 그 창에서 잰 값을
  // 플레이크로 오판한다).
  describe('게이트 자기검증', () => {
    it('등록을 가상으로 제거하면 미등록으로 잡힌다', () => {
      const stripped = LAYER_BLOCKS.map((b) => ({
        ...b,
        files: b.files.filter((p) => !(typeof p === 'string' && p.startsWith('lib/genesis/'))),
      }));
      expect(blocksRegistering('genesis', stripped)).toEqual([]);
      // 그리고 실제 config 에서는 잡히지 않는다 — 뮤테이션이 적용됐음을 증명하는
      // 양성/음성 쌍(둘 다 []이면 함수가 죽은 것이지 게이트가 그린인 게 아니다).
      expect(blocksRegistering('genesis', LAYER_BLOCKS)).toHaveLength(1);
    });

    it('두 블록에 등록된 입력은 중복 등록으로 잡힌다', () => {
      const doubled = [
        { files: ['lib/genesis/**/*.js'] },
        { files: ['lib/genesis/**/*.js'] },
      ];
      expect(blocksRegistering('genesis', doubled)).toEqual([0, 1]);
    });

    it('접두어 일치는 디렉터리 경계를 지킨다 (lib/gen 이 lib/genesis 를 가리지 않는다)', () => {
      const decoy = [{ files: ['lib/gen/**/*.js'] }];
      expect(blocksRegistering('genesis', decoy)).toEqual([]);
      expect(blocksRegistering('gen', decoy)).toEqual([0]);
    });

    // 완전성 검사도 같은 대우를 받는다: 실제 config 에서 group 항목 하나를 지운
    // 가상 입력이 red 가 되는지 본다. 이것이 없으면 "gaps 가 비었다"가 "검사가
    // 죽었다"의 다른 이름일 수 있다.
    it('금지 항목을 가상으로 제거하면 완전성 검사가 잡는다', () => {
      const strip = (block, name) => ({
        ...block,
        rules: {
          'no-restricted-imports': [
            'error',
            {
              patterns: [
                {
                  group: forbiddenPatterns(block).filter(
                    (p) => patternToDir(p) !== name,
                  ),
                },
              ],
            },
          ],
        },
      });
      // 실제 blocks 를 복사해 L1 에서 supervisor 금지만 뺀다 — 2026-09-02 이전의
      // 실제 상태를 그대로 재현한 입력이다. 공유 워킹트리의 eslint.config.js 는
      // 건드리지 않는다(§10.5(a): 동시 편집 트리를 변조하면 다른 관측자가 그 창에서
      // 잰 값을 플레이크로 오판한다).
      const mutated = [strip(LAYER_BLOCKS[0], 'supervisor'), ...LAYER_BLOCKS.slice(1)];
      const gaps = findForbidGaps(mutated);
      expect(gaps).toEqual(['block 0 이 supervisor 을 금지하지 않음']);
      // 양성/음성 쌍: 실제 config 에서는 같은 함수가 빈 배열을 낸다. 둘 다 []이면
      // 함수가 죽은 것이지 게이트가 그린인 게 아니다.
      expect(findForbidGaps(LAYER_BLOCKS)).toEqual([]);
      expect(
        forbiddenPatterns(LAYER_BLOCKS[0]).map(patternToDir).includes('supervisor'),
      ).toBe(true);
    });

    it('requiredForbidden 은 위 레이어만 모은다 (아래·자기 자신은 요구하지 않는다)', () => {
      const fake = [
        { files: ['lib/a/**/*.js'] },
        { files: ['lib/b/**/*.js'] },
        { files: ['lib/c/**/*.js'] },
      ];
      expect([...requiredForbidden(0, fake)].sort()).toEqual(['b', 'c', 'runtime']);
      expect([...requiredForbidden(1, fake)].sort()).toEqual(['c', 'runtime']);
      expect([...requiredForbidden(2, fake)].sort()).toEqual(['runtime']);
    });

    it('patternToDir 는 이름 형태만 환원한다', () => {
      expect(patternToDir('**/supervisor/**')).toBe('supervisor');
      expect(patternToDir('**/project-state/**')).toBe('project-state');
      expect(patternToDir('lib/supervisor/**')).toBeNull();
      expect(patternToDir('**/a/b/**')).toBeNull();
    });
  });
});
