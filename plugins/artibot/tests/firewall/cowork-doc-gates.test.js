/**
 * 검사 목적: `docs:check` 의 두 게이트가 **`plugins/artibot-cowork/` 를 실제로 스캔하는가**.
 *
 * ── 왜 필요했나 (2026-08-16 실측) ────────────────────────────────────────────
 * `validate-doc-links.js` 와 `validate-md-rendering.js` 는 둘 다 스캔 루트를
 * `getPluginRoot()` **한 개**로 고정하고 있었다. `getPluginRoot()` 는 언제나
 * `plugins/artibot` 를 가리키므로 cowork 트리의 문서는 어느 게이트도 거치지 않았다.
 * 확장 전 두 게이트의 출력은 각각 `PASS: 349 documentation file(s)` /
 * `Markdown rendering clean (349 files, 2 rules)` 였고, 그 349 중 cowork 파일은
 * **0개**였다. 즉 cowork 문서에 깨진 링크를 심어도 `docs:check` 는 그린이었다.
 *
 * ── 이 테스트가 지키는 것 ───────────────────────────────────────────────────
 * "0 broken" 과 "0 files examined" 는 같은 출력이다. 아래 단언들은 그 둘을
 * 분리한다. 리포 레이아웃에서 **독립적으로** 센 파일 수를 분모로 삼아, 스캐너가
 * 보고한 수와 대조한다. 스캐너 자신의 헬퍼로 분모를 구하면 스캐너가 조용히
 * 비어버렸을 때 그 사실을 볼 수 없다.
 *
 * ── 이 게이트가 못 보는 것 ──────────────────────────────────────────────────
 *  1. **문서의 내용 품질은 보지 않는다.** 링크가 해석되는지·표 열 수가 맞는지만
 *     본다. 문장이 사실인지, 링크가 *올바른* 문서를 가리키는지는 별개다.
 *  2. **SCAN_DIRS 밖은 여전히 사각지대다.** 두 스캐너 모두 각 플러그인 루트의
 *     `commands`·`skills`·`docs`·`rubrics` 와 그 루트의 `CLAUDE/README/AGENTS.md`
 *     만 본다. `agents/*.md`(artibot 28개)·`CHANGELOG.md`·`RELEASE.md`·
 *     `plugins/artibot-cowork/_reports/` 는 지금도 어느 게이트에도 걸리지 않는다.
 *     측정 시점에 `plugins/artibot/CHANGELOG.md` 만으로 rendering 위반 14건이
 *     있어서(전부 backtick-in-inline-code) 이번 패스의 범위를 넘는다고 판단했다.
 *  2-a. **리포 루트 문서는 이제 doc-links 만 본다 (2026-08-19).** `validate-doc-links`
 *     는 리포 루트의 `README/CONTRIBUTING/INSTALL/CLAUDE/AGENTS.md` 를 스캔하지만
 *     `validate-md-rendering` 은 여전히 플러그인 루트만 본다. 즉 루트 문서의 표·
 *     인라인코드 **렌더링** 위반은 아직 아무 게이트에도 안 걸린다. 두 스캐너의
 *     분모 lockstep 단언(아래)이 **플러그인 루트 기준**인 이유이기도 하다 —
 *     `gatherAllDocFiles().counts` 는 의도적으로 루트를 포함하지 않는다.
 *  3. **`isProjectPluginDir` 는 이름 규칙이다.** `plugins/` 아래에 `artibot`
 *     접두사도 `_shared` 도 아닌 이름의 새 디렉터리가 생기면 그것은 스캔되지
 *     않는다. 설치 트리에서 남의 플러그인을 우리 CI 로 끌어들이지 않기 위한
 *     트레이드오프이고, 그 대가가 이 구멍이다.
 *  4. **이 파일이 삭제되면 게이트도 사라진다.** vitest 파일 기반 게이트의 공통
 *     한계이고, 이 리포의 다른 firewall 테스트도 같다.
 *
 * @module tests/firewall/cowork-doc-gates
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  assertScanFloors,
  isProjectPluginDir,
  listPluginRoots,
  MIN_DOC_FILES,
} from '../../scripts/ci/ci-utils.js';
import {
  findBrokenLinks,
  gatherAllDocFiles,
  gatherRepoRootDocFiles,
  getRepoDocRoot,
} from '../../scripts/ci/validate-doc-links.js';
import {
  applyRatchet,
  KNOWN_RENDER_VIOLATIONS,
  scanAllPlugins,
} from '../../scripts/ci/validate-md-rendering.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `<repo>/plugins/artibot/tests/firewall` 에서 네 단계 위가 리포 루트다. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const COWORK_ROOT = join(PLUGINS_DIR, 'artibot-cowork');

/**
 * 스캐너와 **독립적으로** 대상 파일을 센다. 이 수가 분모다. 스캐너의 헬퍼를
 * 재사용하면 스캐너가 0개를 보고 통과할 때 이 테스트도 함께 0을 보고 통과한다.
 */
function countMarkdownIn(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      if (['node_modules', 'runtime', 'repos', '.git', '_reports', 'coverage', '.vitest'].includes(entry)) {
        continue;
      }
      n += countMarkdownIn(abs);
    } else if (entry.toLowerCase().endsWith('.md')) {
      n += 1;
    }
  }
  return n;
}

function independentCount(root) {
  let n = 0;
  for (const d of ['commands', 'skills', 'docs', 'rubrics']) n += countMarkdownIn(join(root, d));
  for (const f of ['CLAUDE.md', 'README.md', 'AGENTS.md']) {
    if (existsSync(join(root, f))) n += 1;
  }
  return n;
}

describe('docs:check gates cover every co-located plugin', () => {
  it('cowork 에 실제로 문서가 있다 (분모가 0이면 아래 단언은 공허하다)', () => {
    expect(independentCount(COWORK_ROOT)).toBeGreaterThan(100);
  });

  it('플러그인 루트 열거가 artibot 과 artibot-cowork 를 **둘 다** 포함한다', () => {
    const names = listPluginRoots().map((p) => basename(p));
    expect(names).toContain('artibot');
    expect(names).toContain('artibot-cowork');
  });

  it('doc-links 스캔 분모가 독립 계수와 일치한다 (플러그인별)', () => {
    const { counts } = gatherAllDocFiles();
    for (const root of listPluginRoots()) {
      expect(counts[basename(root)]).toBe(independentCount(root));
    }
    expect(counts['artibot-cowork']).toBeGreaterThan(0);
  });

  it('md-rendering 스캔 분모가 doc-links 와 lockstep 이다', () => {
    // 두 스캐너는 SCAN_DIRS/ROOT_FILES 를 각자 복사해 갖고 있다. 한쪽만 조여지면
    // 다른 쪽이 조용히 느슨해지므로, 같은 집합을 보는지 여기서 못박는다.
    expect(scanAllPlugins().counts).toEqual(gatherAllDocFiles().counts);
  });

  it('모든 스캔 루트가 MIN_DOC_FILES 하한을 만족한다', () => {
    expect(assertScanFloors(gatherAllDocFiles().counts)).toEqual([]);
  });
});

describe('게이트 자기검증 — 사각지대가 실제로 닫혔는가', () => {
  it('cowork 경로의 깨진 링크를 실제로 잡는다', () => {
    // 디스크를 건드리지 않고, **실재하는** cowork 파일 경로를 기준으로 판정시킨다.
    // 확장 전에는 이 경로가 스캔 목록에 아예 없었다.
    const victim = join(COWORK_ROOT, 'README.md');
    expect(existsSync(victim)).toBe(true);
    const broken = findBrokenLinks(
      '# x\n\n[dead](./__no_such_doc__.md)\n',
      victim,
      PLUGINS_DIR,
    );
    expect(broken.map((b) => b.type)).toContain('link');
  });

  it('cowork 문서가 정상일 때는 잡지 않는다 (양성 대조의 짝)', () => {
    const victim = join(COWORK_ROOT, 'README.md');
    expect(findBrokenLinks('# x\n\n[live](./README.md)\n', victim, PLUGINS_DIR)).toEqual([]);
  });

  it('플러그인 간 링크도 검증 범위다 (containment = plugins/, 단일 플러그인 아님)', () => {
    const victim = join(COWORK_ROOT, 'README.md');
    const broken = findBrokenLinks(
      '[x](../artibot/__no_such_doc__.md)\n',
      victim,
      PLUGINS_DIR,
    );
    expect(broken).toHaveLength(1);
  });
});

/**
 * ── 2026-08-19 사각지대 (리포 루트 문서) ────────────────────────────────────
 * 루트 `README.md` 는 삭제된 `RELEASE_NOTES_4.8_KO.md`(`ccd7f7fa` 에서 제거)를
 * 계속 가리키고 있었는데 게이트는 `PASS: 474 documentation file(s) checked,
 * 0 broken references` 를 냈다. 스캔한 것 안에서는 참이었고, 루트 README 는 그
 * 안에 없었다.
 *
 * 결함은 **두 겹**이었고 둘 다 닫아야 했다:
 *   ① 스캔 집합 — 모든 스캔 루트가 `plugins/` 아래라 리포 루트 문서는 아예
 *      열리지 않았다.
 *   ② containment — 판정은 containment **안쪽**으로 해석되는 링크에만 적용된다
 *      (`findBrokenLinks` 1단계가 나머지를 범위 밖으로 건너뛴다). containment 가
 *      `plugins/` 인 채로 루트 README 만 스캔 집합에 넣었다면, 타깃이 리포 루트로
 *      해석되므로 **여전히 건너뛰어졌다**. 아래 세 번째 테스트가 그 절반을 못박는다.
 */
describe('게이트 자기검증 — 리포 루트 문서 사각지대 (2026-08-19)', () => {
  it('리포 루트 문서가 실제 스캔 목록에 들어 있다 (분모)', () => {
    const { root, files } = gatherRepoRootDocFiles();
    expect(root).toBe(REPO_ROOT);
    expect(files.map((f) => basename(f))).toContain('README.md');
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('루트 문서의 깨진 링크를 실제로 잡는다 (①+② 둘 다 닫혔을 때만 통과)', () => {
    const victim = join(REPO_ROOT, 'README.md');
    expect(existsSync(victim)).toBe(true);
    const broken = findBrokenLinks(
      '# x\n\n[dead](./RELEASE_NOTES_4.8_KO.md)\n',
      victim,
      REPO_ROOT,
    );
    expect(broken.map((b) => b.type)).toContain('link');
  });

  it('containment 가 plugins/ 로 좁아지면 같은 링크를 놓친다 (②가 왜 필요한지)', () => {
    // 회귀 핀: 이 단언이 깨졌다면 containment 를 다시 좁혀도 테스트가 통과하게
    // 된 것이다. 좁은 containment 는 경계를 넘는 링크를 조용히 면제한다 = fail-open.
    const victim = join(REPO_ROOT, 'README.md');
    expect(
      findBrokenLinks('[dead](./RELEASE_NOTES_4.8_KO.md)\n', victim, PLUGINS_DIR),
    ).toEqual([]);
  });

  it('루트 문서가 정상일 때는 잡지 않는다 (양성 대조의 짝)', () => {
    const victim = join(REPO_ROOT, 'README.md');
    expect(
      findBrokenLinks('[live](./plugins/artibot/CHANGELOG.md)\n', victim, REPO_ROOT),
    ).toEqual([]);
  });

  it('dev-repo 마커가 없으면 루트를 스캔하지 않는다 (설치 트리 안전장치)', () => {
    // 설치 트리에서 `getPluginsDir()` 의 부모는 `~/.claude` 다. 마커 검사가 없으면
    // 사용자의 개인 `~/.claude/CLAUDE.md` 를 열어 그 깨진 링크를 우리 CI 실패로
    // 만든다. 마커가 없는 경로를 강제해 null 로 떨어지는지 확인한다.
    const saved = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      process.env.CLAUDE_PLUGIN_ROOT = join(REPO_ROOT, '__no_such_tree__', 'plugins', 'artibot');
      expect(getRepoDocRoot()).toBeNull();
      expect(gatherRepoRootDocFiles().files).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = saved;
    }
  });
});

describe('분모 단언은 fail-closed 다', () => {
  it('루트가 통째로 빠지면 FAIL', () => {
    const { 'artibot-cowork': _drop, ...withoutCowork } = {
      artibot: 349,
      'artibot-cowork': 144,
      _shared: 4,
    };
    expect(assertScanFloors(withoutCowork).join(' ')).toMatch(/artibot-cowork.*not scanned/);
  });

  it('루트는 있으나 파일 수가 하한 미만이면 FAIL', () => {
    const failures = assertScanFloors({ artibot: 349, 'artibot-cowork': 0, _shared: 4 });
    expect(failures.join(' ')).toMatch(/'artibot-cowork' scanned 0 file\(s\), below floor/);
  });

  it('MIN_DOC_FILES 에 없는 새 루트가 나타나면 FAIL (새 사각지대 자동 개통 방지)', () => {
    const failures = assertScanFloors({
      artibot: 349,
      'artibot-cowork': 144,
      _shared: 4,
      'artibot-newthing': 12,
    });
    expect(failures.join(' ')).toMatch(/artibot-newthing.*no entry in MIN_DOC_FILES/);
  });

  it('이름 규칙이 미래 artibot-* 를 포함하고 남의 플러그인을 배제한다', () => {
    expect(isProjectPluginDir('artibot-anything')).toBe(true);
    expect(isProjectPluginDir('_shared')).toBe(true);
    expect(isProjectPluginDir('some-third-party-plugin')).toBe(false);
  });

  it('MIN_DOC_FILES 하한이 실측치보다 낮게 유지된다 (하한이 상한이 되면 안 된다)', () => {
    const { counts } = gatherAllDocFiles();
    for (const [name, floor] of Object.entries(MIN_DOC_FILES)) {
      expect(counts[name]).toBeGreaterThanOrEqual(floor);
    }
  });
});

describe('md-rendering ratchet 은 스스로 느슨해지지 않는다', () => {
  const KEY = 'artibot-cowork/skills/x/SKILL.md::table-pipe-column-mismatch';

  it('baseline 과 정확히 일치하면 통과', () => {
    const findings = [{ key: KEY, message: 'm1' }];
    expect(applyRatchet(findings, { [KEY]: 1 })).toEqual({ unexpected: [], stale: [] });
  });

  it('같은 파일·같은 규칙에 위반이 하나 늘면 FAIL (총량 baseline 이었다면 흡수됐을 사례)', () => {
    const findings = [
      { key: KEY, message: 'm1' },
      { key: KEY, message: 'm2' },
    ];
    const { unexpected } = applyRatchet(findings, { [KEY]: 1 });
    expect(unexpected).toEqual(['m2']);
  });

  it('baselined 위반이 고쳐지면 FAIL — 항목을 손으로 지워야 한다 (자동 완화 없음)', () => {
    const { stale } = applyRatchet([], { [KEY]: 1 });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/tighten KNOWN_RENDER_VIOLATIONS/);
  });

  it('스캔이 통째로 비어도 "baseline tightened → PASS" 가 되지 않는다', () => {
    // check-unused-ratchet 이 node_modules 부재 시 자기 기준선을 파괴하며 통과한
    // 선례의 재발 방지. 빈 입력은 stale 로 RED 가 되어야 한다.
    const { unexpected, stale } = applyRatchet([], KNOWN_RENDER_VIOLATIONS);
    expect(unexpected).toEqual([]);
    expect(stale).toHaveLength(Object.keys(KNOWN_RENDER_VIOLATIONS).length);
  });

  it('baseline 에 없는 파일의 위반은 통과하지 못한다', () => {
    const { unexpected } = applyRatchet([{ key: 'artibot/docs/new.md::rule', message: 'boom' }], {});
    expect(unexpected).toEqual(['boom']);
  });

  it('baseline 의 모든 키가 실재하는 cowork 파일을 가리킨다 (죽은 항목 방지)', () => {
    for (const key of Object.keys(KNOWN_RENDER_VIOLATIONS)) {
      const rel = key.split('::')[0];
      expect(existsSync(join(PLUGINS_DIR, rel))).toBe(true);
    }
  });

  it('라이브 스캔의 findings 가 baseline 과 정확히 맞는다 (게이트 실주행)', () => {
    const { unexpected, stale } = applyRatchet(scanAllPlugins().findings);
    expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
  });
});

describe('두 스캐너가 cowork 를 참조한다는 정적 증거', () => {
  it('어느 스캐너도 단일 getPluginRoot() 로 스캔 루트를 잡지 않는다', () => {
    for (const f of ['validate-doc-links.js', 'validate-md-rendering.js']) {
      const src = readFileSync(join(__dirname, '..', '..', 'scripts', 'ci', f), 'utf8');
      expect(src, `${f} 가 단일 루트로 되돌아갔다`).toMatch(/listPluginRoots\(\)/);
      expect(src).not.toMatch(/const root = getPluginRoot\(\)/);
    }
  });

  it('스캔한 파일 목록에 cowork 절대경로가 실제로 들어 있다', () => {
    const { files } = gatherAllDocFiles();
    const coworkFiles = files.filter((f) =>
      relative(PLUGINS_DIR, f).split(sep)[0] === 'artibot-cowork',
    );
    expect(coworkFiles.length).toBeGreaterThan(100);
  });
});
