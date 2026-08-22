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
 *  2. **규칙의 내용을 못 본다.** 어떤 블록의 `group` 목록에서 상위 레이어 하나를
 *     지워도 files[] 등록은 그대로라 여기서는 그린이다.
 *  3. **1-depth 만 본다.** `lib/a/b/` 는 `lib/a/**` 에 포함되므로 별도 등록 대상이
 *     아니지만, 만약 서브디렉터리가 독립 레이어여야 한다면 그 판단은 못 한다.
 *  4. **eslint 가 실제로 이 config 를 적용하는지는 못 본다.** config 객체를 읽을
 *     뿐 lint 를 돌리지 않는다. 그 확인은 `npm run lint` 의 몫이다.
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
  });
});
