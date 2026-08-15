/**
 * 검사 목적: `plugins/artibot-cowork/scripts/` 가 **실제로 린트되는가**.
 *
 * ── 왜 필요했나 (2026-08-15 실측) ────────────────────────────────────────────
 * 이 리포의 ESLint 설정은 `plugins/artibot/eslint.config.js` **한 개뿐**이고,
 * flat config 의 `files` 패턴은 **base path 밖으로 나갈 수 없다**. base path 는
 * 설정 파일이 발견된 디렉터리(`-c` 를 쓰면 cwd)다. 그 결과 cowork 스크립트는
 * 어떤 린터도 거치지 않았다.
 *
 * ── 사각지대는 "침묵"이 아니라 "부재"였다 ────────────────────────────────────
 * ESLint 10.2.1 은 물어보면 **시끄럽게** 답한다. 아래는 전부 재현 명령이고,
 * 플래그를 하나라도 빼면 다른 결과가 나오므로 **그대로** 옮겨 적는다
 * (2026-08-15 측정, cwd=`plugins/artibot`, 바이너리=`./node_modules/.bin/eslint`):
 *
 *   $ ./node_modules/.bin/eslint ../artibot-cowork/scripts/
 *   → EXIT 2  "ESLint couldn't find an eslint.config.(js|mjs|cjs) file."
 *     설정 탐색은 cwd 가 아니라 **대상 경로**에서 위로 올라간다. 리포 루트에
 *     설정이 없어 실패한다.
 *
 *   $ ./node_modules/.bin/eslint -c eslint.config.js ../artibot-cowork/scripts/
 *   → EXIT 2  "all of the files matching the glob pattern … are ignored."
 *     안내문 마지막 줄이 해법까지 말해준다 — "If the file is ignored because it
 *     is located outside of the base path, change the location of your config
 *     file to be in a parent directory."
 *
 *   $ ./node_modules/.bin/eslint -c eslint.config.js ../artibot-cowork/scripts/ \
 *       --no-error-on-unmatched-pattern --format json
 *   → EXIT 0,  출력 `[]`
 *     **`--no-error-on-unmatched-pattern` 이 있어야 이 출력이 나온다.** 이 플래그를
 *     뺀 채 "exit 0 이었다"고 옮기면 다음 사람이 재현에 실패한다(실제로 이 주석의
 *     초안이 그 오류를 냈다).
 *
 *   $ ./node_modules/.bin/eslint -c eslint.config.js \
 *       ../artibot-cowork/scripts/release-lock.js --format json
 *   → EXIT 0,  warningCount=1,  ruleId=null
 *     "File ignored because outside of base path."
 *
 * 즉 **조용한 fail-open 이 아니었다.** 진짜 사각지대는 **아무도 cowork 경로를
 * ESLint 에 넘긴 적이 없다**는 것이다. CI 는 `plugins/artibot` 에서 `npx eslint .`
 * 를 돌리는데(`.github/workflows/ci.yml` 의 "Run ESLint" 스텝) 그 890 파일 중
 * cowork 파일은 **0개**다. `calculateConfigForFile()` 에 cowork 경로를 주면
 * `undefined` 가 나온다.
 *
 * 그 부재 안에서 2026-08-15 에 `release-lock.js` 결함 2건 수정이 이루어졌다. 그
 * 수정본을 처음 린트에 통과시켰을 때 위반 2건이 나왔다(consistent-return 1,
 * sort-imports 1).
 *
 * **다만 exit 0 을 신뢰하지 않는 규율 자체는 유지한다.** 위 세 번째 전사가 보여주듯
 * 플래그 조합에 따라 exit 0 + 빈 출력이 실제로 나오고, 그때 "통과"와 "검사 파일
 * 0개"는 구분되지 않는다. 아래 분모 단언이 그 구분을 강제한다.
 *
 * ── 왜 CLI 가 아니라 Node API 인가 ──────────────────────────────────────────
 * 두 플러그인을 **모두** 담는 base path 는 리포 루트뿐인데, 리포 루트에는
 * `node_modules` 가 없다(측정 시각 기준 0개). 루트에 설정 파일을 두면 그 설정이
 * `@eslint/js`·`globals` 를 import 할 수 없고, `npx eslint` 는 핀 고정된 10.2.1 이
 * 아닌 다른 버전을 네트워크에서 받아온다(2026-08-15 실측 10.8.1 — 이 숫자는 시간이
 * 지나면 달라진다. 요점은 "핀과 다르다"이지 특정 버전이 아니다). `-c` 로 루트 설정을 가리키는
 * 우회도 통하지 않는다 — `-c` 는 base path 를 **설정 파일 위치가 아니라 cwd** 로
 * 잡기 때문이다(샌드박스 실측: cwd=하위 디렉터리 + 루트 설정 → files_examined=0).
 *
 * ESLint Node API 는 `cwd` 를 인자로 받으므로 이 셋을 동시에 만족한다: base path =
 * 리포 루트, 모듈 해석 = `plugins/artibot/node_modules`, 버전 = 핀 고정 10.2.1.
 *
 * 규칙은 `eslint.shared-rules.js` 에서 가져온다. 복사본을 두면 한쪽만 조여졌을 때
 * 다른 쪽이 조용히 느슨해진다.
 *
 * ── 이 게이트가 못 보는 것 ──────────────────────────────────────────────────
 *  1. **`plugins/artibot-cowork/scripts/` 밖은 보지 않는다.** cowork 의 다른 곳에
 *     `.js` 가 생기면 그 파일은 여전히 린트 밖이다. 측정 시각 기준 cowork 전체의
 *     JS 파일은 이 디렉터리의 2개가 전부라서 범위를 넓히지 않았다.
 *  2. **실행하지 않는다.** 파싱과 규칙 위반만 본다. 스크립트가 실제로 동작하는지는
 *     `cowork-release-lock-safety.test.js` 와도 별개로 여전히 미검증이다.
 *  3. `eslint.config.js` 쪽 레이어 규칙(no-restricted-imports)은 여기 포함되지
 *     않는다. cowork 에는 5-Layer 구조가 없다.
 *  4. **이 파일이 삭제되면 게이트도 사라진다.** vitest 파일 기반 게이트의 공통
 *     한계이고, 이 리포의 다른 firewall 테스트도 같다.
 *
 * @module tests/firewall/cowork-scripts-lint
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { SCRIPT_RULES } from '../../eslint.shared-rules.js';
import { fileURLToPath } from 'node:url';
import globals from 'globals';
import js from '@eslint/js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `<repo>/plugins/artibot/tests/firewall` 에서 네 단계 위가 리포 루트다. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/**
 * ESLint 에 넘기는 패턴이자, 이 게이트가 책임지는 범위. 리포 루트 기준 상대경로여야
 * 한다(base path 가 리포 루트이므로).
 */
const COWORK_SCRIPTS_GLOB = 'plugins/artibot-cowork/scripts';

const COWORK_SCRIPTS_DIR = join(REPO_ROOT, 'plugins', 'artibot-cowork', 'scripts');

/**
 * ESLint 와 **독립적으로** 대상 파일을 센다. 이 수가 분모다. ESLint 가 0개를
 * 검사하고 exit 0 을 내는 것이 원래의 결함이었으므로, "몇 개를 봤는지"를 외부
 * 관측치와 대조하지 않으면 이 게이트도 같은 방식으로 조용히 비어버린다.
 */
function listLintableScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listLintableScripts(full));
    } else if (/\.(js|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** 게이트 본체와 자기검증이 **같은** 설정을 쓰도록 한 곳에서 만든다. */
function createLinter() {
  return new ESLint({
    cwd: REPO_ROOT,
    // 설정 파일 탐색을 끈다. 켜두면 리포 루트에서 위로 올라가다 리포 밖 설정을
    // 주워올 수 있고, 그러면 결과가 개발자 머신마다 달라진다.
    overrideConfigFile: true,
    baseConfig: [
      js.configs.recommended,
      {
        files: [`${COWORK_SCRIPTS_GLOB}/**/*.{js,mjs}`],
        languageOptions: {
          ecmaVersion: 2022,
          sourceType: 'module',
          globals: { ...globals.node },
        },
        rules: SCRIPT_RULES,
      },
    ],
  });
}

function tally(results) {
  return results.reduce(
    (acc, file) => ({
      errors: acc.errors + file.errorCount,
      warnings: acc.warnings + file.warningCount,
    }),
    { errors: 0, warnings: 0 },
  );
}

describe('artibot-cowork/scripts is covered by ESLint', () => {
  it('린트 대상 파일이 존재한다 (분모가 0이면 아래 단언은 공허하다)', () => {
    expect(listLintableScripts(COWORK_SCRIPTS_DIR).length).toBeGreaterThan(0);
  });

  it('ESLint 가 대상 파일을 **전부** 검사한다 (fail-open 방지)', async () => {
    const expected = listLintableScripts(COWORK_SCRIPTS_DIR).sort();
    const results = await createLinter().lintFiles([COWORK_SCRIPTS_GLOB]);
    const examined = results.map((r) => r.filePath).sort();

    // 경로 비교는 구분자 정규화 후에 한다 (Windows 는 `\`, 패턴은 `/`).
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
    expect(examined.map(norm)).toEqual(expected.map(norm));
  });

  it('위반이 0건이다 (경고 포함 — 본 리포 린트는 --max-warnings=0)', async () => {
    const results = await createLinter().lintFiles([COWORK_SCRIPTS_GLOB]);
    const found = tally(results);
    const detail = results
      .flatMap((r) =>
        r.messages.map(
          (m) => `${r.filePath}:${m.line}:${m.column} sev${m.severity} ${m.ruleId ?? '(parse)'} ${m.message}`,
        ),
      )
      .join('\n');
    expect(detail).toBe('');
    expect(found).toEqual({ errors: 0, warnings: 0 });
  });

  // ── 자기검증 ────────────────────────────────────────────────────────────
  // 위의 "0건"은 규칙이 실제로 켜져 있을 때만 의미가 있다. 설정이 비거나 `files`
  // 패턴이 어긋나 파일이 매칭되지 않으면 위반 0건과 구분되지 않는다. 아래 두 개는
  // 그 두 경우를 각각 RED 로 만든다.
  describe('게이트 자기검증', () => {
    it('cowork 경로의 규칙 위반을 실제로 잡는다', async () => {
      const results = await createLinter().lintText('var x = 1;\nif (x == 1) x = 2;\n', {
        filePath: join(COWORK_SCRIPTS_DIR, '__self_check__.js'),
      });
      const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId));
      expect(ruleIds).toContain('no-var');
      expect(ruleIds).toContain('eqeqeq');
    });

    it('구문 오류를 잡는다 (`node --check` 가 놓치는 영역)', async () => {
      // `node --check` 는 모듈 타입이 모호한 `.js`(가장 가까운 package.json 에
      // `type` 이 없는 경우)에서 구문 오류를 **조용히 통과시킨다** — Node 22.19.0
      // 실측: `import` 를 포함한 깨진 파일에 대해 exit 0, 출력 없음. 이 리포는
      // 루트 package.json 이 `"type": "module"` 이라 현재는 걸리지 않지만, 그
      // 한 줄에 의존하는 방어선이다. ESLint 는 파싱 오류를 fatal 로 낸다.
      const results = await createLinter().lintText('import x from "node:fs";\nconst y = (\n', {
        filePath: join(COWORK_SCRIPTS_DIR, '__self_check_syntax__.js'),
      });
      expect(results.flatMap((r) => r.messages).some((m) => m.fatal)).toBe(true);
    });
  });
});
