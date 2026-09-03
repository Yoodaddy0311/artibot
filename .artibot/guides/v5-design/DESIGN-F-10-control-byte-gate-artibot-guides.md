# 설계안 F-10 — control-byte 게이트 root 에 `.artibot/guides` 추가

> **오너 승인 전 구현 금지.** 설계안이다. 코드·테스트·게이트 무변경.
> 작성 2026-09-03 15:4x KST · master @ `3bcadb8e` · 게이트 파일은 `plugins/artibot/tests/firewall/no-control-bytes.test.js`(370줄, 직접 읽음).

---

## 0. 결론 먼저

- **추가한다. 조용한 skip 없이, 하드 요구로.** `.artibot/guides` 가 없으면 기존 `:233` "root 당 최소 1파일" 단언이 **그대로 터지게 두되**, 실패 메시지가 "리포 루트를 찾지 못했다 — 이 게이트는 전체 리포 체크아웃을 요구한다" 를 말하게 한다. 이 요구는 새 것이 아니다: `tests/firewall/artibot-entry-parity.test.js:63-75` 가 이미 `<repo>/ARTIBOT.md` 와 `.artibot/guides/v5-design/package-v1.1/19_ARTIBOT_TEMPLATE.md` 를 하드 요구한다. 플러그인 단독 체크아웃에서는 그 스위트가 먼저 RED 다.
- 경로 구조: `ROOTS` 문자열 배열 → `{ base: 'package'|'repo', rel }` 객체 배열. 보고 경로는 각 root 의 base 기준(플러그인 파일은 지금처럼 `lib/x.js`, 리포 파일은 `.artibot/guides/x.md`). 리포 루트는 `path.resolve(PACKAGE_ROOT, '..', '..')` + **정체 확인**(`<repo>/.claude-plugin/marketplace.json` 존재) — 아무 상위 디렉터리를 리포 루트로 오인하지 않게.
- **브리프 전제 정정 1건**: "기록된 사고: 리터럴 NUL 5파일" 은 두 기록의 혼합이다. **5파일은 `lib/` 소스**(T-51 검수 항목 — `reports/AUTOPILOT/ap-20260902-062936-tyc5j4.md:67`, 대상은 `ledger.js`·`plan-repair.js`·`usage-receipt.js` 등 `ARTIBOT-5.0-DESIGN.md:582`·`replay.js:128-131`), **`.artibot/guides` 에 남은 것은 1파일 1바이트**(`ARTIBOT-5.0-DESIGN.md:602` "부록 0-2 :582 에 리더 삽입 스크립트가 남긴 리터럴 NUL 1바이트 … 09:12 이스케이프"). 커밋에는 들어간 적 없다: HEAD `3bcadb8e`·`8710e3f1`·`64f99bec` 트리의 `.artibot/guides` 83파일 전수 `grep -P '\x00'` **0건**(15:41 실측). 워킹트리 현재 0건.
- **추가해도 못 보는 것**: `.artibot/guides` 83 추적 파일 중 `.yaml` 6·`.mmd` 4·`.ndjson` 1 = **11파일(13%)** 은 확장자 목록(`:79`) 밖이라 여전히 스캔 안 된다. 확장자 확대는 별도 결정(§6).

---

## 1. 실측

### 1.1 게이트 구조 (`no-control-bytes.test.js`)
- `:60` `PACKAGE_ROOT = path.resolve(__dirname, '../..')` = `plugins/artibot`.
- `:68-76` `ROOTS` 7종 전부 **플러그인 상대**: `lib scripts tests commands rules skills agents`.
- `:79` `EXTENSIONS = ['.js','.mjs','.cjs','.md','.json']`.
- `:215-218` 스캔 1회 공유: `ROOTS.map(root => scanTree(path.join(PACKAGE_ROOT, root), PACKAGE_ROOT))` — `relativeTo` 가 **PACKAGE_ROOT 로 고정**. 리포 루트 파일을 여기 그대로 넣으면 보고 경로가 `../../.artibot/guides/…` 가 된다.
- `:233-239` `it.each(ROOTS)('reads at least one file under %s')` — root 별 파일 수 > 0. 주석: "Failing here is the correct alarm — update ROOTS deliberately."
- `:241-245` 알려진 파일 도달 검사(`lib/core/model-catalog.js`).
- `:34-37` 헤더가 "seven roots" 와 "anywhere outside those roots (… repository root) is invisible" 을 명시 — 이 문장이 바뀌어야 할 산문.
- 스캔 비용 `:212-213` "~0.9s for ~1,480 files" (2026-09-02).

### 1.2 `.artibot/guides` 대상
- git 추적 **83파일**(`git ls-files .artibot/guides | wc -l`, 15:41): md 63 · json 9 · yaml 6 · mmd 4 · ndjson 1. 디스크에는 85(미추적 `v5-design/evidence/README.md`·`citation-census-20260903.json` 2건 — 다른 팀원 작업 중).
- 최대 파일 `ARTIBOT-5.0-DESIGN.md` 163,833B. 전체 약 0.7MB 추정(합산 미실측) — 1,480 파일 스캔 대비 무시 가능.
- 런타임에 읽히는가(브리프 전제 확인): `lib/project-state/doctor-checks.js:90` `ARTIFACT_HEALTH_SOURCE = '.artibot/guides/v5-design/ADDENDUM-HARDENING.md'`, `commands/doctor.md:363`(16:01 재측정 — 파일이 동시 편집 중) 같은 파일 994-1003줄을 정본으로 인용, `commands/resume.md:12` `NEXT-SESSION.md`. 나머지 `lib/*` 인용 5건은 주석. "읽힘" 은 참이되 **doctor 경로 1곳 + 산문**이다.
- `.artibot/` 전체 추적은 90파일(guides 83 + archive 4 + `project.md` + `failure-patterns.json` + `workflow-*.json`). 브리프 범위는 `guides` 만 — §5 에 확장 여부.

### 1.3 어디서 `.artibot/guides` 가 없을 수 있나
| 실행 문맥 | `.artibot/guides` | 근거 |
|---|---|---|
| 로컬 개발(이 리포) | 있음 | — |
| CI `ci.yml` | 있음 — `:80` 전체 체크아웃(sparse 아님), `:70` `working-directory: plugins/artibot` 에서 vitest | 직접 읽음 |
| `release.yml` | 있음 — `:64-66` `fetch-depth: 0` | 직접 읽음 |
| `/split` worktree | 있음 — worktree 는 전체 트리 | git 의미론 |
| 마켓플레이스 설치본에서 vitest | **미확인** — `marketplace.json` `source: "./plugins/artibot"`. 설치본이 리포 전체 클론의 하위인지, 플러그인 디렉터리만 복사인지 확인 안 함. 다만 여기서 vitest 를 돌리는 경로는 문서·스크립트 어디에도 없다(`package.json:28` `test` 스크립트는 리포 개발용) | — |
| 플러그인만 잘라낸 체크아웃 | 없음 — 그러나 `artibot-entry-parity.test.js:66-75` 가 먼저 RED | 직접 읽음 |

## 2. 경로 해석 구조 변경

```js
/** Package root (`plugins/artibot`). */
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
/**
 * Repository root, two levels above the package. Verified by the presence of
 * the marketplace manifest so a plugin checked out on its own cannot resolve
 * `../..` to some unrelated directory and then scan it.
 */
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const REPO_ROOT_WITNESS = path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json');

const BASES = Object.freeze({ package: PACKAGE_ROOT, repo: REPO_ROOT });

/**
 * Directories scanned. `base` says which root `rel` hangs off; reported paths
 * are relative to that base, so a hit under the repo root reads
 * `.artibot/guides/…` and one under the package reads `lib/…` as before.
 */
const ROOTS = Object.freeze([
  { base: 'package', rel: 'lib' },
  { base: 'package', rel: 'scripts' },
  { base: 'package', rel: 'tests' },
  { base: 'package', rel: 'commands' },
  { base: 'package', rel: 'rules' },
  { base: 'package', rel: 'skills' },
  { base: 'package', rel: 'agents' },
  // Repo-root design corpus: git-tracked, read by /doctor Check 9
  // (lib/project-state/doctor-checks.js:90) and by humans through grep. A
  // leader-side insertion script left a literal NUL in ARTIBOT-5.0-DESIGN.md
  // on 2026-09-03 (design appendix 0-2 :602); nothing scanned this tree.
  { base: 'repo', rel: '.artibot/guides' },
]);
```

- `:215-218` → `ROOTS.map(({base, rel}) => ({ root: `${base}:${rel}`, ...scanTree(path.join(BASES[base], rel), BASES[base]) }))`. `report()` (`:197-210`) 무변경 — 경로 문자열만 받는다.
- `:233` `it.each(ROOTS)` 의 `%s` 는 객체라 `[object Object]` 로 찍힌다 → `it.each(ROOTS.map(r => `${r.base}:${r.rel}`))` 또는 `it.each(ROOTS)('… %s', ({base, rel}) => …)` 에 `$rel` 포맷 사용. 구현 시 vitest 4 의 `%s`/`$prop` 포맷 확인.
- 리포 루트 정체 검사(신규 `it`): `expect(existsSync(REPO_ROOT_WITNESS)).toBe(true)` — 메시지에 "this gate requires the full repository checkout (same requirement as artibot-entry-parity.test.js)". `../..` 가 엉뚱한 곳을 가리키면 `.artibot/guides` 부재로 `:233` 이 터지기 전에 **원인**이 먼저 찍힌다.
- 알려진 파일 도달 검사 추가(`:241-245` 패턴): `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md` — 스캔이 v5-design 하위까지 내려감을 증명.

## 3. `:233` 단언과의 상호작용 — 판정

| 상황 | 결과 | 의도인가 |
|---|---|---|
| 전체 리포 체크아웃(로컬·CI·worktree) | 83+ 파일 → 통과 | 예 |
| `.artibot/guides` 가 비었거나 이름 변경 | `:233` RED "reads at least one file under repo:.artibot/guides" | 예 — `:234-236` 주석이 정확히 이 알람을 원한다 |
| 플러그인 단독 체크아웃 | 정체 검사 RED(원인 명시) + `:233` RED | 예 — 이미 `artibot-entry-parity` 와 같은 요구. **skip 하지 않는다** |

**조용한 skip 을 쓰지 않는 이유(브리프 요구)**: `existsSync ? it : it.skip` 형태는 이 리포에서 이미 "스펙 파일 부재 축 조용한 skip → 명시 실패 전환" 으로 지목된 선례가 있다(`reports/AUTOPILOT/ap-20260902-062936-tyc5j4.md:181` T-49 4차 `state-task-lease.test.js`). 게이트가 root 하나를 못 본 채 GREEN 이면 그것이 곧 다음 착시다.

**대안 B(오너가 플러그인 단독 실행을 지원하고 싶을 때만)**: 환경변수 `ARTIBOT_PLUGIN_ONLY=1` 을 명시 opt-out 으로 두되, skip 이 아니라 **별도 `it`** 가 `expect(process.env.ARTIBOT_PLUGIN_ONLY).toBe('1')` 을 통과하며 "repo roots NOT scanned — plugin-only mode declared by env" 를 테스트 이름으로 남긴다(출력에 보인다). 권고는 A. B 는 요구가 생길 때.

## 4. 되돌리기
`ROOTS` 에서 `{ base:'repo', rel:'.artibot/guides' }` 1항 삭제 + 정체 검사 `it` 삭제. `BASES` 구조는 남겨도 무해(`package` 만 쓰임). 헤더 `:34-37` 산문 원복.

## 5. 범위 결정 — `.artibot/guides` 인가 `.artibot` 전체인가
브리프는 `guides`. `.artibot` 전체(추적 90)로 넓히면 **미추적 런타임 파일**(`.artibot/HANDOFF.md`, `state.yaml`, `missions/*.md`, `runtime/*.json` — 로컬마다 다름)이 디스크 스캔에 들어온다(`listFiles :121-139` 는 git 이 아니라 디스크를 걷는다). 로컬 런타임 산출물의 제어 바이트가 로컬에서만 게이트를 깨는 비결정성이 생긴다. **`guides` 로 한정** 권고. 같은 이유로, 지금도 `guides` 아래 미추적 파일 2건이 스캔된다 — 로컬에서 먼저 잡히는 것은 장점(커밋 전 발견)이고, CI 와 로컬 결과가 다를 수 있는 것은 단점. 헤더에 "disk-walk, not git-walk" 를 적는다.

## 6. 이 게이트가 여전히 못 보는 범위 (게이트 옆에 적는다)
1. **확장자 밖 11/83**: `.yaml` 6(`package/config/*.yaml`, `package/schemas/*.yaml`, `package-v1.1/15_POLICY_EXAMPLE.yaml` 등) · `.mmd` 4 · `.ndjson` 1. `EXTENSIONS :79` 확대는 `:354-363` 이 `.txt/.bin` skip 을 **의도로 고정**한 테스트와 함께 결정할 별개 항목. 확대한다면 `.yaml/.yml/.mmd/.ndjson/.jsonl` 후보이며, `.jsonl` 은 `tests/` 픽스처에 바이너리성 데이터가 있는지 먼저 실측해야 한다(미확인).
2. **`.artibot/guides` 밖의 리포 루트 파일**: `ARTIBOT.md`, 루트 `CLAUDE.md`, `reports/`, `.github/`, `.claude-plugin/`, `docs/`(gitignore 로 대부분 미추적) — 여전히 미스캔. 헤더 `:34-37` 목록 유지.
3. **DEL(0x7F)·C1·BOM** — 기존 범위 밖(`:41-43`) 그대로.
4. **스냅샷** — `:47-48` 그대로. 다른 팀원이 `ARTIBOT-5.0-DESIGN.md` 를 지금도 편집 중이므로 GREEN 은 그 시각의 것.
5. **이스케이프된 제어문자의 옳음** — `:44-46` 그대로.
6. 게이트는 **파일 내용**만 본다. 파일명·경로에 제어 바이트가 있는 경우는 `readdirSync` 가 돌려주는 이름을 검사하지 않으므로 미검출(기존에도 동일).

## 7. 예상 RED / 갱신 목록
- `no-control-bytes.test.js` 자체: `:233` 파라미터 표기 변경(§2), 헤더 `:34-37` "seven roots" → "seven package roots plus one repo root", `:113-114` "none of the seven roots contains one today" 의 `node_modules` 언급 갱신.
- 다른 테스트 RED **0** 예상 — 이 파일을 import 하는 곳 없음(`grep no-control-bytes` : `CHANGELOG.md:65`, `reports/AUTOPILOT/*.md:39,74,184`, `runtime/autopilot/*.json:77,111` — 전부 산문·기록).
- `reports/AUTOPILOT/ap-20260902-062936-tyc5j4.md:39` "7 roots × 5 확장자 1,483 파일" 은 당시 실측 기록 — 고치지 않는다(과거 값).
- `CHANGELOG.md` 릴리스 시 1줄.

## 미확인
- 마켓플레이스 설치본 디렉터리 구조(리포 전체 클론 하위인지) — 확인 안 함. 거기서 vitest 를 돌리는 사용 경로도 문서상 없음.
- `.artibot/guides` 합산 바이트 — 개별 최대값만 측정(163,833B). 스캔 시간 증가는 "무시 가능" 추정, 실측 없음.
- vitest 4 `it.each` 의 객체 파라미터 포맷 문자열(`$rel`) 지원 — 구현 시 확인.
