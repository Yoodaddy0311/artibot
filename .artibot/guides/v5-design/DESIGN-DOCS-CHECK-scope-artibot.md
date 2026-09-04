# 설계안 — `docs:check` 스코프에 리포 루트 `.artibot/**`·`reports/SPLIT/**` 추가

> **오너 승인 전 구현 금지.** 설계안이다. 코드·테스트·baseline·config 무변경. 이 파일 1개만 신설했다.
> 작성: architect (team-handoff-9d6dc2, fable), 2026-09-04 14:5x–15:0x KST · 기준 master @ `ca013e2c` (v4.54.0) · 경로는 `plugins/artibot/` 기준(리포 루트 파일은 `<root>/`). 줄번호는 14:5x 워킹트리 측정값.
> 근거 정본: `ARTIBOT-5.0-DESIGN.md` 후속 1(`:762` "docs:check 스코프 490 → 479(-11) … `validate-doc-links.js` 가 리포 루트 `.artibot/` 을 훑지 않는다 → ADR 링크 썩음을 게이트가 영영 못 본다" · 성격 "후속(설계)") · 부록 0-2 후속(2) `:908` ⑤ "docs:check 스코프 확대 … 보류(설계안 부재) — 설계안이 서면 재상정" · 오너 15:0x "docs:check·trail 설계안 작성"(정본 후속(2) 표엔 아직 없음 — 리더/record 가 추가).
> 스크래치 실측 산출물: `<scratchpad>/link-census-artibot-reports.json` · `render-census-artibot-reports.json` · 측정 스크립트 `measure-links.mjs`·`measure-render.mjs`(스캐너의 export 함수를 그대로 호출 — 별도 파서 아님).

---

## 0. 한 줄 판정

`npm run docs:check` 는 두 스캐너(`validate-doc-links.js` → `validate-md-rendering.js`)가 **플러그인 3루트 + 리포 루트 5파일**만 본다. 설계 정본·ADR·split 런 보고서가 사는 `<root>/.artibot/**`·`reports/SPLIT/**`(git 추적 **93 md**) 는 밖이다. 오늘 실측: **링크 단계는 93/93 깨진 링크 0**, **렌더링 단계는 15건 위반**(정본 `ARTIBOT-5.0-DESIGN.md:636-647` 표 12 · PLANNER 1 · `reports/SPLIT/split-8f83d7.md` 2). 즉 스코프를 그대로 넓히면 링크는 GREEN, 렌더링은 **RED** — 이 15건을 baseline(래칫)에 올릴지 먼저 고칠지가 유일한 실질 결정이다. 권장: **추적 파일만·서브트리 허용목록·fail-closed(바닥값 + 래칫)** 로 넣고, 15건은 **정본 표를 고쳐서 0 으로 만든 뒤** 넣는다(baseline 에 정본을 올리면 "정본이 깨져 있다"를 게이트가 영구 승인하는 꼴).

---

## 1. 현행 실측

### 1.1 스코프 (두 스캐너 공통, `ci-utils.js` 가 정본)

| 대상 | 정의 | 값(14:52) |
|---|---|---|
| 플러그인 루트 | `ci-utils.js#listPluginRoots` — `artibot`·`artibot-cowork`·`_shared` | 3 |
| 플러그인 하위 스캔 디렉터리 | `validate-doc-links.js:~66 SCAN_DIRS = ['commands','skills','docs','rubrics']` + `SCAN_FILES = ['CLAUDE.md','README.md','AGENTS.md']`, `validate-md-rendering.js:65` 동일 목록(lockstep 주석) | `_shared=4 artibot=327 artibot-cowork=144` |
| 리포 루트 | `ci-utils.js:223 ROOT_SCAN_FILES = ['README.md','CONTRIBUTING.md','INSTALL.md','CLAUDE.md','AGENTS.md']`, 존재하는 것만(`:274-278`) | `<root>=4`(AGENTS.md 부재) |
| **합계** | | **479 파일, 0 broken** (`npm run docs:check` 14:52 출력 — 리더 인용 478 은 l1-ups 14:3x 측정, 그 사이 +1) |
| 무시 디렉터리 | `IGNORE_DIRS = node_modules·runtime·repos·.git·_reports·coverage·.vitest`(`validate-doc-links.js:~55`) | 디스크 워크(`collectMarkdown :271`), git 아님 |
| 바닥값(fail-closed) | `MIN_DOC_FILES = { artibot:300, 'artibot-cowork':100, _shared:4 }`(`ci-utils.js:175-179`) · `MIN_ROOT_DOC_FILES = 4`(`:243`, 실측값 정확 핀) · `assertScanFloors`(`:187`) 는 **모르는 키도 실패** | 분모 결손 시 exit 1(`validate-doc-links.js:354`) |
| 컨테인먼트 | `main() :327-338` — `repoRoot ?? getPluginsDir()`; 링크가 컨테인먼트 **밖**으로 해석되면 **건너뜀**(`findBrokenLinks :226-229` — 2026-08-19 사각지대의 두 번째 절반) | dev 리포에선 `<root>` |
| dev 리포 판정 | `ci-utils.js:255 DEV_REPO_MARKER = .claude-plugin/marketplace.json`; 설치본(`~/.claude/plugins`)에선 루트 스캔 자체를 건너뜀(`getRepoDocRoot :263`) | |
| 렌더링 래칫 | `validate-md-rendering.js:103 KNOWN_RENDER_VIOLATIONS`(파일 키 → 허용 건수), `applyRatchet :417` — 초과는 RED, **감소도 stale 로 RED**("baseline can only ever be tightened by hand") | 현재 2 baselined |

`.artibot/` 은 어느 목록에도 없다. `reports/` 도 없다(`reports/*` 는 `.gitignore:75` 로 무시, `!reports/SPLIT/` `:76` 만 재포함).

### 1.2 대상 트리 (git 추적, `git ls-files -z`, 14:53)

| 트리 | 추적 md | 비고 |
|---|---|---|
| `.artibot/guides/` | 75 (전체 추적 96 — json 9·yaml 6·mmd 4·ndjson 1·기타) | 설계 정본·PRD·패키지 사본. 리더 인용 95 는 13:0x 값, +1 |
| `.artibot/adr/` | 11 | **후속 1 의 동기** — B2 로 ADR 이 여기 단일화됐다 |
| `.artibot/archive/` | 4 | 2026-06 진단 문서 |
| `.artibot/project.md` | 1 | `ARTIBOT.md` 읽기 순서 1번 |
| `reports/SPLIT/` | 2 | `/split` 런 보고서(`split.md` 측정 고지가 인용) |
| **합계** | **93** | ⚠️ `git ls-files .artibot \| grep -c '\.md$'` 는 **86** 으로 나온다 — 한글 경로 5개가 C-quote(`"…"`)로 감싸져 `$` 매치가 빠진다. 후속 19 클래스. **`-z` 로 세면 91**(+reports 2 = 93) |
| 참고: `reports/` 디스크 전체 | 3,064 md | 3,062 개는 미추적(gitignore) — **디스크 워크로 넣으면 로컬·CI 결과가 갈린다** |
| 참고: `.artibot/` 미추적 로컬 | `HANDOFF.md`·`SESSION-NOTES.md`·`split/`·`missions/`·`runtime/` | 같은 이유로 제외 대상 |

### 1.3 하드 증거 — 실제 깨진 것 (스캐너 함수 그대로 호출, 14:53)

| 단계 | 함수 | 대상 | 결과 |
|---|---|---|---|
| 링크·앵커·펜스 | `validate-doc-links.js#findBrokenLinks(content, abs, repoRoot=<root>)` | 93 파일 | **0 broken** (link 0 · anchor 0 · fence 0) |
| 렌더링 2규칙 | `validate-md-rendering.js#RULES`(`ruleBacktickInInlineCode`·`ruleTablePipeMismatch`) | 93 파일 | **15 findings** — `ARTIBOT-5.0-DESIGN.md` **12**(`:636-647` 부록 0-2 표 `table-pipe-column-mismatch`) · `PLANNER-PARALLELIZATION-DESIGN.md` 1 · `reports/SPLIT/split-8f83d7.md` 2 |
| worktree 미추적 `docs/` 참조 | `.artibot/guides` 안 `](…docs/…)` 마크다운 링크 | grep | **0건** — 산문·백틱 경로(`docs/PRD/…`)는 있으나 링크가 아니라 스캔 대상 아님(`maskCodeFences :105`) |

등급: 전부 **실측**(스크래치 JSON 2개에 시각·분모 보존). "ADR 링크가 썩었다" 는 **오늘 기준 0** — 후속 1 은 **사각지대**의 지적이지 현재 결함이 아니다(B2 이행 시 후속 10 이 포인터 2곳을 손으로 고쳤고 그 결과가 0 이다). 사각지대는 다음 이동 때 다시 열린다.

### 1.4 후속 1 의 "490 → 479(-11)" 정정
`:762` 는 B2 로 `plugins/artibot/docs/adr/` 5파일 등이 `.artibot/adr/` 로 이동해 플러그인 스코프에서 빠진 것을 -11 로 적었다. 오늘 479 로 재확인되며, 그 11 은 **`.artibot/adr/` 11 파일과 수가 같다**(우연이 아닌지 — ADR 5 + INDEX 등 6 이 옮겨간 것인지는 `git log --diff-filter=R` 로 재확인 가능, **미실시**).

---

## 2. 설계

### 2.1 스코프 정의 — 서브트리 **허용목록** (부정 목록 아님)

`ci-utils.js` 에 상수 1개 신설(두 스캐너가 공유 — lockstep 주석 `validate-md-rendering.js:62` 의 정신):
```js
/** Repo-root subtrees scanned in addition to ROOT_SCAN_FILES. Git-TRACKED files only. */
export const ROOT_SCAN_TREES = Object.freeze([
  '.artibot/guides',
  '.artibot/adr',
  '.artibot/archive',
  'reports/SPLIT',
]);
export const ROOT_SCAN_TREE_FILES = Object.freeze(['.artibot/project.md']);
```
- **`.artibot/` 전체가 아닌 이유**: `HANDOFF.md`·`SESSION-NOTES.md`·`split/`·`missions/`·`runtime/` 는 로컬 산출물(미추적)이라 디스크 워크에 넣으면 CI 와 로컬이 갈린다(F-10 §5 와 같은 판단). `IGNORE_DIRS` 의 `runtime` 만으로는 `split/`·`missions/` 를 못 거른다.
- **`reports/**` 가 아닌 `reports/SPLIT` 인 이유**: `reports/*` 는 gitignore, `SPLIT` 만 추적(`.gitignore:75-76`). 3,062 미추적 파일을 스캔하면 로컬 전용 결과.
- **추적 파일만**: 서브트리 안에서도 `git ls-files -z -- <tree>` 로 목록을 얻는다(디스크 워크 대신). `-z` 필수 — 한글 경로 5개가 C-quote 로 깨진다(§1.2, 후속 19 클래스). git 부재/실패 시 **fail-closed**(exit 1, "cannot enumerate tracked docs") — 조용히 디스크 워크로 폴백하지 않는다.
- 설치본(`~/.claude/plugins`)에선 `getRepoDocRoot()` 가 null 이라 자동으로 건너뛴다(기존 규칙 유지).

### 2.2 링크 규칙
- 컨테인먼트는 이미 `<root>` (`main :338`)이므로 `.artibot/guides/x.md → ../../plugins/artibot/lib/…` 같은 교차 링크도 판정된다. 추가 규칙 없음.
- **worktree**: `.artibot/guides`·`adr`·`archive`·`reports/SPLIT` 은 전부 추적이라 worktree 에 존재. 미추적 `docs/` 로 가는 **마크다운 링크는 0**(§1.3) — 규칙 불필요. 생기면 컨테인먼트 안(`<root>/docs/…`)이라 broken 으로 잡힌다 = **의도**(정본이 미추적 파일을 링크하면 CI 에서 썩는다는 사실을 게이트가 말해야 한다). 예외 허용목록은 두지 않는다 — 필요해지면 그때 `KNOWN_BROKEN_LINKS` 래칫을 md-rendering 과 같은 형태로.
- 앵커: 정본은 `§` 헤딩을 쓰고 같은 파일 앵커 참조가 0 broken — 규칙 변경 없음.

### 2.3 게이트 — fail-closed 3중
1. **바닥값**: `MIN_ROOT_TREE_DOC_FILES = 93`(측정값 정확 핀 — `MIN_ROOT_DOC_FILES` 와 같은 원칙 `ci-utils.js:236-242`; 정본이 늘면 올리고, 줄면 RED 가 맞다). `assertRootScanFloor` 옆에 `assertRootTreeScanFloor`.
2. **렌더링 래칫**: `KNOWN_RENDER_VIOLATIONS` 에 **정본 키를 올리지 않는다**. §1.3 의 15건은 **먼저 고친다**(정본 표 12 = `|` 이스케이프, PLANNER 1, `reports/SPLIT` 2). 고친 뒤 스코프 확대 → 0 위반으로 진입. 이유: 래칫은 "알려진 옛 결함을 조용히 두는" 장치인데 정본은 지금도 편집 중이라 baseline 이 곧 stale(감소도 RED `applyRatchet :443`)이 되어 다음 편집자를 물게 된다.
   - ⚠️ `ARTIBOT-5.0-DESIGN.md` 는 **리더/record 소유**(2차 plan `leaderOwned`) — 12건 수정은 record 레인이 한다. 이 설계안은 위치만 준다.
3. **enumeration 실패 = RED**(§2.1).

### 2.4 변경 지점 · 소유 파일
| 파일 | 변경 |
|---|---|
| `scripts/ci/ci-utils.js` | `ROOT_SCAN_TREES`·`ROOT_SCAN_TREE_FILES`·`MIN_ROOT_TREE_DOC_FILES`·`gatherRepoRootTreeDocFiles()`(git ls-files -z)·`assertRootTreeScanFloor()` |
| `scripts/ci/validate-doc-links.js` | `main()` 에 트리 파일 합류 + 바닥값 + tally `<root-trees>=N` |
| `scripts/ci/validate-md-rendering.js` | `scanRepoRoot :390` 옆 `scanRepoRootTrees` 동일 합류 |
| `tests/ci/ci-utils.test.js` | 상수 핀 3개 + `gatherRepoRootTreeDocFiles` (git 실패 → throw) |
| `tests/ci/validate-doc-links.test.js` · `tests/ci/validate-md-rendering.test.js` | 트리 합류 케이스 |
| (선행, record 레인) `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md:636-647` · `PLANNER-PARALLELIZATION-DESIGN.md` · `reports/SPLIT/split-8f83d7.md` | 렌더링 15건 수정 |
| `CHANGELOG.md` | 리더 통합 시 |

**겹침 대조**(2차 4줄기 + 3차 L2 Check 10): `scripts/ci/*`·`tests/ci/*` 는 어느 줄기도 소유하지 않는다 → **0**. `.github/workflows/plugin-validate.yml` 은 p19-rest 소유이나 이 설계는 워크플로 무변경(`npm run docs:check` 가 `ci` 체인 안에 이미 있음 `package.json:25-26`). 정본 15건 수정은 리더 소유 파일이라 겹침이 아니라 **선행 의존**.

### 2.5 되돌리기
`ROOT_SCAN_TREES = []` + 바닥값 상수 삭제 = 1커밋. 래칫에 정본 키를 안 올렸으므로 baseline 원복 없음.

### 2.6 못 보는 것 (게이트 옆에 적는다)
1. **미추적 파일**(HANDOFF·SESSION-NOTES·split 브리프·3,062 reports) — 의도적 제외. 로컬에서만 썩는다.
2. **백틱 안 경로**(`docs/PRD/…`, `file:line` 인용) — 마스킹돼 스캔 밖. 코드→코드 인용 썩음은 `citation-resolution` 게이트 소관(정본 `:642` 규율).
3. **참조형 링크·HTML 앵커·외부 URL** — 기존 한계(`validate-doc-links.js:31-34`) 그대로.
4. **설치본** — 루트 스캔 자체가 없다(dev 리포 마커).
5. **`§` 교차 파일 앵커**(`파일.md#§3.2`) — 같은 파일 앵커만 검사(`:34`). 정본이 다른 문서의 절을 가리키는 링크는 파일 존재만 본다.

---

## 3. 완료 판정
| | 기준 | 증거 |
|---|---|---|
| D0(선행) | 렌더링 15건 → 0 (record 레인) | `measure-render.mjs` 재실행 0 |
| D1 | `npm run docs:check` 출력에 `<root-trees>=93`(측정 시점 값) 포함, 0 broken, baseline 2 unchanged | 명령 출력 |
| D2 | 바닥값 자기검증: `ROOT_SCAN_TREES` 에서 `.artibot/adr` 를 빼면 RED · git 실패 주입 시 RED | 테스트 로그 |
| D3 | 한글 경로 5파일이 스캔 목록에 포함됨(`-z`) — 목록 길이 91 = `-z` 카운트 | 테스트 단언 |
| D4 | 리포 전체 vitest 수치 + `npm run ci` GREEN | 출력 |

## 4. 오너 결정 필요 항목 (신규 방향만)
| # | 질문 | 권장 |
|---|---|---|
| 1 | 렌더링 15건을 **고치고 넣을지**(권장) vs **baseline 에 올려 넣을지** | 고친다 — 정본을 baseline 에 올리면 다음 편집이 stale RED 를 만든다 |
| 2 | 스코프를 서브트리 허용목록(권장)으로 할지 `.artibot/**` 전체(미추적 포함)로 할지 | 허용목록 + 추적 파일만 |
(이미 결정: `reports/SPLIT` 만 추적 — `.gitignore:75-76`, B7 흡수 방향과 정합.)

## 미확인
- 후속 1 의 "-11" 이 정확히 `.artibot/adr/` 11 파일과 같은 집합인지 — `git log --diff-filter=R` 미실시.
- `validate-md-rendering.js` 규칙 객체 형태(`{name, fn}`)를 스크래치가 올바르게 호출했는지 — 15건 메시지가 스캐너 서식 그대로라 실측으로 보되, 스캐너 `main()` 을 직접 돌린 것은 아니다.
- CI(`ci.yml`)가 dev 리포 마커를 만족해 루트 스캔을 실제로 하는지 — 출력의 `<root>=4` 는 로컬 값이고 CI 로그는 미열람.
- `.artibot/guides` 의 yaml/mmd/ndjson 21파일은 md 스캐너 대상 밖 — 별개(F-10 §6-1 과 같은 항목).
