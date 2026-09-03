/**
 * Firewall — 파생 파일 / 정본 거버넌스 (설계 §3.3 검사 9종 중 #1 #2 #4 #6).
 *
 * 설계 `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md §3.3` 이 이 파일을 이름으로
 * 지목한다: "파생 파일 validator = `tests/firewall/artifact-governance.test.js`
 * (스크립트형 금지)". 스크립트형이 금지된 이유는 선례가 있어서다 —
 * `check-unused-ratchet` 이 `node_modules` 부재 시 자기 기준선을 0 으로 파괴하며
 * `PASS` 를 찍었다. vitest 파일은 없어지면 red 다(fail-closed).
 *
 * ── 무엇을 재는가 ───────────────────────────────────────────────────────────
 * 네 가지를 잰다. 전부 **`git ls-files`(인덱스) 기준**이고 워킹트리가 아니다.
 * 이 게이트가 막으려는 사고는 "리포에 들어가는 것"이지 "로컬에 생기는 것"이
 * 아니다. 로컬 산출물 경계는 `.gitignore` 소관이고 그쪽 게이트는
 * `gitignore-boundary.test.js` 다. 두 게이트를 섞지 마라.
 *
 *  #1 파일명 패턴 — v1.1 `15_POLICY_EXAMPLE.yaml:19-26` 의 7패턴 + `08_ARTIFACT_
 *     GOVERNANCE.md:27-35` 의 `plan2.md`·`new-plan.md`, 그리고 확장 3패턴
 *     (`*-2.md`·`*-final.md`·`*-new.md`). 전부 `.md` 한정이다(아래 "지시 정정" #1).
 *  #2 정본 둘 — 같은 `slug:` 를 선언한 추적 md 2개 이상, 그리고 ADR 번호가 겹치는
 *     디렉터리 2개 이상. **B2 이행 후(2026-09-03) ADR 예외는 0쌍**이다 — 두 계열이
 *     `.artibot/adr/` 하나로 합쳐지고(루트 5건은 006~010 재번호) 원본 디렉터리가
 *     둘 다 삭제되어 겹칠 계열이 없다. allowlist 가 비었다 = 검사가 fail-closed.
 *  #4 원장 분산 — `.artibot/` 또는 `runtime/` 을 경로 세그먼트로 갖는 추적 파일 중
 *     `*.ndjson`·`*.jsonl`·`*-trail.json` 이 중앙 `.artibot/runtime/ledger.jsonl`
 *     밖에 있는 것.
 *  #6 파생 렌더 헤더 — `HANDOFF.md`·`NEXT-SESSION.md` 가 추적될 때
 *     `derived-from:` frontmatter 를 갖는가.
 *
 * 동결 예외는 전부 `fixtures/artifact-governance.exceptions.json` 한 곳에만 있고
 * **allowlist** 다. 목록 밖 위반은 red — 부정 목록이었다면 미래 항목에 fail-open
 * 이 됐을 것이다(verification-discipline §8).
 *
 * ── 실측 (커밋 의존 — 시점을 지우지 마라) ───────────────────────────────────
 * **기준 커밋 `dc9a4c12`, 2026-09-02 16:37:49 +0900 측정.** 인덱스에 T-03(같은
 * slug PRD 병합, `-2.md` 삭제)·T-04(표류 원장 이동)·T-08(gitignore 4규칙)의
 * 스테이징이 반영된 상태다. 재현: `git ls-files | wc -l`.
 *
 *   분모: 추적 1,782 파일 / 그중 md 654.
 *   #1 위반 0건 — v1.1 9패턴 0, 확장 3패턴 0. T-03 이 유일했던
 *      `PRD-SPLIT-…-2.md` 를 인덱스에서 지웠다(그 전 1건).
 *   #2 위반 0건 — `slug:` 를 선언한 추적 md 는 **1개뿐**이고(분모 654) 중복 0.
 *      ADR 계열은 추적 1개(`plugins/artibot/docs/adr/` ADR-001~005). 루트
 *      `docs/adr/` 5+INDEX 는 `.gitignore:19` 의 `/docs/` 로 **추적 0건**이라
 *      인덱스 기준으로는 아직 정본-둘이 아니다. 예외 1쌍이 등록돼 있고 B2 대기다.
 *
 *   **갱신 (2026-09-03, B2 이행)**: ADR 정본이 `.artibot/adr/` 한 계열로 합쳐졌다
 *      (설계 §3.3 매핑표 :151 · §5 결정표 :282 · `/adr` 운명 :159 가 지정한 위치,
 *      루트 `.gitignore:116` 도 추적 정본으로 열거). `plugins/artibot/docs/adr/`
 *      5건은 `git mv` 로 번호 그대로, 루트 `docs/adr/` 5+INDEX 는 **006~010**
 *      재번호로 옮겼고 두 원본 디렉터리는 삭제됐다. 그 결과 #2 의 ADR 예외는
 *      **1쌍 → 0쌍**이고 추적 ADR 계열은 한 곳뿐이다(최종 001~010 + INDEX =
 *      11파일, 그중 5건이 인덱스에 반영됨 — 나머지는 신규라 커밋 시 합류).
 *      위 dc9a4c12 실측치는 그대로 둔다 — 시점을 지우지 않는다.
 *   #4 위반 0건 / 예외 1건 — `.artibot/guides/vnext-design/examples/
 *      events.example.ndjson`(설계 예시, raw-log 등급으로 동결).
 *   #6 위반 0건 / 예외 1건 — `.artibot/guides/NEXT-SESSION.md` 는 **추적 중이고
 *      frontmatter 가 아예 없다**. `.artibot/HANDOFF.md` 는 워킹트리에 존재하나
 *      미추적(gitignore)이라 이 게이트의 대상이 아니다.
 *
 * ── 지시 정정 (리더 지시와 다르게 구현한 것) ────────────────────────────────
 *  1. **7패턴을 `.md` 로 한정했다.** 지시는 확장자를 안 붙였지만 v1.1 의 기계
 *     판독본(`15_POLICY_EXAMPLE.yaml`)은 전부 `"*.md"` 다. 확장자를 떼면
 *     `plan-v*` 가 장래의 `plan-validator.js` 를 잡는다 — 게이트가 거짓 red 를
 *     내면 다음 사람이 게이트를 깎는다(§10 이 막으려는 경로).
 *  2. **`NEXT-SESSION.md` 는 미추적이 아니다.** 지시 전제는 "현재 미추적/미이행"
 *     이었으나 커밋 `519e2529` 이 `.artibot/guides/NEXT-SESSION.md` 를 추적으로
 *     올렸다. 지시대로 "존재 시 검사" 를 그냥 걸면 이 게이트는 신설 즉시 red 가
 *     되어 웨이브를 막는다. 그래서 **#2 ADR 과 같은 동결 예외 형태**로 1건만
 *     열거하고 검사는 살려 뒀다 — 목록 밖 파생 렌더는 red 이고, 헤더가 붙는 순간
 *     이 항목은 stale 이 되어 삭제를 요구하는 red 가 난다. skip 이 아니다.
 *
 * ── 이 게이트가 못 보는 것 (초록을 그 이상으로 읽지 마라) ────────────────────
 *  1. **내용 참·거짓.** `derived-from:` 이 있는지만 본다. 그 값이 실제 state 를
 *     가리키는지, 렌더가 최신인지, 본문이 사실인지는 전혀 보지 않는다.
 *  2. **의미 중복.** 파일명이 다르고 `slug:` 도 다르면서 같은 내용을 담은 정본 둘은
 *     통과한다. 문자열 대조지 의미 대조가 아니다. `slug:` 를 선언한 추적 md 가
 *     측정 시점 **654 중 1개뿐**이라, #2 의 slug 축은 사실상 아직 아무것도 재지
 *     않는다 — 이 초록을 "정본 중복 없음" 으로 읽으면 오독이다.
 *  3. **`git add -f`.** 인덱스만 본다. gitignore 를 강제로 뚫고 들어온 파일은
 *     인덱스에 있으므로 오히려 잡히지만, 반대로 **미추적 위반은 전혀 안 잡는다** —
 *     `.artibot/HANDOFF.md`·`plugins/artibot/runtime/*-trail.json` 6종·
 *     `.artibot/ledger/*.jsonl` 33종은 워킹트리에 실재하나 여기 안 걸린다.
 *  4. **스코프 밖 원장.** #4 는 `.artibot/`·`runtime/` 세그먼트만 본다. 측정 시점
 *     `reports/SPLIT/split-8f83d7.events.ndjson` 와
 *     `plugins/artibot/tests/fixtures/*.jsonl` 2건은 추적 중이지만 스코프 밖이라
 *     통과한다. 스코프를 넓힐지는 이 파일이 아니라 설계가 정할 일이다.
 *  5. **쓰기 시점의 경로.** 코드가 원장을 어디에 쓰는지 보지 않는다. 파일 목록만
 *     본다.
 *  6. **예외 항목의 타당성.** 자기검증은 예외 항목의 *형식*(포인터 필드 존재)과
 *     *신선도*(아직 실재하는가)만 본다. 그 예외가 옳은 판단이었는지는 안 본다.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 리포 루트. 워크트리에서도 그 워크트리의 루트를 돌려준다. */
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: HERE,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

const EXCEPTIONS_PATH = path.join(HERE, 'fixtures', 'artifact-governance.exceptions.json');

// ───────────────────────────────────────────────────────────────────────────
// 순수 판정기. 전부 경로 배열(+ 필요한 경우 head 리더)만 받는다 — 그래야
// 픽스처로 "위반을 진짜 잡는가" 를 검증할 수 있다. 리포를 직접 읽는 판정기는
// 자기 자신을 검증할 수 없다.
// ───────────────────────────────────────────────────────────────────────────

/** v1.1 금지 파일명. `15_POLICY_EXAMPLE.yaml:19-26` 7 + `08:27-35` 2. basename 대조. */
const V11_FORBIDDEN_BASENAMES = [
  /^intent-v.*\.md$/i,
  /^intent-final.*\.md$/i,
  /^plan-v.*\.md$/i,
  /^plan-final.*\.md$/i,
  /^plan2.*\.md$/i,
  /^new-plan.*\.md$/i,
  /^todo\.md$/i,
  /^progress\.md$/i,
  /^status\.md$/i,
];

/** 확장 3패턴(설계 §3.3 이 현행 위반으로 지목한 형태). */
const EXTENDED_SUFFIXES = [/-2\.md$/i, /-final\.md$/i, /-new\.md$/i];

/**
 * 날짜 접미는 위반이 아니다. `DEADCODE-BACKLOG-2026-06-05.md` 처럼 회차가 아니라
 * 시점을 붙인 이름은 정본 경쟁을 만들지 않는다.
 */
const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}\.md$/i;

/** 검사 #1. 위반 경로 배열을 돌려준다. */
function findFilenameViolations(trackedPaths) {
  return trackedPaths.filter((p) => {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!/\.md$/i.test(base)) return false;
    if (DATE_SUFFIX.test(base)) return false;
    return (
      V11_FORBIDDEN_BASENAMES.some((re) => re.test(base)) ||
      EXTENDED_SUFFIXES.some((re) => re.test(base))
    );
  });
}

/**
 * 선두 YAML frontmatter 에서 키 하나를 뽑는다. CRLF 를 반드시 다뤄야 한다 —
 * 이 리포의 추적 md 는 CRLF 다(실측: `.artibot/guides/PRD-SPLIT-….md`).
 * `\r` 을 안 벗기면 값 끝에 `\r` 이 붙어 문자열 비교가 조용히 전부 어긋난다.
 */
function readFrontmatterKey(text, key) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'i');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '---') return null; // 블록 종료 — 키 없음
    const m = re.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null; // 종료 구분자를 못 만났으면 frontmatter 가 아니다
}

/** 검사 #2-a. 같은 `slug:` 를 선언한 추적 md 2개 이상. */
function findSlugDuplicates(trackedPaths, readHead) {
  const bySlug = new Map();
  for (const p of trackedPaths) {
    if (!/\.md$/i.test(p)) continue;
    const slug = readFrontmatterKey(readHead(p), 'slug');
    if (!slug) continue;
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(p);
  }
  return [...bySlug.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([slug, files]) => ({ slug, files: files.slice().sort() }));
}

const ADR_BASENAME = /^ADR-0*(\d+)[-._]/i;

/**
 * 검사 #2-b. ADR 번호가 겹치는 디렉터리 쌍.
 * `allowedPairs` 는 `[dirA, dirB]` 튜플 배열이고 순서를 따지지 않는다.
 */
function findAdrSeriesCollisions(trackedPaths, allowedPairs = []) {
  // 쌍 키의 구분자는 NUL 이다 — git 경로에 절대 들어갈 수 없는 유일한 바이트라
  // 공백 섞인 경로도 키가 충돌하지 않는다. 반드시 `\0` 이스케이프로 적어라:
  // raw 바이트를 그대로 넣으면 grep/rg 가 이 파일을 binary 로 보고 이후 매치를 멈춘다.
  const allowed = new Set(
    allowedPairs.map((pair) => [...pair].sort().join('\0')),
  );
  const byDir = new Map();
  for (const p of trackedPaths) {
    const idx = p.lastIndexOf('/');
    const dir = idx === -1 ? '.' : p.slice(0, idx);
    const m = ADR_BASENAME.exec(p.slice(idx + 1));
    if (!m) continue;
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir).add(Number(m[1]));
  }
  const dirs = [...byDir.keys()].sort();
  const collisions = [];
  for (let i = 0; i < dirs.length; i += 1) {
    for (let j = i + 1; j < dirs.length; j += 1) {
      const shared = [...byDir.get(dirs[i])].filter((n) => byDir.get(dirs[j]).has(n));
      if (shared.length === 0) continue;
      if (allowed.has([dirs[i], dirs[j]].sort().join('\0'))) continue;
      collisions.push({ dirs: [dirs[i], dirs[j]], sharedNumbers: shared.sort((a, b) => a - b) });
    }
  }
  return collisions;
}

/** 중앙 원장. 이 하나만 허용된다. */
const CANONICAL_LEDGER = '.artibot/runtime/ledger.jsonl';

/** #4 스코프: 경로 세그먼트에 `.artibot` 또는 `runtime` 이 있는 것. */
function inLedgerScope(p) {
  return p.split('/').some((seg) => seg === '.artibot' || seg === 'runtime');
}

const LEDGER_BASENAME = /(\.ndjson|\.jsonl|-trail\.json)$/i;

/** 검사 #4. 중앙 원장 밖의 분산 원장. */
function findDispersedLedgers(trackedPaths, allowedPaths = []) {
  const allowed = new Set(allowedPaths);
  return trackedPaths.filter(
    (p) =>
      p !== CANONICAL_LEDGER &&
      inLedgerScope(p) &&
      LEDGER_BASENAME.test(p.slice(p.lastIndexOf('/') + 1)) &&
      !allowed.has(p),
  );
}

/** 검사 #6. 파생 렌더 파일이 `derived-from:` 헤더를 갖는가. */
function findMissingDerivedFrom(trackedPaths, readHead, opts = {}) {
  const basenames = new Set(opts.basenames ?? ['HANDOFF.md', 'NEXT-SESSION.md']);
  const allowed = new Set(opts.allowedPaths ?? []);
  return trackedPaths.filter((p) => {
    if (!basenames.has(p.slice(p.lastIndexOf('/') + 1))) return false;
    if (allowed.has(p)) return false;
    return readFrontmatterKey(readHead(p), 'derived-from') === null;
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 라이브 입력
// ───────────────────────────────────────────────────────────────────────────

/**
 * 추적 경로 목록. **`-z` 는 선택이 아니다.**
 *
 * `git ls-files` 는 `core.quotepath`(기본 **true**)에서 ASCII 밖 바이트를 담은
 * 경로를 C 스타일로 인용해 돌려준다 — 경로 전체가 `"` 로 감싸이고 각 바이트가
 * `\354\226\264` 같은 8진 이스케이프가 된다. 줄 단위로 파싱하면 그 인용부호가
 * 경로의 일부가 되어, 예컨대 `.artibot/adr/ADR-006-…(한글).md` 가
 * `".artibot/adr/…` 로 읽히고 디렉터리 집계가 `".artibot/adr` 과 `.artibot/adr`
 * 둘로 갈라진다. `-z` 는 인용을 끄고 NUL 로 구분하므로 바이트 그대로 나온다.
 *
 * 이 결함이 늦게 드러난 이유를 적어 둔다: 한글 경로가 **미추적**인 동안에는
 * `ls-files` 에 아예 안 나와 전건 그린이었고, 커밋되는 순간 red 가 됐다. 즉
 * '지금 초록' 은 이 파서가 옳다는 증거가 아니었다 — 이 게이트가 못 보는 것
 * 목록에 '아직 커밋되지 않은 경로' 가 빠져 있었던 셈이다. 같은 리포의 선례는
 * `scripts/ci/ci-utils.js:74` 이며 처음부터 `['ls-files', '-z']` 를 쓴다.
 *
 * `-z` 는 마지막 항목 뒤에도 NUL 을 붙여 꼬리 빈 문자열이 생긴다 —
 * `filter(Boolean)` 이 그것을 걷어낸다(줄 파싱 때의 역할과 같다).
 */
const TRACKED = execFileSync('git', ['ls-files', '-z'], {
  cwd: REPO_ROOT,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
})
  .split('\0')
  .filter(Boolean);

/** 파일 앞부분만 읽는다. frontmatter 판정에 본문 전체가 필요하지 않다. */
function readHeadFromRepo(relPath) {
  try {
    return fsSync.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8').slice(0, 4096);
  } catch {
    // 인덱스에 있으나 워킹트리에 없는 경우(스테이징된 삭제 등). frontmatter 를
    // 확인할 수 없으니 "헤더 없음" 으로 취급하지 않고 빈 문자열을 준다 —
    // 아래 판정기는 이것을 헤더 없음으로 읽는다. 보수적(fail-closed) 방향이다.
    return '';
  }
}

const EXCEPTIONS = JSON.parse(fsSync.readFileSync(EXCEPTIONS_PATH, 'utf-8'));

/** #6 이 감시하는 파일명들. 판정기에는 문자열만 넘긴다. */
const DERIVED_RENDER_BASENAMES = EXCEPTIONS.derivedRenderBasenames.map((e) => e.basename);

/**
 * 파일명이 리포에 **실재하는 근거**를 찾는다. T-50 #6 이 잡은 결함에 대한 대응:
 * `derivedRenderBasenames` 가 문자열 배열이던 때 소비처는 2곳인데 단언이 0 이라
 * `"HANDOFF.md"` 를 지워도 게이트가 그린이었다(추적 HANDOFF.md 가 0건이므로 지워도
 * 아무 차이가 없다). 앵커 없는 목록은 조용히 비어 가고, 비어 가는 순간 #6 은
 * 아무것도 감시하지 않으면서 계속 초록을 낸다.
 *
 * 근거 2종:
 *   tracked-file   — 그 basename 을 가진 추적 파일이 있다.
 *   generator-code — 그 파일을 만드는 소스에 따옴표 문자열로 등장한다.
 *
 * `git grep` 으로 **추적 파일만** 훑고 `lib/`·`scripts/`·`hooks/` 로 제한한다.
 * 테스트를 제외하는 이유: 테스트에만 나오는 이름은 "생성기가 있다" 의 근거가 아니다.
 * 그걸 근거로 인정하면 이 파일 자신이 자기 앵커가 되어 항진명제가 된다.
 */
function findBasenameAnchor(basename) {
  const trackedHit = TRACKED.find((p) => p.slice(p.lastIndexOf('/') + 1) === basename);
  if (trackedHit) return { route: 'tracked-file', evidence: trackedHit };

  for (const quoted of [`'${basename}'`, `"${basename}"`]) {
    let out = '';
    try {
      out = execFileSync(
        'git',
        ['grep', '-n', '--fixed-strings', quoted, '--',
          '*/lib/*.js', '*/scripts/*.js', '*/hooks/*.js',
          'lib/*.js', 'scripts/*.js', 'hooks/*.js'],
        { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      // exit 1 = 매치 없음(정상). 그 외는 도구 오류 — 삼키면 "앵커 없음" 으로
      // 잘못 읽혀 거짓 red 가 난다. 그대로 던진다.
      if (err.status !== 1) {
        throw new Error(`git grep 예상 밖 종료(${err.status}): ${err.stderr ?? ''}`, { cause: err });
      }
    }
    const line = out.split('\n').find((l) => l.trim() && !/\/tests?\//.test(l));
    if (line) return { route: 'generator-code', evidence: line.trim() };
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// 자기검증 — 판정기가 픽스처 위반을 실제로 잡는가 (규율 §10)
// ───────────────────────────────────────────────────────────────────────────

describe('artifact-governance 자기검증 — 판정기가 위반을 잡는가', () => {
  it('#1 판정기가 v1.1 9패턴을 전부 잡는다', () => {
    const fixture = [
      'missions/m1/intent-v2.md',
      'missions/m1/intent-final.md',
      'missions/m1/plan-v3.md',
      'missions/m1/plan-final.md',
      'missions/m1/plan2.md',
      'missions/m1/new-plan.md',
      'missions/m1/todo.md',
      'missions/m1/progress.md',
      'missions/m1/status.md',
    ];
    expect(findFilenameViolations(fixture).sort()).toEqual(fixture.slice().sort());
  });

  it('#1 판정기가 확장 3패턴을 잡는다', () => {
    const fixture = ['a/PRD-X-2.md', 'a/PRD-X-final.md', 'a/PRD-X-new.md'];
    expect(findFilenameViolations(fixture).sort()).toEqual(fixture.slice().sort());
  });

  it('#1 판정기가 날짜 접미와 비-md 를 위반으로 보지 않는다', () => {
    expect(
      findFilenameViolations([
        '.artibot/archive/2026-06/DEADCODE-BACKLOG-2026-06-05.md',
        'docs/notes-2026-01-02.md',
        'lib/plan-validator.js', // `.md` 한정이 아니면 plan-v* 에 걸렸을 것
        'lib/status.js',
        'README.md',
      ]),
    ).toEqual([]);
  });

  it('#2-a 판정기가 같은 slug 2개를 잡고, CRLF frontmatter 를 읽는다', () => {
    const heads = {
      'a.md': '---\r\nslug: dup-one\r\nrevision: 1\r\n---\r\n# A\r\n',
      'b/c.md': '---\nslug: dup-one\n---\n# C\n',
      'd.md': '---\nslug: unique\n---\n',
      'e.md': '# no frontmatter\nslug: not-frontmatter\n',
    };
    const found = findSlugDuplicates(Object.keys(heads), (p) => heads[p]);
    expect(found).toEqual([{ slug: 'dup-one', files: ['a.md', 'b/c.md'] }]);
  });

  it('#2-a 판정기가 frontmatter 밖의 slug 를 세지 않는다', () => {
    // 본문 안의 `slug:` 두 줄을 frontmatter 로 오독하면 거짓 red 가 난다.
    const heads = { 'x.md': '# t\nslug: same\n', 'y.md': '# t\nslug: same\n' };
    expect(findSlugDuplicates(Object.keys(heads), (p) => heads[p])).toEqual([]);
  });

  it('#2-b 판정기가 번호 겹치는 ADR 두 계열을 잡는다', () => {
    // 경로는 합성 픽스처다. B2 이행(2026-09-03) 전에는 여기 실제 두 계열
    // (`docs/adr` + `plugins/artibot/docs/adr`)의 이름을 그대로 썼는데, 이제 그
    // 둘 다 존재하지 않으므로 독자가 픽스처를 라이브 상태로 오독하지 않도록
    // 정본(`.artibot/adr`) + 가상의 두 번째 계열로 바꿨다. 단언 구조·정렬 근거는
    // 그대로다 — 이 테스트가 재는 것은 경로 이름이 아니라 겹침 판정이다.
    const fixture = [
      '.artibot/adr/ADR-001-a.md',
      '.artibot/adr/ADR-002-b.md',
      'docs/adr/ADR-001-c.md',
      'docs/adr/ADR-005-d.md',
    ];
    expect(findAdrSeriesCollisions(fixture)).toEqual([
      { dirs: ['.artibot/adr', 'docs/adr'], sharedNumbers: [1] },
    ]);
  });

  it('#2-b allowlist 는 등록된 쌍만 면제하고 다른 쌍은 그대로 red 다', () => {
    const fixture = [
      '.artibot/adr/ADR-001-a.md',
      'docs/adr/ADR-001-c.md',
      'other/adr/ADR-001-e.md',
    ];
    const allowed = [['.artibot/adr', 'docs/adr']];
    const found = findAdrSeriesCollisions(fixture, allowed);
    // 등록된 한 쌍만 빠지고, `other/adr` 이 만드는 두 쌍은 남는다.
    expect(found.map((c) => c.dirs.join(' ↔ ')).sort()).toEqual([
      '.artibot/adr ↔ other/adr',
      'docs/adr ↔ other/adr',
    ]);
  });

  it('#4 판정기가 스코프 안 원장을 잡고 중앙 원장은 통과시킨다', () => {
    const fixture = [
      '.artibot/runtime/ledger.jsonl', // 중앙 — 유일한 정본
      '.artibot/ledger/session.jsonl',
      'plugins/artibot/runtime/decision-trail.json',
      'plugins/artibot/.artibot/ledger/x.ndjson',
      'reports/SPLIT/y.events.ndjson', // 스코프 밖 — 못 보는 것 #4
      'lib/core/thing.js',
    ];
    expect(findDispersedLedgers(fixture).sort()).toEqual([
      '.artibot/ledger/session.jsonl',
      'plugins/artibot/.artibot/ledger/x.ndjson',
      'plugins/artibot/runtime/decision-trail.json',
    ]);
  });

  it('#4 allowlist 는 등록된 경로만 면제한다', () => {
    const fixture = ['.artibot/a.jsonl', '.artibot/b.jsonl'];
    expect(findDispersedLedgers(fixture, ['.artibot/a.jsonl'])).toEqual(['.artibot/b.jsonl']);
  });

  it('#6 판정기가 헤더 없는 파생 렌더를 잡고 있는 것은 통과시킨다', () => {
    const heads = {
      'x/HANDOFF.md': '---\r\nmachineId: m\r\nbranch: master\r\n---\r\n# H\r\n',
      'y/NEXT-SESSION.md': '# NEXT-SESSION\n본문만 있고 frontmatter 가 없다\n',
      'z/HANDOFF.md': '---\nderived-from: state@42\n---\n# ok\n',
      'w/README.md': '# 대상 아님\n',
    };
    expect(findMissingDerivedFrom(Object.keys(heads), (p) => heads[p]).sort()).toEqual([
      'x/HANDOFF.md',
      'y/NEXT-SESSION.md',
    ]);
  });

  it('#6 allowlist 는 등록된 경로만 면제한다', () => {
    const heads = { 'a/HANDOFF.md': '# none\n', 'b/HANDOFF.md': '# none\n' };
    expect(
      findMissingDerivedFrom(Object.keys(heads), (p) => heads[p], {
        allowedPaths: ['a/HANDOFF.md'],
      }),
    ).toEqual(['b/HANDOFF.md']);
  });

  it('하네스 자기검증: 판정기 4종이 빈 입력에 빈 결과를 낸다', () => {
    // 항상 뭔가를 돌려주는 판정기는 아래 라이브 테스트를 무의미하게 만든다.
    expect(findFilenameViolations([])).toEqual([]);
    expect(findSlugDuplicates([], () => '')).toEqual([]);
    expect(findAdrSeriesCollisions([])).toEqual([]);
    expect(findDispersedLedgers([])).toEqual([]);
    expect(findMissingDerivedFrom([], () => '')).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 예외 목록 자기검증 (설계 R-10 — 동결 예외가 영구 면제로 굳는 것을 막는다)
// ───────────────────────────────────────────────────────────────────────────

describe('artifact-governance 예외 목록 — 형식과 신선도', () => {
  it('예외 파일이 실재하고 파싱된다', () => {
    // 파일이 사라지면 red. 조용히 skip 하면 예외가 통째로 무한정 넓어진다.
    expect(fsSync.existsSync(EXCEPTIONS_PATH)).toBe(true);
    expect(EXCEPTIONS.schemaVersion).toBe(1);
    expect(typeof EXCEPTIONS.measuredAt).toBe('string');
    expect(EXCEPTIONS.baseCommit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('#2 예외가 비어 있다 — B2 이행 완료(면제할 것이 없다)', () => {
    // 기대값을 1 → 0 으로 바꾼 이유. 게이트를 통과시키려 깎은 것이 아니라 **조인
    // 것**이다. 예외 1쌍은 "ADR 계열이 둘이라 번호가 겹친다" 는 위반을 면제하고
    // 있었다. 결정 B2(오너, 2026-09-03 최종)가 두 계열을 `.artibot/adr/` 한 곳으로
    // 합치면서 그 위반 자체가 사라졌다 — `plugins/artibot/docs/adr/` 5건은 `git mv`
    // 로 번호 그대로, 루트 `docs/adr/` 5건은 006~010 재번호로 옮겼고 원본 디렉터리
    // 둘 다 없앴다. 면제 대상이 없어졌는데 면제를 남겨 두면, 나중에 누가 두 번째
    // 계열을 만들었을 때 조용히 통과한다 — 정확히 R-10 이 막으려는 형태다.
    expect(EXCEPTIONS.check2_canonicalPairs).toEqual([]);

    // 빈 목록만 단언하면 항진명제다("아무것도 없다"는 언제나 참이 되기 쉽다).
    // B2 의 **결과**를 양성으로 못박는다: 추적 중인 ADR 계열은 정확히 한 곳이고,
    // 그곳이 `.artibot/adr/` 다. 두 번째 계열이 생기면 여기서 먼저 red 가 난다.
    // `lastIndexOf('/') === -1`(리포 루트 직속 파일)을 slice 로 흘려보내면 경로가
    // 잘려 조용히 다른 디렉터리로 집계된다. 루트는 '' 로 명시한다.
    const dirOf = (f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
    const baseOf = (f) => (f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f);
    const adrDirs = [...new Set(
      TRACKED.filter((f) => /^ADR-\d{3,}[-.]/.test(baseOf(f))).map(dirOf),
    )].sort();
    expect(adrDirs).toEqual(['.artibot/adr']);

    // 자기검증: 위 필터가 실제로 무언가를 세고 있다(0건이면 항진명제가 된다).
    // 고정값 10 을 쓰지 않는 이유 — 이 게이트는 **인덱스**(`git ls-files`)를 잰다.
    // 001~005 는 `git mv` 라 인덱스에 이미 새 경로로 들어와 있지만, 재번호된
    // 006~010 과 INDEX.md 는 신규 파일이라 커밋되기 전까지 워킹트리에만 있어
    // 여기 안 잡힌다. 커밋 후 10, 그 전 5. 하한을 5 에 걸어 둔다 — 5 아래로
    // 내려가면 원래 추적본이 사라진 것이므로 red 다.
    expect(TRACKED.filter((f) => /^ADR-\d{3,}[-.]/.test(baseOf(f))).length)
      .toBeGreaterThanOrEqual(5);
  });

  it('모든 예외 항목이 포인터 필드를 갖는다 (R-10)', () => {
    // 형식이 깨졌을 때 red. 목록이 비었을 때가 아니다 — PRD R-10 이 정한 형태.
    const all = [
      ...EXCEPTIONS.check2_canonicalPairs,
      ...EXCEPTIONS.check4_rawLogs,
      ...EXCEPTIONS.check6_derivedRenders,
    ];
    const bad = all.filter((e) => {
      const ptr = e.pending_decision ?? e.pending_implementation;
      return typeof ptr !== 'string' || ptr.trim() === '' || typeof e.reason !== 'string';
    });
    expect(bad).toEqual([]);
  });

  it('#4·#6 예외 경로가 아직 실재한다 (stale 예외는 red)', () => {
    // 예외가 가리키던 파일이 사라지거나 고쳐지면 항목을 지워야 한다. 남겨 두면
    // 그 자리에 새 위반이 들어와도 조용히 면제된다.
    const tracked = new Set(TRACKED);
    const stale = [
      ...EXCEPTIONS.check4_rawLogs.map((e) => e.path),
      ...EXCEPTIONS.check6_derivedRenders.map((e) => e.path),
    ].filter((p) => !tracked.has(p));
    expect(stale).toEqual([]);
  });

  it('derivedRenderBasenames 카디널리티가 고정돼 있다 (T-50 #6)', () => {
    // 앵커 없는 배열은 조용히 비어 간다. 항목이 늘거나 줄면 사람이 보게 만든다 —
    // 특히 **줄어드는 쪽**이 위험하다: 이름 하나가 빠지면 #6 은 그 파일을 영영
    // 감시하지 않으면서 계속 초록을 낸다.
    expect(EXCEPTIONS.derivedRenderBasenames).toHaveLength(2);
    expect(DERIVED_RENDER_BASENAMES.slice().sort()).toEqual(['HANDOFF.md', 'NEXT-SESSION.md']);
  });

  it('앵커 판정기 자기검증: 실재하지 않는 이름에는 앵커를 못 찾는다', () => {
    // 이게 없으면 아래 단언이 항진명제가 된다 — 항상 truthy 를 내는 판정기는
    // 어떤 목록이든 통과시킨다. 정확히 T-50 이 지적한 실패 형태다.
    expect(findBasenameAnchor('THIS-FILE-DOES-NOT-EXIST-9f3a.md')).toBeNull();
    // 반대 방향도 낼 수 있어야 한다.
    expect(findBasenameAnchor('HANDOFF.md')).not.toBeNull();
  });

  it.each(
    EXCEPTIONS.derivedRenderBasenames.map((e) => [e.basename, e]),
  )('파생 렌더 %s 는 리포에 실재하거나 포인터를 갖는다', (basename, entry) => {
    const anchor = findBasenameAnchor(basename);
    if (anchor === null) {
      // 실체가 없다면 예외 파일의 $comment 가 약속한 포인터 규칙을 적용한다.
      expect(entry.anchor).toBe('none');
      expect(typeof entry.pending_decision).toBe('string');
      expect(entry.pending_decision.trim()).not.toBe('');
      expect(entry.reason?.trim() ?? '').not.toBe('');
      return;
    }
    // 실체가 있다면 선언한 근거 종류가 실제와 맞아야 한다. 종류가 바뀌는 것은
    // 사실이 바뀐 것이다(예: 생성기가 지워졌는데 목록만 남음).
    expect(anchor.route).toBe(entry.anchor);
    expect(entry.reason?.trim() ?? '').not.toBe('');
  });

  it('#6 예외 항목은 아직 헤더가 없어야 한다 (고쳐졌으면 예외를 지워라)', () => {
    const fixed = EXCEPTIONS.check6_derivedRenders
      .map((e) => e.path)
      .filter((p) => readFrontmatterKey(readHeadFromRepo(p), 'derived-from') !== null);
    expect(fixed).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 라이브 판정 — 인덱스 기준
// ───────────────────────────────────────────────────────────────────────────

describe('artifact-governance 라이브 — git ls-files 기준', () => {
  it('분모 자기검증: 추적 목록이 실제로 크다', () => {
    // 목록이 비면 아래 네 검사는 전부 자동 통과한다. 실측 1,782(dc9a4c12).
    expect(TRACKED.length).toBeGreaterThan(1000);
    expect(TRACKED.filter((p) => /\.md$/i.test(p)).length).toBeGreaterThan(300);
  });

  it('#1 금지 파일명 패턴 위반이 없다', () => {
    expect(findFilenameViolations(TRACKED)).toEqual([]);
  });

  it('#2-a 같은 slug 를 선언한 추적 md 가 둘 이상인 경우가 없다', () => {
    expect(findSlugDuplicates(TRACKED, readHeadFromRepo)).toEqual([]);
  });

  it('#2-b ADR 번호 계열이 겹치는 디렉터리 쌍이 예외 밖에 없다', () => {
    const allowed = EXCEPTIONS.check2_canonicalPairs.map((e) => e.pair);
    expect(findAdrSeriesCollisions(TRACKED, allowed)).toEqual([]);
  });

  it('#4 중앙 원장 밖 분산 원장이 예외 밖에 없다', () => {
    const allowed = EXCEPTIONS.check4_rawLogs.map((e) => e.path);
    expect(findDispersedLedgers(TRACKED, allowed)).toEqual([]);
  });

  it('#6 derived-from 헤더 없는 파생 렌더가 예외 밖에 없다', () => {
    const allowed = EXCEPTIONS.check6_derivedRenders.map((e) => e.path);
    expect(
      findMissingDerivedFrom(TRACKED, readHeadFromRepo, {
        basenames: DERIVED_RENDER_BASENAMES,
        allowedPaths: allowed,
      }),
    ).toEqual([]);
  });

  it('현황 카운트: 추적 중인 파생 렌더 파일 수가 예외 수와 맞다', () => {
    // #6 은 "이행 후 검사" 가 아니라 지금 세는 검사다. 파생 렌더가 하나 더
    // 추적되면(헤더가 있든 없든) 이 줄이 red 가 되어 사람이 보게 된다.
    const basenames = new Set(DERIVED_RENDER_BASENAMES);
    const rendered = TRACKED.filter((p) => basenames.has(p.slice(p.lastIndexOf('/') + 1)));
    expect(rendered).toEqual(['.artibot/guides/NEXT-SESSION.md']);
  });
});
