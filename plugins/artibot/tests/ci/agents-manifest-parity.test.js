/**
 * 트립와이어: `plugin.json#agents` 배열과 `agents/` 디렉터리의 양방향 일치.
 *
 * ── Why (실측, 2026-09-12 / base a40b8448 / 워킹트리 clean) ──────────────────
 * 이 게이트를 켜기 직전 본체 플러그인의 매니페스트는 **28항목**인데 디렉터리는
 * **30파일**(INDEX.md 제외)이었다. 차집합(디렉터리 − 매니페스트) = `auditor.md`,
 * `investigator.md` 정확히 2건. 반대 방향(매니페스트 − 디렉터리) = 0건.
 * 재현 (플러그인 루트에서):
 *
 *   comm -23 <(ls agents/*.md | sed 's|agents/||' | grep -v '^INDEX.md$' | sort) \
 *            <(grep -oE '\./agents/[a-z0-9-]+\.md' .claude-plugin/plugin.json \
 *              | sed 's|\./agents/||' | sort)
 *
 * 주의: 문자 클래스에 `0-9` 를 빼면 `e2e-runner.md` 가 **거짓 누락**으로 잡힌다
 * (실제로 한 번 잡혔다). 이 재현 명령을 베껴 쓸 때 숫자를 지우지 마라.
 *
 * 기존 게이트 4개 중 **어느 것도 이 불일치를 보지 않는다** (각각 무엇을 보는가):
 *   - `scripts/validate.js#validateAgents` (:154, 2026-09-12) — `agents/` 디렉터리를
 *     readdir 해서 각 파일의 frontmatter 유무만 본다. 매니페스트를 읽지 않는다.
 *     같은 파일의 `validatePathPrefix` (:77-88) 는 매니페스트 경로가 `./` 로
 *     시작하는지만 본다 — 그 경로가 실재 파일인지도 검사하지 않는다.
 *   - `scripts/ci/readme-claims-registry.js#collectActuals` (:179) — `agents/` 의
 *     .md 개수를 세어 README 문구와 대조한다. 세는 쪽은 디렉터리뿐이다.
 *   - `tests/firewall/agent-name-references.test.js#shippedAgents` (:158) — 마크다운이
 *     지목하는 에이전트 이름이 출하 집합에 있는지 본다. 출하 집합 역시 디렉터리
 *     readdir 로 만든다(:162).
 *   - `scripts/ci/validate-install.js#PARITY_MATRIX` (:44) — install.sh 와 install.ps1
 *     의 함수 이름 대응만 본다. 에이전트와 무관하다.
 *
 * ── cowork 루트 처리 방침 ───────────────────────────────────────────────────
 * 본체(`plugins/artibot`)는 에이전트를 매니페스트에 **명시 배열**로 적고,
 * `plugins/artibot-cowork` 는 `agents` **키 자체가 없는 채로** 12개 에이전트를
 * 출하한다(2026-09-12 실측: 키 목록에 agents 없음, `agents/*.md` 12파일).
 * 두 루트의 규약이 서로 다르다. 이 사실은 "매니페스트 배열 = 호스트가 스폰을
 * 허용하는 allowlist" 라는 추론의 **반례 후보**다 — 그 추론이 참이라면 cowork 는
 * 에이전트를 하나도 못 쓴다는 뜻이 되는데, 그게 참인지는 아래 "못 보는 것" (i)
 * 대로 **미확인**이다. 그래서 키 부재를 "예외니까 넘어간다"(부정 목록)로 두지
 * 않고 **명시 허용 목록**(`ROOTS_WITHOUT_MANIFEST_AGENTS`)에 이름을 적는다.
 * 새 루트는 두 목록 중 하나에 등록해야만 통과한다(미래 루트 fail-closed).
 *
 * ── 이 게이트가 못 보는 것 (알려진 구멍 — 게이트 옆에 적어 둔다) ────────────
 *  (i)   호스트가 매니페스트 **미등록** 에이전트를 스폰하는지 여부. **미확인·미실행.**
 *        즉 이 게이트는 "매니페스트와 디렉터리가 어긋났다"는 정합성만 주장하고,
 *        어긋남이 런타임에 어떤 결과를 내는지는 주장하지 않는다.
 *  (ii)  이 머신은 사용자 레벨 `~/.claude/agents/` 사본으로도 에이전트를 스폰한다.
 *        따라서 여기서 `investigator` 가 스폰되는 것은 매니페스트가 불필요하다는
 *        증거가 **아니다**(경로가 둘이라 관측이 교란된다).
 *  (iii) frontmatter `name:` 과 파일명의 불일치는 이 게이트 밖이다
 *        (`tests/firewall/agent-name-references.test.js` 소관). 카탈로그 파일명
 *        제외 규약도 게이트마다 다르다(여기·validate.js 는 대소문자 무시,
 *        readme-claims-registry.js:179·agent-name-references:163 은 정확 일치) —
 *        `Readme.md` 류 입력이면 이 게이트는 제외하고 registry 는 세어 옆
 *        게이트(validate-readme-claims)가 red 를 낸다. 조용한 구멍은 아니다.
 *  (iv)  이 스위트의 그린을 **"신규 설치에서 동작한다"** 의 근거로 쓰지 마라.
 *        픽스처가 이 리포 자신이다. 설치본·캐시본은 여기서 한 번도 안 읽는다.
 *
 * ── 실험 설계 (미실행 — 이 창에서 4조건을 만들 수 없다) ─────────────────────
 * 위 (i) 을 실제로 재려면:
 *   1. 사용자 레벨 `~/.claude/agents/` 사본이 없는 환경(또는 임시 HOME/USERPROFILE)
 *   2. 플러그인만 설치한 상태
 *   3. `Agent(subagent_type:"investigator")` 1회를, 매니페스트 등록 **전/후** 각 1회(A/B)
 *   4. 관측 산출물 2개 — SubagentStart 훅이 쓰는 스폰 원장
 *      `<git-common-dir>/artibot/spawns.ndjson` 의 해당 `agent_type` 행 존재 여부,
 *      그리고 Agent 도구가 돌려준 오류 문자열. (로그 파일은 통보 경로가 아니다.
 *      그래서 판정 신호를 하나가 아니라 둘로 잡는다.)
 * 이 4조건은 이 창에서 충족 불가라 **미실행**이며, 따라서 (i) 은 미확인으로 남는다.
 *
 * @module tests/ci/agents-manifest-parity
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// __dirname = .../plugins/artibot/tests/ci
const PLUGIN_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(PLUGIN_ROOT, '..', '..');

/** `agents` 키가 있고 디렉터리와 정확히 일치해야 하는 루트 (리포 루트 기준 상대경로). */
const ROOTS_WITH_MANIFEST_AGENTS = ['plugins/artibot'];

/** `agents` 키 없이 에이전트를 출하하는 루트. 키가 생기면 위 목록으로 옮겨야 한다. */
const ROOTS_WITHOUT_MANIFEST_AGENTS = ['plugins/artibot-cowork'];

/**
 * 에이전트 정의가 아닌 카탈로그 파일. `readme-claims-registry.js` (:179) 의
 * 제외 집합과 동일하되, `validate.js#validateAgents` 처럼 대소문자를 무시한다.
 */
const CATALOG_FILES = new Set(['index.md', 'readme.md']);

/** 매니페스트 항목이 반드시 따라야 하는 형식. */
const ENTRY_PATTERN = /^\.\/agents\/[^/\\]+\.md$/;

/**
 * 매니페스트 항목 배열과 디렉터리 파일명 배열의 양방향 차집합을 낸다.
 * 순수 함수 — 디스크에 접근하지 않는다(입력이 곧 전부다).
 *
 * @param {{ manifestEntries: string[], directoryFiles: string[] }} input
 *   `manifestEntries` 는 `./agents/<name>.md` 형식의 문자열 배열,
 *   `directoryFiles` 는 파일명(`<name>.md`) 배열.
 * @returns {{ missingFromManifest: string[], missingOnDisk: string[],
 *             malformed: string[], duplicates: string[], ok: boolean }}
 *   `missingFromManifest` = 디스크에 있으나 매니페스트에 없는 파일명,
 *   `missingOnDisk` = 매니페스트에 있으나 디스크에 없는 항목(원문 그대로),
 *   `malformed` = 형식을 벗어난 매니페스트 항목(디스크 대조에서 제외된다),
 *   `duplicates` = 매니페스트에 두 번 이상 적힌 항목(Set 으로 접히면 조용히
 *   통과하므로 따로 센다 — 검수 지적 2026-09-12).
 * @throws {TypeError} 입력이 배열이 아니거나 비어 있을 때 (fail-closed —
 *   빈 입력을 "차이 0건"으로 통과시키면 파일 부재가 그린이 된다).
 */
export function computeAgentParity({ manifestEntries, directoryFiles } = {}) {
  if (!Array.isArray(manifestEntries) || manifestEntries.length === 0) {
    throw new TypeError('computeAgentParity: manifestEntries must be a non-empty array');
  }
  if (!Array.isArray(directoryFiles) || directoryFiles.length === 0) {
    throw new TypeError('computeAgentParity: directoryFiles must be a non-empty array');
  }

  const malformed = manifestEntries.filter((entry) => !ENTRY_PATTERN.test(entry));
  const seen = new Set();
  const duplicates = [];
  for (const entry of manifestEntries) {
    if (seen.has(entry) && !duplicates.includes(entry)) duplicates.push(entry);
    seen.add(entry);
  }
  const manifestNames = new Set(
    manifestEntries
      .filter((entry) => ENTRY_PATTERN.test(entry))
      .map((entry) => entry.slice('./agents/'.length)),
  );
  const diskNames = new Set(
    directoryFiles.filter((file) => file.endsWith('.md') && !CATALOG_FILES.has(file.toLowerCase())),
  );

  const missingFromManifest = [...diskNames].filter((name) => !manifestNames.has(name)).sort();
  const missingOnDisk = [...manifestNames]
    .filter((name) => !diskNames.has(name))
    .map((name) => `./agents/${name}`)
    .sort();

  return {
    missingFromManifest,
    missingOnDisk,
    malformed,
    duplicates,
    ok:
      missingFromManifest.length === 0 &&
      missingOnDisk.length === 0 &&
      malformed.length === 0 &&
      duplicates.length === 0,
  };
}

/** `plugins/<name>/agents/` 가 실재하는 루트를 발견한다 (리포 루트 기준 상대경로, 정렬). */
function discoverAgentRoots() {
  const pluginsDir = join(REPO_ROOT, 'plugins');
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `plugins/${entry.name}`)
    .filter((rel) => {
      const dir = join(REPO_ROOT, rel, 'agents');
      return existsSync(dir) && statSync(dir).isDirectory();
    })
    .sort();
}

/** 루트의 `agents/` 디렉터리에서 카탈로그 파일을 뺀 .md 목록. */
function readAgentDir(rel) {
  return readdirSync(join(REPO_ROOT, rel, 'agents'))
    .filter((file) => file.endsWith('.md') && !CATALOG_FILES.has(file.toLowerCase()));
}

function readManifest(rel) {
  const manifestPath = join(REPO_ROOT, rel, '.claude-plugin', 'plugin.json');
  expect(existsSync(manifestPath), `${rel}/.claude-plugin/plugin.json 이 없다`).toBe(true);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

// ── (a) 라이브 패리티 축 ─────────────────────────────────────────────────────

describe('plugin.json#agents ↔ agents/ 디렉터리 패리티', () => {
  const discovered = discoverAgentRoots();

  it('발견된 루트가 모두 허용 목록 둘 중 정확히 하나에 등록돼 있다', () => {
    expect(discovered.length, 'plugins/*/agents/ 를 하나도 못 찾았다').toBeGreaterThan(0);
    const unregistered = discovered.filter(
      (rel) =>
        !ROOTS_WITH_MANIFEST_AGENTS.includes(rel) && !ROOTS_WITHOUT_MANIFEST_AGENTS.includes(rel),
    );
    expect(
      unregistered,
      `허용 목록에 없는 에이전트 루트: ${unregistered.join(', ')} — ` +
        'ROOTS_WITH_MANIFEST_AGENTS 또는 ROOTS_WITHOUT_MANIFEST_AGENTS 에 등록하라',
    ).toEqual([]);

    const bothLists = discovered.filter(
      (rel) =>
        ROOTS_WITH_MANIFEST_AGENTS.includes(rel) && ROOTS_WITHOUT_MANIFEST_AGENTS.includes(rel),
    );
    expect(bothLists, '두 목록에 동시에 등록된 루트').toEqual([]);
  });

  it('허용 목록에 적힌 루트가 모두 디스크에 실재한다', () => {
    const listed = [...ROOTS_WITH_MANIFEST_AGENTS, ...ROOTS_WITHOUT_MANIFEST_AGENTS];
    const vanished = listed.filter((rel) => !discovered.includes(rel));
    expect(vanished, `목록에 있으나 agents/ 가 없는 루트: ${vanished.join(', ')}`).toEqual([]);
  });

  for (const rel of ROOTS_WITH_MANIFEST_AGENTS) {
    describe(rel, () => {
      it('매니페스트가 비어 있지 않은 agents 배열을 갖고 디렉터리에도 .md 가 있다', () => {
        const manifest = readManifest(rel);
        expect(Array.isArray(manifest.agents), `${rel}: agents 가 배열이 아니다`).toBe(true);
        expect(manifest.agents.length, `${rel}: agents 배열이 비었다`).toBeGreaterThan(0);
        expect(readAgentDir(rel).length, `${rel}: agents/ 에 .md 가 없다`).toBeGreaterThan(0);
      });

      it('매니페스트와 디렉터리가 양방향으로 일치한다', () => {
        const parity = computeAgentParity({
          manifestEntries: readManifest(rel).agents,
          directoryFiles: readAgentDir(rel),
        });
        expect(
          parity.malformed,
          `${rel}: "./agents/<name>.md" 형식을 벗어난 매니페스트 항목`,
        ).toEqual([]);
        expect(
          parity.missingFromManifest,
          `${rel}: agents/ 에 있으나 plugin.json#agents 에 없다 → ` +
            `${parity.missingFromManifest.join(', ')}`,
        ).toEqual([]);
        expect(
          parity.missingOnDisk,
          `${rel}: plugin.json#agents 에 있으나 파일이 없다 → ${parity.missingOnDisk.join(', ')}`,
        ).toEqual([]);
        expect(
          parity.duplicates,
          `${rel}: plugin.json#agents 에 두 번 이상 적힌 항목 → ${parity.duplicates.join(', ')}`,
        ).toEqual([]);
        expect(parity.ok).toBe(true);
      });
    });
  }

  for (const rel of ROOTS_WITHOUT_MANIFEST_AGENTS) {
    describe(rel, () => {
      it('매니페스트에 agents 키가 없다 (키가 생기면 ROOTS_WITH 로 옮겨야 한다)', () => {
        const manifest = readManifest(rel);
        expect(
          Object.prototype.hasOwnProperty.call(manifest, 'agents'),
          `${rel}: agents 키가 생겼다 — ROOTS_WITH_MANIFEST_AGENTS 로 옮기고 패리티를 맞춰라`,
        ).toBe(false);
      });

      it('agents 키가 없어도 디렉터리에는 에이전트가 실재한다', () => {
        expect(readAgentDir(rel).length, `${rel}: agents/ 에 .md 가 없다`).toBeGreaterThan(0);
      });
    });
  }
});

// ── (b) 스캐너 자기검증 축 (디스크 무관) ──────────────────────────────────────

describe('computeAgentParity 자기검증', () => {
  const baseline = {
    manifestEntries: ['./agents/alpha.md', './agents/beta.md'],
    directoryFiles: ['alpha.md', 'beta.md'],
  };

  it('양쪽 집합이 같으면 ok 이고 두 차집합이 모두 비어 있다', () => {
    const result = computeAgentParity(baseline);
    expect(result).toEqual({
      missingFromManifest: [],
      missingOnDisk: [],
      malformed: [],
      duplicates: [],
      ok: true,
    });
  });

  it('매니페스트에 같은 항목이 두 번 있으면 duplicates 에 잡히고 ok 를 깬다 (Set 접힘 방지)', () => {
    const result = computeAgentParity({
      manifestEntries: ['./agents/alpha.md', './agents/beta.md', './agents/alpha.md'],
      directoryFiles: ['alpha.md', 'beta.md'],
    });
    expect(result.duplicates).toEqual(['./agents/alpha.md']);
    expect(result.missingFromManifest).toEqual([]);
    expect(result.missingOnDisk).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('매니페스트에서 1건을 빼면 missingFromManifest 에 그 파일명이 잡힌다', () => {
    const result = computeAgentParity({
      manifestEntries: ['./agents/alpha.md'],
      directoryFiles: ['alpha.md', 'beta.md'],
    });
    expect(result.missingFromManifest).toEqual(['beta.md']);
    expect(result.missingOnDisk).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('매니페스트에 유령 항목을 더하면 missingOnDisk 에 그 항목이 잡힌다', () => {
    const result = computeAgentParity({
      manifestEntries: [...baseline.manifestEntries, './agents/ghost.md'],
      directoryFiles: baseline.directoryFiles,
    });
    expect(result.missingOnDisk).toEqual(['./agents/ghost.md']);
    expect(result.missingFromManifest).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('INDEX.md / README.md 는 디렉터리 입력에 있어도 제외된다', () => {
    const result = computeAgentParity({
      manifestEntries: baseline.manifestEntries,
      directoryFiles: ['alpha.md', 'beta.md', 'INDEX.md', 'README.md'],
    });
    expect(result.missingFromManifest).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('.md 가 아닌 디렉터리 항목은 무시한다', () => {
    const result = computeAgentParity({
      manifestEntries: baseline.manifestEntries,
      directoryFiles: ['alpha.md', 'beta.md', 'notes.txt'],
    });
    expect(result.ok).toBe(true);
  });

  it('형식을 벗어난 매니페스트 항목은 malformed 로 보고하고 ok 를 깬다', () => {
    const result = computeAgentParity({
      manifestEntries: ['./agents/alpha.md', './agents/beta.md', 'agents/gamma.md', './agent/x.md'],
      directoryFiles: ['alpha.md', 'beta.md'],
    });
    expect(result.malformed).toEqual(['agents/gamma.md', './agent/x.md']);
    expect(result.ok).toBe(false);
  });

  it('형식 이탈 항목은 missingOnDisk 로 이중 보고하지 않는다', () => {
    const result = computeAgentParity({
      manifestEntries: ['./agents/alpha.md', './agents/beta.md', 'agents/gamma.md'],
      directoryFiles: ['alpha.md', 'beta.md'],
    });
    expect(result.missingOnDisk).toEqual([]);
  });

  it('입력이 없거나 비면 throw 한다 (fail-closed)', () => {
    expect(() => computeAgentParity()).toThrow(TypeError);
    expect(() => computeAgentParity({ directoryFiles: ['alpha.md'] })).toThrow(
      /manifestEntries must be a non-empty array/,
    );
    expect(() =>
      computeAgentParity({ manifestEntries: [], directoryFiles: ['alpha.md'] }),
    ).toThrow(/manifestEntries must be a non-empty array/);
    expect(() => computeAgentParity({ manifestEntries: ['./agents/alpha.md'] })).toThrow(
      /directoryFiles must be a non-empty array/,
    );
    expect(() =>
      computeAgentParity({ manifestEntries: ['./agents/alpha.md'], directoryFiles: [] }),
    ).toThrow(/directoryFiles must be a non-empty array/);
  });
});
