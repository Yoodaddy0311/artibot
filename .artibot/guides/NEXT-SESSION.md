# NEXT-SESSION — 크로스머신 핸드오프 (2026-09-10 11:4x KST, AsusHeechangLee 머신, master = d410ebb0 + 이 커밋, 설치본 4.57.0)

> 다른 머신에서는 `git pull` → 설치본 4.57.0 확인 → **이 파일을 직접 Read** 하고 시작한다. 로컬 전용(`.artibot/HANDOFF.md`·`.artibot/split/`·`runtime/split/`·`.artibot/runtime/`)은 이 머신에만 있다. 아래 수치는 전부 이 세션(artibot-78) 리더 실측이다.

## 4.58.0 라이브 판정 — 중간 (2026-09-10 15:1x KST, 세션 8f6cbd98, 설치본 4.57.0→**4.58.0 갱신 완료, 재시작 대기**)

| 항목 | 결과 | 근거 |
|---|---|---|
| 설치본 | `claude plugin marketplace update artibot`(0c75f94→90505f0c) → `claude plugin update artibot@artibot` "4.57.0 to 4.58.0 … Restart to apply". `installed_plugins.json` installPath `cache/artibot/artibot/4.58.0`, 그 판 `_userprompt-dispatcher.js` 에 `cross-session-message` 마커 4건 | 실측 06:0x Z |
| 프로브 2 usage.receipt | **PASS** — 헤드리스 `claude -p` 1회(06:10:24→38Z, 14s) → `usage.receipt` 2→3, 세션 efd21dcd, model `claude-fable-5-1`, `mission.candidate_deferred` 1 동반 | 실측. 이 프로세스가 4.58.0 훅을 썼는지는 **추론**(원장에 버전 마커 없음, installPath 가 갱신 뒤였음) |
| 프로브 3 Check 8 | **FAIL(측정 프레임 문제)** — `projection-drift`(렌더 1802B vs state.yaml 1292B, state_version 9) + `ledger-subset-violation` 10건 {2,3,4,5,7,8,10,11,12,13}. 그 10건 = split worktree 5개 원장의 `state.updated` 합집합과 **정확히 일치**(land-lint-cwd 2,3 · ups 4 · install-hygiene 5,7,8 · version-check-optout 11 · autoapprove 10,12,13), 각 worktree state.yaml 도 자기 마지막 버전. journal≤9 로 자르면 projection-drift 소멸 → 메인 state.yaml 은 v9 까지 정합. 즉 **유실 아님**, "per-worktree ledger ↔ 공유 journal" P2 긴장의 실측 재현. census: duplicate **0**(직전 4.57.0 판정의 8-① WARN duplicate 2 는 ledger-dedupe-pid 착지로 해소), rejected_excluded 1 | `probe-check89.mjs`(스크래치, doctor.md 절차) 06:09Z |
| 프로브 3 Check 9 | fail(item 8 이 Check 8 물려받음) · item 5 unmeasured(missions 0) · 측정 8/10 | 동상 |
| 프로브 5 기준 | 이 세션(4.57.0 훅) routing-classified 2 = 사람 프롬프트 2. 재시작 후 4.58.0 세션에서 팀원 보고 도착 뒤 재계수 | 실측 |
| 프로브 1·4·5 | **재시작 후** — 훅 의존(PreToolUse `human.asked`, Explore/investigator `route.selected`/`route.bound`, UPS 가드) | 미실행 |

Check 8 후속 결정(오너): worktree 원장을 합산해 판정할지(Check 8 "worktree 밖은 못 본다" 고지와 충돌), 아니면 잔존 worktree 10개 정리 뒤 메인 재측정할지. 정리 전엔 메인 Check 8 은 FAIL 로 남는다.

## 최종 (2026-09-10 13:3x KST — split-b87130 3 wave · 10 줄기 전부 착지)

| 항목 | 값 |
|---|---|
| master | **9384ff66** + 이 커밋. 순서: d410ebb0(W1) → feb0b688 → e79ae67e → 09f1da83 → 27510566(W2) → d4359486 → 91f55319(**W3**: version-check-optout 5502df70 · autoapprove-danger-filter 0517c466) → 9384ff66(README 표 2행·config `updateCheck.enabled`·CHANGELOG W2/W3). 배치 랜딩 3회 전부 `ci/split-b87130` 재사용, 2·3회차는 stale 브랜치 위 lease 로 진행(#G25 라이브 2회) |
| 런 결과 | Wave 1 4 · Wave 2 4 · Wave 3 2 = **10/10 landed**, integrate 4회(W1 1차 not-green 1회 포함) 전부 rebuilds 0. 직렬 3건(lock-harness · skill-description-render · hook-latency-bench)은 소유 파일 미정으로 **미착수** |
| 남은 P1 | ① 릴리스(v4.58.0) — 설치본 4.57.0 은 이번 10줄기 수리 전부 미포함(`land.mjs`·`batch-landing.js`·UPS 가드·dedupe·install 스킵·옵트아웃·위험 필터). `npm run release` 체인(sync:local → release:check → ci) ② 직렬 3건 소유 파일 확정 → 다음 split 또는 단일 창 ③ 정본 정합: `guard-registry#executeChain` vs `safety#classifyRisk` 불일치(`--force-with-lease`·`TRUNCATE`·`rm -rf ./build`), 둘 다 `rm -rf build`(슬래시 없음) 미탐 ④ Write/Edit 자동승인 경로에 cwd 비의존 파괴 판정 정본 없음 ⑤ **오너 결정**: `artibot.config.json` 최상위 `updateCheck` 키 등록 여부 — `tests/firewall/v5-config-firewall.test.js:155` `EXPECTED_TOP_LEVEL_COUNT=31` 이 오너 결정으로만 오르는 기준선이라 리더가 키를 넣었다가 CI RED(32≠31)로 되돌렸다(13:3x). 지금은 선택 키(없으면 ON)로 문서화만 |
| 릴리스 v4.58.0 | 14:0x KST 커밋 d110fb3f(+ aacc5061 `updateCheck` 최상위 키 등록, 방화벽 기준선 32). 로컬 `npm run ci`: validate·skill:check·docs:check·lint 통과, vitest 15,368 중 3 실패 — handoff-store prune 은 재실행 통과(flake), `sessionend-dispatcher` "실 리포 무접촉" 은 이 머신 `.artibot/ledger/` 의 2026-08-01·08-11 자 파일 2개에 과거 픽스처 행(`end-test` 등 7행)이 남아 있어 FAIL(오늘 실행이 만든 것 아님 — 삭제는 오너, 합성 세션 id 아님이라 리더가 지우지 않음), `artibot-entry-parity` 는 ARTIBOT.md:17 "`.artibot/state.yaml` not yet landed" 표기와 달리 **이 세션(M-20260910-S3361cecf) 런타임이 state.yaml 을 실제로 썼음**(gitignored, state_version 9) → 표기가 stale 인지 런타임이 조기 착지인지 **오너 판정 필요**. GitHub CI 가 랜딩 게이트이며 그쪽은 두 파일이 없어 그린 |
| 남은 P2 | doctor `## Paths` "plugin root 기준" 프레임 vs project-root 스토어 · linked worktree per-worktree ledger ↔ 공유 journal 대조 긴장(설계 회부) · `paths.journal` 미정의 · `resolveProjectRoot` 홈 제외가 HOME 덮어쓰기에 무력 · citation-resolution 사각지대(백틱 없는 `file:NNN`·bare-basename skip) · `hook-timeout-budget` 이 PermissionRequest 슬롯 미커버 · `skills/cognitive-routing/SKILL.md:92,98,220` 제거된 System1 엔진 서사 · `docs/ROADMAP-CLAUDE-TAG-CONVERGENCE.md:49`·`install.sh:862` 썩은 인용 · `validate-install.js#PARITY_MATRIX` native-detect 항목 · `install-mode.js` 캐시 세그먼트 export 드리프트 게이트 · 판독기 `Split-Limb` 폴백(본문 어디서든) 검토 · 세션 9120048e 가 홈 스토어에 결정 원장 503행(리포 밖 cwd 폴백?) · `claude plugin details` Agents (0) 표시(파일 목록 선언, 기능 손실 아님으로 추론) |
| 측정 고지 | 두 스토어 병합. `run` start 3회(plan 재실행)·end 1회 → totalMs **null**(미측정), humanWaitMs 2ms(confirm-integrate 0길이 ×3, 위임 근거 = `.artibot/split/run.json#ownerDelegation`). 오너가 창 12개(4+4+2 + Wave 1 재시작 전)를 직접 열어 `open-windows` 세그먼트 미기록. n=4 런이 됐지만 `/split` vs `-fast` 비교는 여전히 주장 불가 |

## Wave 4 후보 (리더 정의 2026-09-10 14:0x — 브리프 미작성, **착수 정찰이 브리프를 완성한다**)

| limb | 과제 | 소유 파일 후보(리더 grep 기준, 착수 시 재확인) | 위험 |
|---|---|---|---|
| judge-parity | PreToolUse 위험 판정 정본 2종 정합 — `guard-registry#executeChain`(L1, `blocked-patterns.js` 경유) vs `autopilot/safety.js#classifyRisk`(L2). autoapprove 줄기 실측 11명령 표: L1 만 차단 3(`./build` 재귀 삭제·`git checkout .`·`git stash drop`), L2 만 danger 2(`--force-with-lease`·SQL 테이블 비우기), 둘 다 미탐 1(슬래시 없는 `build` 재귀 삭제). 정합 원칙: **허용목록·safeOverrides 는 blocked-patterns 가 정본**, classifyRisk 는 그 위의 위험도 등급만 | `lib/core/blocked-patterns.js` · `lib/autopilot/safety.js` · `tests/core/blocked-patterns.test.js` · `tests/autopilot/safety.test.js` · `tests/core/guard-registry-safe-override-scope.test.js` | medium — 두 파일을 PreToolUse 훅 2종이 라이브로 씀. 완화 방향(차단 해제)은 오너 결정, 강화 방향만 줄기 재량 |
| skill-description-render | 호스트가 스킬 description 을 6/114 만 렌더(08-09 세션 관측) — 원인 조사. 가설: frontmatter 형태(멀티라인 `description:` · `>` 블록 · 길이) 또는 `plugin.json#skills` 선언 형태. `claude plugin validate` 경고와 대조 | 조사 보고 `plugins/artibot/docs/investigations/skill-description-render-20260910.md`(신규) · 원인이 frontmatter 면 `scripts/ci/validate-skills.js` + `tests/ci/validate-skills*.test.js` 에 게이트 추가 · 114 SKILL.md 일괄 수정은 **별도 wave**(소유 충돌) | low(조사) — 수정은 게이트까지만 |
| hook-latency-bench | 훅 지연 측정 장치 — Write 1회에 node 프로세스 ~10 스폰(PreToolUse 4 + 디스패처 1 + 자식 ~5), 리더 1회 실측 122~329ms. 리포의 bench 는 라우터·PII 만(`tests/bench/core-benchmarks.bench.js`) | `plugins/artibot/tests/bench/hook-latency.bench.js`(신규) · `plugins/artibot/scripts/bench/hook-latency.mjs`(신규) · 결과 표는 `docs/` 신규 1파일. 훅·디스패처 소스는 **소유 밖**(측정만) | low — 스폰은 mkdtemp 직접 파생 cwd 만(방화벽 `dispatcher-cwd-sandbox-required`) |
| lock-harness | 회고 #40: `tests/firewall/landing-serialization.test.js` 그린이 직렬화 증거가 아님 — 하네스와 `lib/git/landing-lock.js` 를 분리 실측(두 OS 프로세스 실경합) | **worktree-ineligible**(split-ff6c63 판정) — 단일 창에서 `/team` 으로. 소유: `tests/git/landing-lock*.test.js` · `lib/git/landing-lock.js`(수정은 결함 실증 시만) | medium |

착수 순서 권장: judge-parity + skill-description-render + hook-latency-bench 를 Wave 4(창 3), lock-harness 는 그 뒤 단일 창. plan.json 은 아직 Wave 3 limbs 를 담고 있다 — `/split plan` 을 다시 돌리거나 리더가 limbs 를 교체한 뒤 브리프를 쓴다.

## 갱신 (2026-09-10 12:3x KST — Wave 2 도 착지, 오너 부재 중 위임 진행)

| 항목 | 값 |
|---|---|
| master | **27510566** = Wave 2 배치 랜딩(ci/split-b87130 재사용, 1차 landed, rebuilds 0, stale d410ebb0 위 lease 재검증 2회째). 그 앞: 09f1da83(/team frontmatter YAML 오류 수정 — `claude plugin validate` exit 1 이었음) · e79ae67e(리더 docs 후속: split.md 표기·operations.md 7행·CHANGELOG Unreleased·dedupe 키 5필드 서술) · feb0b688(핸드오프) |
| Wave 2 결과 | doctor-check8-arg 8849c226(Check 8 Step 0 projectRoot 산출 + `read project root:` 병기, 실행형 worktree 테스트) · schema-route-drift 9290eed6(route.selected spec 발행자 정정 = route-observe-pre.js, 소스 스캔 테스트) · install-hygiene c8b3d7f2(네이티브 캐시 감지 시 flat 복사 스킵 `--flat`/`-Flat`, ps1 AGENT_TEAMS 옵트인 `-EnableAgentTeams`, 테스트 39) · readme-drift d7c51303(8행 + rules 8→10 ×4 + claims `rules` 패턴, 커버리지 배지 삭제, 훅 27 유지+정의) |
| 다음 P0 | **Wave 3 창 2개**: `claude --worktree split-artibot-version-check-optout` · `claude --worktree split-artibot-autoapprove-danger-filter` → 리더 창 "split 계속". 브리프는 `.artibot/split/<limb>/brief.md`(로컬, base 는 dispatch 포인터가 정본). plan.json 은 아직 Wave 2 limbs — 창 열기 전 리더가 Wave 3 로 전환한다 |
| 발견(소유 밖·미수정) | 호스트 2.1.267 은 plugin.json `rules` 키 무시(validate 경고 실측) — rules 는 flat 복사로만 작동(ADR-002) · `claude plugin details` Agents (0) 은 파일 목록 선언의 표시 문제로 추론(에이전트는 세션에 실제 로드됨) · 트레일러 문단 함정 2건(PROMPT-TEMPLATE 규약 갱신함) · citation-resolution 사각지대: 백틱 없는 `file:NNN` 미추출 + bare-basename skip · `skills/cognitive-routing/SKILL.md:92,98,220` 이 제거된 System1 엔진을 살아있는 기능으로 서술 · doctor `## Paths` "plugin root 기준" 프레임 vs project-root 스토어, linked worktree 의 per-worktree ledger ↔ 공유 journal 대조 긴장(설계 회부) |

## 지금 상태 (2026-09-10 11:4x KST 실측 — Wave 1 직후, 위 갱신이 우선)

| 항목 | 값 |
|---|---|
| master | **d410ebb0** = base 0c75f942 + `/split` Wave 1 배치 랜딩(ci/split-b87130, 4줄기 + 배치 병합 4 = 10커밋). CI 전체 그린(2차). 로컬 = origin |
| /split 런 | runId **split-b87130** (플랜 09:3x, 3 wave · 10 줄기 · 직렬 3). **Wave 1 4/4 landed** · Wave 2 브리프 4/4 작성(창 미개설) · Wave 3 미착수 |
| 설치본 | 4.57.0. **줄기가 고친 `land.mjs`·`batch-landing.js` 는 소스에만 있고 설치본은 옛 판** — 다음 릴리스 전까지 `/split land`·integrate 는 worktree/소스 판을 직접 부르거나 `npm run sync:local` |

## Wave 1 결과 (origin/master d410ebb0, 리더 판독 = first-parent 트레일러 + land 7/7 + 4-way merge-preflight SAFE)

| limb | done 커밋 | 내용 | 라이브 검증 |
|---|---|---|---|
| ups-source-guard | f8ecac6f (3파일 +554/-17) | UPS 가드 — `<cross-session-message`·`<agent-message` 봉투 마커(호스트 2.1.267 은 `source` 를 싣지 않음, 캡처 7/7 부재) + 디스패처 테스트 샌드박스 자기 앵커(HOME 덮어쓰기가 `resolveProjectRoot` 홈 제외를 무력화해 실 홈 스토어에 쓰던 결함) | worktree 디스패처 2경로 `0 hooks run` |
| ledger-dedupe-pid | ff8fd961 (5파일 +128/-21) | `dedupeKey` 5필드(ts 추가) — ledger.js·replay.js 동시, 패리티 방향 불변식 복구 | 실원장 census 0→0(브리프의 pid 중복 전제가 틀렸음, 증거는 픽스처) |
| land-lint-cwd | c4b50eb2 (2파일 +552/-30) | `land` lint 행이 줄기 worktree 를 잰다(#G14), UNSUPPORTED 10종 fail-closed | 4줄기 전부 이 판으로 판독 |
| landbatch-lease | fc24b5fb (2파일 +306/-10) | `landBatch` 모든 push `--force-with-lease`(ls-remote 관측 SHA / 부재=빈 값) + `ci/split-` 접두 1회(#G25) | 2차 재실행이 1차 stale ci 브랜치 위에서 `lease …: ff2b8ed0` 로 진행 — 라이브 작동 |

**integrate 1차 not-green 교훈**: 전체 vitest 15,253 중 1 실패 = `tests/firewall/dispatcher-cwd-sandbox-required.test.js`(ups 의 새 샌드박스가 미등록 메커니즘). 줄기는 표적 스위트만 돌리는 규약이라 못 봤다 → **Wave 2 브리프부터 "소유 파일을 스캔하는 firewall 게이트는 소스 스캔형이라 안전, 반드시 돌려라"** 를 넣었다. 수리는 소유 파일 1줄(`sandboxCwd = mkdtempSync(...)`)로 방화벽 무수정.

## 다음 할 일 (우선순위순)

| # | 작업 | 근거·주의 |
|---|---|---|
| P0 | **Wave 2 창 4개 열기** — 리포 루트에서 `claude --worktree split-artibot-{doctor-check8-arg,schema-route-drift,install-hygiene,readme-drift}` → 리더 창에서 `/split 계속`(worktree-setup → dispatch → status). 브리프는 `.artibot/split/<limb>/brief.md`(로컬, 이 머신). plan.json base 는 **d410ebb0** 로 올렸다(Wave 1 트레일러가 `<base>..<branch>` 에 새지 않게) | 다른 머신이면 브리프를 이 절 + NEXT-SESSION 09-09 절에서 재구성 |
| P1 | 리더 docs 커밋(소유 밖 후속, 줄기 4개 보고 합산): `commands/split.md` — land 절 lint UNSUPPORTED 사유 4종, `ci/split-{runId}`→`ci/split-<sid>` 표기 3곳(:30,:204,:206), "ff push(--force-with-lease)" 오기 · `skills/split/references/operations.md:29` 6행 표→7행 + 운용 규칙 "land 는 창 닫기 전(worktree 삭제 뒤 lint 행 UNSUPPORTED)" · `CHANGELOG.md` :41/:78 후속 닫기 · `lib/runtime/event-writer.js:59,274`·`schemas/ledger-envelope.schema.json:62,67` dedupe 키 서술 5필드 · `tests/replay/replay.test.js:232` it 제목 | 전부 줄기 done 보고에 file:line 있음(줄번호는 d410ebb0 기준으로 재확인) |
| P1 | Wave 3 브리프 2개(version-check-optout · autoapprove-danger-filter) + 직렬 3건(lock-harness · skill-description-render · hook-latency-bench) 소유 파일 확정 | 직렬분은 affectedPaths 가 없어 플래너가 wave 에 못 넣었다 |
| P2 | 관찰 후속(미확인, 판정 없음): ① 세션 9120048e 가 09-03 부터 **홈 스토어** `~/.artibot/runtime/decisions/` 에 503행(리포 밖 cwd 폴백?) ② 호스트 peer hold — 인터랙티브 발신→bypass 수신은 승인 대기, `-p` 발신은 즉시(ups 추론) ③ `resolveProjectRoot` 홈 제외가 HOME 덮어쓰기에 무력(설계 항목) ④ 인프로세스 팀원 도착은 원 사람 턴 prompt_id 재사용, cross-session 은 고유 | |

## 측정 고지 (split-b87130, 두 스토어 병합 20이벤트 — 소스 리포 11 + 설치 캐시 9)
1. 실오퍼레이터 데이터 3건(n=3) — `/split` vs `-fast` 속도 비교는 여전히 주장할 수 없다.
2. wall-clock 은 인간 대기 포함 — 이 런은 `open-windows` 세그먼트 미기록(창을 오너가 plan 직후 열어 리더가 확인 절차를 안 거침), `confirm-integrate` 2ms(승인이 4/4 PASS 전에 선행).
3. 사람 대기 비율 **null%**(분자 humanWaitMs=2, 분모 run=null — `run` start 가 plan 3회 재실행으로 3번 기록·end 1번, 미쌍 1건) — `humanWaitReevalPct`=50 대비 **미측정**. 판정과 C단계 재개는 사람이 결정한다. 교훈: plan 재실행 시 `run` 세그먼트를 다시 열지 말 것(resume 규약과 동일).

## 이 세션 관찰(도구)
- 리더 세션에 도착한 피어 메시지 **전부**에 UserPromptSubmit 라우팅 컨텍스트(`[artibot:route …]`·`[auto-team-suggested]`)가 붙었다 — ups-source-guard 결함의 리더 측 독립 재현(설치본 4.57.0 은 수리 전).
- Git Bash heredoc 에서 백슬래시·한글+따옴표 혼합 본문이 2회 깨졌다(`\\` 소실, `$'…'` EOF). JS 는 ASCII 파일로 빼고, 한글 마크다운은 Write 도구로.
- 줄기 창이 소유 밖 실 스토어(홈 `decisions/`)의 테스트 오염 파일을 리더 승인 없이 삭제한 사건 1건(합성 id, 손실 0) → 브리프 환경 경고에 "worktree 밖 삭제는 리더에게 먼저" 고정.

---

# (구) NEXT-SESSION — 크로스머신 핸드오프 (2026-09-09 22:0x, nowhe 머신, master = 4f79f7e5 + 이 커밋, 설치본 4.57.0)

> 다른 머신에서는 `git pull` → `claude plugin update`(4.57.0) → 재시작 → **이 파일을 직접 Read** 하고 시작한다. 로컬 전용(`.artibot/HANDOFF.md`·`.artibot/split/`·`reports/AUTOPILOT/`·`.artibot/runtime/`·`.artibot/ledger/`)은 이 머신에만 있다. 이 절의 수치는 전부 이 머신 원장 실측이다.

## 지금 상태 (2026-09-09 21:58 KST 실측)

| 항목 | 값 |
|---|---|
| master | `4f79f7e5` + 이 docs 커밋. origin ahead/behind 0/0(커밋 전), 트리 클린(untracked 2: `.artibot/REPORTS/`·`plugins/artibot/.artibot/` — 로컬 잔재, 커밋 안 함) |
| 설치본 | **4.57.0**(cache `…/4.57.0`, gitCommitSha 48ed25dd). 이 세션(a1399ab2)이 재시작 후 첫 4.57.0 세션 |
| 5.0 로드맵 | **Observe 종료 조건(라이브 판정) 판정 완료** — 아래 표. 4 PASS + 1 부분 FAIL |

## v4.57.0 라이브 판정 5항 — 결과 (세션 a1399ab2, 12:47Z~12:58Z)

| # | 항목 | 판정 | 실측 근거 |
|---|---|---|---|
| 1 | PreToolUse 페이로드 `cwd`/`session_id` | **PASS** | `echo 'git branch -D …'` 프로브 → HG-04 차단 → `.artibot/runtime/ledger.jsonl` `human.asked` 12:53:39.648Z, `question_id=q-a1399ab2-77ac71493c05`(nosess 아님). 원장 전체 human.asked 5/5 session-bound, nosess 0 |
| 2 | SessionEnd payload `cwd` → `usage.receipt` | **PASS** | `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p "…ok" --max-turns 1` 헤드리스 세션 4122a20f → 12:54:18.740Z `usage.receipt` source=hook, tier fable, cache_creation 74,124. 직전 세션 4030d1a1 의 `ledger.rejected` 7건(08:39:36Z `source-not-allowed:hook`)은 그 세션이 로드한 4.56.0 allowlist 가 `["worker"]` 였기 때문(4.57.0 = `["worker","hook"]`, 캐시 3버전 대조 실측). 결함 아님 |
| 3 | `/doctor` Check 8-②/9 | **8-② PASS · 8-①/9 WARN** | `doctor.md` 절차 그대로 스크립트 실행(12:55:49Z). 8-② versions [1,1] gaps/regressions/duplicates 0. 8-① WARN = reader census `duplicate 2`(아래 P1) · 9 = item 8 이 parity 를 그대로 물려받아 WARN, 측정 9/10(item 5 는 mission 0건이라 unmeasured) |
| 4 | Explore/investigator `route.selected` | **PASS** | 12:52:47Z Explore(opus) · 12:52:54Z investigator(selected tier **fable**) 각각 `route.selected`+`route.bound`(method `prompt_id+name`, confidence exact). spawns.ndjson `route_ledger=ok:bound` 2/2. `canonicalModel` 은 여전히 null(호스트 SubagentStart 에 model 키 없음) |
| 5 | UPS `source` 가드 | **task-notification PASS · agent/cross-session FAIL** | routing-classified: 사람 프롬프트 2 → bg Bash `[SYSTEM NOTIFICATION` 통지 후 **2(증가 0)** → 팀원 SendMessage 2건 도착 후 **4**. 첫 팀원 보고(12:57:48Z)는 system2 로 분류돼 `[artibot:team teammates=8]`·`[artibot:hint recommend=autopilot]` 까지 주입됨 = split-5f9fe3 #G "인사가 팀 권고 주입" 재현. 직전 세션도 릴리스 전 task-notification 5/5 라우팅(≤1.1s) → 릴리스 후 3/3 무라우팅 |

## 다음 할 일 (우선순위순)

| # | 작업 | 근거·주의 |
|---|---|---|
| P1 | **UPS 가드 — agent-message/cross-session 차단** `scripts/hooks/_userprompt-dispatcher.js#classifyPromptSource`. `NON_USER_BODY_MARKERS` 는 `<task-notification>`·`[SYSTEM NOTIFICATION` 2종뿐. 팀원 보고 본문은 `Another Claude session sent a message` 로 시작(직전 세션 원장 8건 동일 접두). 호스트가 `source` 를 싣는지는 **미확인**(stderr 미수집) — 먼저 `source` 실측 후 마커 추가. 테스트 `tests/hooks/userprompt-dispatcher-resilience.test.js` 동반 | 이 세션 라이브 재현 2/2 |
| P1 | **ledger reader dedupe pid 충돌** `lib/runtime/ledger.js#dedupeKey`(session_id,source,pid,seq). 훅은 프로세스당 seq 0 → Windows pid 재사용 시 별개 이벤트(2026-09-04 pid 38976 17:04Z/17:46Z · 21784 17:17Z/17:53Z, 바이트 상이)가 duplicate 로 탈락. Check 8/9 가 이 원장에서 영구 WARN. ts 를 키에 포함하거나 훅 seq 를 세션 단위로 | doctor 스크립트 실측 |
| P1 | 이월: `land.mjs` lint 행 worktree cwd(#G14) · `landBatch` lease push(#G25) · `commands/doctor.md` Check 8 `project` 인자(#G16) · `lock-harness` wave | 변동 없음 |
| P2 | `schemas/ledger-events.allowlist.json:160` route.selected spec 이 "SubagentStart 도 shadow receipt 를 :340 에서 append" 라 하나 `subagent-handler.js` 의 append 는 `:586` route.bound 1곳뿐 — 문서 드리프트(Explore 팀원 발견, 리더 grep 재확인) · Check 9 item 5 가 mission 0건에서 unmeasured 로 뜨는 lib 경계 · `usage.receipt` cost.total null / pricing_version `unresolved`(가격표 미배선) | |

## 외부 재설계 계획서 검증 백로그 (2026-09-09 22:5x 실측 — 주장 34건 중 검증 통과분만)

외부 문서(`artibot-redesign-plan.md`, 4.56.0 기준)의 결론 5개(D1 "코드가 cognitive.system1/2 를 읽는다"·A6 "0.4 로 대부분 팀 모드"·A7 "세션 시작 3만 토큰"·E2 "권한 자동승인 기본"·E5 "웹훅 기본 전송")는 실측으로 **기각**. 아래는 실측이 뒷받침한 것만.

| 우선 | 항목 | 근거(실측) |
|---|---|---|
| P1 | **에이전트·커맨드 이중 적재** — `install.sh` 가 `~/.claude/agents`(31)·`~/.claude/commands`(80) 에 flat 복사해 네이티브 플러그인(`artibot:*`)과 함께 세션 시스템 프롬프트에 **전부 2번** 나열됨. 에이전트 description 17,665자(≈4.4K tok)×2 + 커맨드 8,306자×2 | 이 세션 시스템 프롬프트 관측 + `diff <(ls plugins/artibot/agents) <(ls ~/.claude/agents)` 동일. 진짜 고정비는 문서가 지목한 스킬이 아니라 여기 |
| P1 | **스킬 description 6/114 만 호스트가 렌더** — 108개는 이름만 나열돼 description 기반 자동 활성화가 사실상 죽어 있을 가능성. 길이·frontmatter 키·"Use when" 문구로는 설명 안 됨(원인 **미확인**) | 이 세션 시스템 프롬프트 관측, `skills/*/SKILL.md` frontmatter 비교 |
| P1 | **README:409 · config `team.delegationModeSelection` 의 0.4 ↔ 코드 `workflow-plan.js#complexityTier` high=0.6** 드리프트. 외부 오독의 직접 원인 | `sed -n 409p README.md`, `workflow-plan.js:47` |
| P2 | README stale 6곳 — 루트 :911 `version 1.14.1` · :1044 Version 절 4.13.0 · 훅 "27 registrations"(루트 :765, 플러그인 :482·:1490, 실제 29) · 훅 표 논리/물리 불일치(UPS 2행 등) · :368-398 캐시/100ms/0.6 에스컬레이션 서사(라우터에 없음) · **플러그인 README:217 이 루트 :914 "unused" 와 정면 모순** · 루트 :91 "Agent Teams auto-enables on first session start"(훅은 읽기만) | inv-docs 실측, 리더 재확인 |
| P2 | 커버리지 배지 static(shields 고정 90%+) — CI 는 검증 안 함(ci.yml:129 자인). 로컬 8/22 statements 89.59·branches 80.41 로 미달 | `coverage/coverage-summary.json` |
| P2 | `rules/` 10개가 네이티브 설치에 안 감 — plugin.json 은 `rules` 선언하지만 호스트 2.1.260 매니페스트 스키마에 키 없음, 대체 주입 코드 0건 | 호스트 바이너리 스키마 키 추출, `grep rules/artibot scripts/hooks lib` 0건 |
| P2 | Write 1회 node 프로세스 ~10(PreToolUse 4 + PostToolUse 디스패처 1 + 디스패처 자식 ~5, `_dispatcher-utils.js:131 spawn`). 리더 1회 실측 지연: 122·176·268·128ms + 디스패처 329ms(node 기동 82ms). 훅 지연 측정 장치는 리포에 없음(bench 는 라우터·PII 만) | 라이브 프로세스 계수는 미실시 |
| P3 | 버전 체크(`session-start.js#checkUpdateBounded`) 옵트아웃 없음(24h 캐시, UA 버전문자열만 송신) · `permissions.autoApprove` 에 위험 도구 필터 없음(기본 `[]` 라 OFF) · install.ps1 은 기존 settings.json 에도 `AGENT_TEAMS=1` merge(bash 는 경고만) | inv-hooks-std 실측 |

## 재사용 프로브 5종(다음 릴리스 라이브 판정용)

1. `echo 'git branch -D x'` → `human.asked` 1줄(차단 자체가 #G29 오탐이라 안전).
2. `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p "Reply with exactly the word: ok" --max-turns 1` (리포 cwd) → `usage.receipt` 1줄.
3. Check 8/9: `doctor.md` 절차대로 `readLedgerCensus`+`readJournal(.git/artibot/project-state.jsonl)`+`state.yaml` raw → `checkLedgerStateParity`/`checkStateVersionGaps`/`checkArtifactHealth`(classifyStaleness 는 `lib/runtime/artifact-lifecycle.js` 에서 주입).
4. Explore + investigator 1건씩 스폰 → `route.selected`/`route.bound` 2쌍.
5. `.artibot/runtime/decisions/<sid>.events.ndjson` 의 `routing-classified` 수 = 사람 프롬프트 수인지(통지·팀원 보고 도착 후 재계수).

## 이 세션 관찰(도구)

- 팀원 2명 모두 첫 보고를 `SendMessage(to="team-lead")` 로 보내 success 를 받았으나 리더에게 **미도착**. 회수 요청(3지선다) 후 `to="main"` 재송신은 도착. 다음 스폰 프롬프트는 `to="main"` 으로 지시할 것.
- 헤드리스 `claude -p` 는 중첩 세션 env(`CLAUDECODE`·`CLAUDE_CODE_ENTRYPOINT`) 를 지워야 뜬다. 10초 소요.

---

# (구) NEXT-SESSION — 크로스머신 핸드오프 (2026-09-09 17:1x, nowhe 머신, master = v4.57.0 릴리스 48ed25dd)

> 다른 머신에서는 `git pull` 후 **이 파일을 직접 Read** 하고 시작한다. 로컬 전용(`.artibot/split/`·`gotchas.md` #G1~#G25·`runtime/split/`·`.artibot/HANDOFF.md`·`reports/AUTOPILOT/`)은 이 머신에만 있다 — 요지는 회고 `reports/SPLIT/split-5f9fe3.md`(추적) 에 있다.

## 지금 상태 (2026-09-05 09:5x 실측)

| 항목 | 값 |
|---|---|
| master | origin **`48ed25dd`** = **v4.57.0 릴리스**(4차 배치 8a874512 + 회고 docs + release). 태그 v4.57.0. 미푸시 0 |
| 설치본 | **4.57.0**(2026-09-09 17:11 `claude plugin update`, 이 머신). 다른 머신은 `claude plugin update` 후 재시작 |
| 4.56.0 라이브 판정 | 6/6 실측 통과(오토파일럿 ap-20260904-190421-2vsvpa, `reports/AUTOPILOT/…` 로컬) |
| worktree | `split-artibot-{usage-receipt,state-store,human-asked-sym,ups-source-guard,route-coverage}` 5개 + 브랜치 6(리더 포함) — 창 닫힌 뒤 **junction unlink 선행** 후 제거(feedback_worktree_junction_removal_trap). 원격 `ci/split-split-5f9fe3` 잔존(사람 삭제) |
| 5.0 로드맵 | Observe 분모 3종(usage.receipt·state.updated·human.asked 대칭) writer 착지 → **릴리스 후 라이브 판정이 Observe 종료 조건** |

## 다음 할 일 (우선순위순)

| # | 작업 | 근거·주의 |
|---|---|---|
| P0 | ~~릴리스(4.57.0)~~ **완료 2026-09-09** → 새 세션에서 **라이브 판정**: PreToolUse 페이로드 `cwd`/`session_id` 실재(없으면 human.asked 프로덕션 0) · SessionEnd payload `cwd` · `/doctor` Check 8-②/9 PASS · Explore/investigator `route.selected` 생성 · UPS `source` 가드가 task-notification·cross-session 인사 둘 다 막는지 | 회고 §5 "라이브 판정" |
| P1 | 러너 결함 2: `land.mjs` lint 행 worktree cwd(#G14) · `landBatch` 사이드 브랜치 lease push + 이름 접두 중복(#G25) · `commands/doctor.md` Check 8 호출 예 `project` 인자(#G16) | 다음 /split 전 |
| P1 | 이월 wave: `lock-harness`(plan.split-ff6c63.json, 브리프 `.artibot/split/lock-harness/brief.md`) | 파일 겹침 없음 |
| P2 | 백로그 #G8·#G9·#G11·#G13·#G15·#G20·#G22(route.unreceipted vs 전사 분모, Check 10 cannot-see, COMMAND_ACTION_CLASS JSDoc, applyUsageReceipt 최신값, sources 위젠 게이트, session-end.js 분리, human.resolved writer, 카탈로그 2종) | 회고 §5 |
| 사용자 | 규칙 파일 `~/.claude/rules/artibot/agent-coordination.md` fable 절(enabled=false·allowlist 20) → config 실측(true·10)으로 갱신 | 리포 밖 |

## 이번 세션 총괄 (2026-09-05 03:5x~09:5x)
오토파일럿(라이브 판정 6/6 · 팀원 4 · 커밋 6f9741b3) → `/split` 5창 dispatch 08:2x → 5/5 done 09:24 → 교차 감사 5건(줄기 반증 0, 리더 반증 6) → 통합 3회차(1: CI 3 red 리더 수리 · 2: non-ff · 3: landed 09:45:54) → wall-clock 87m24s, humanWait 14.1%. 리더 오류 9건 전부 창·감사관 교정 → 브리프 규칙 6종 승격(회고 §3).

---

# NEXT-SESSION — 크로스머신 핸드오프 (2026-09-05 03:3x, nowhe 머신, master = v4.56.0 착지 커밋)

> 다른 머신에서는 `git pull` 후 **이 파일을 직접 Read** 하고 시작한다(`/resume` 은 로컬 HANDOFF 만 연다). 로컬 전용(`.artibot/split/`·`run-log.md`·`gotchas.md`·`runtime/split/`·`.artibot/HANDOFF.md`)은 이 머신에만 있다 — 요지는 회고 `reports/SPLIT/split-ff6c63.md`(추적) 에 있다.

## 지금 상태 (2026-09-05 03:3x 실측)

| 항목 | 값 |
|---|---|
| master | 3차 배치 wave 1 `4fc75c8a`(5브랜치 배치) → 릴리스 `edc1090a` release: v4.56.0 (착지·태그는 아래 "다음 할 일" 첫 행 참조) |
| 설치본 | 4.55.0 → **4.56.0 은 `claude plugin update` 후 재시작해야 적용** |
| worktree | 메인 1개(줄기 4 + 리더 스크래치 제거 완료). `.claude/worktrees/` 에 미등록 옛 디렉터리 2개(`ap-w80-integration`·`relaxed-shamir-08ea8a`) — 이번 런 무관, 미처리 |
| 오너 결정 | 10건 전부 확정·이행(부록 0-2 후속(3) MP-1~5·DC-1~2·TR-1~3) |
| 5.0 로드맵 위치 | **Observe 끝자락** — 만들 것은 닫힘, 종료 조건(라이브 분모)은 4.56.0 설치 후 판정. Shadow 대부분 미착수(`lib/checkpoint/` 0·seeded-defect 0·`state.yaml` 실파일 0) |

## 다음 할 일 (우선순위순)

| # | 작업 | 근거·주의 |
|---|---|---|
| P0 | **wave 2 `lock-harness`** — 창 1개 `claude --worktree split-artibot-lock-harness` → `dispatch lock-harness`(plan·브리프 base `4fc75c8a` 갱신됨, 드라이런 OK). 회고 #40 landing-serialization 하네스/락 분리 실측 | 소유 `lib/git/landing-lock.js` + 테스트 2 |
| P0 | **4.56.0 라이브 판정** — 새 세션에서 ① `pre-bash`·`bash-risk-guard` 발화(Bash 1회 후 spawns/decisions 원장) ② write 계열 훅이 Bash/Read 에 발화 **안 함** ③ L1 D4 additionalContext 도달 ④ L2 D3/D4 `route.selected`/`route.bound` ⑤ TRAIL D3 decisions 줄 수 연속 증가 ⑥ Check 7·10 `/doctor` 라이브 1회 | 전부 "설치 후에만" 항목. 4.55.0 설치본에서는 보안 훅 2종이 발화 0 |
| P1 | **후속(plan.json#leaderIntegration, 회고 §4)** — `land.mjs` lint 행 worktree cwd 수리 · `route-observe-pre` `tool_input.model` 소비 · `review.claim_audit` writer 배선 · 잔존 "28" 산문 census · `pruneDecisionTrail` 킬스위치 · `auto-pr-creator.test.js` 죽은 mock · `plugin-init-flow.test.js` ms 문구 · integrate 재실행 시 run-end 중복(러너) · `~/.claude/rules/artibot/agent-coordination.md` 28→30/8→10(리포 밖, 이 머신 미처리) | 게이트 무관 항목 다수 — 다음 `/split plan` 후보 묶음 |
| P1 | **Shadow 진입 준비** — DR01 checkpoint store(`lib/checkpoint/` 신설, ADDENDUM-2026-09-02 §6 순서 DR01→CX02→DR02) · intent.md 생성 · RouteBench 기준선 · seeded-defect N(오너 결정 C6) | Observe 종료 판정 후 |
| P2 | 3차 승인 보류분 유지: HOOK-VISIBILITY H-1~6 · PLANNER-PARALLELIZATION · landing-lock 근본안(tmp+linkSync) | #42 오너 결정 |

## 2026-09-04~05 세션 총괄 (이 머신)

- 오너 결정 10건 회신(`129eea97`) → **v4.55.0 릴리스**(1·2차 배치 출하, `5eadf9b0`, 배지 ff 라이브 실증 `wait_for_green total=7`) → **3차 배치 `/split` 창 4개**(l2-c10-trail·ci-scope·hooks-fix·model-d) → 배치 착지 `4fc75c8a`(integrate 3회차: 러너 lint 사고 → 소유 밖 핀 3 → landed) → **v4.56.0**.
- 그린 상태 실결함 2: hooks-fix `stripBlockComments` fail-open(독립 검수 포착, 12파일 242줄) · 배치 CI 만 보는 소유 밖 핀 3.
- 라이브 실증: `hooks.json` 표현식 매처 A/B(`pre-bash`·`bash-risk-guard` 발화 0 — 171f7a89 이후) · "Agent 정책 거부" 문구 오탐 · auditor 실스폰이 팀원 보고 2/28 반증 · `canonicalModel` 구조적 null.
- 리더 오류: plan.json affectedPaths 가 브리프보다 좁아 land ownership 1회차 FAIL 3줄기 · 러너 스크립트를 플러그인 디렉터리에 둠 · 브리프 인용 오기 3(tests/scripts/cron·validate.js 핀·unique writer 2).
- 텔레메트리(`runtime/split/split-ff6c63.events.ndjson` 23이벤트): 착지까지 벽시계 **3h19m41s**(PLAN 23:43:41 → landed 03:03:23 KST). `summarizeWallClock` 의 run 3h04m47s 는 **첫 run-end(integrate 1회차 push-failed)** 기준 — 리더 러너가 회차마다 run 을 닫아 15분 짧게 보인다(기록자 발견, 후속). humanWait 67.4%(그 분모)/62.4%(착지 분모), 창 열기 대기 2h04m35s.

---

# (구) NEXT-SESSION — 크로스머신 핸드오프 (2026-09-04 18:0x, master e569e2da + 이 커밋)

> 로컬 `.artibot/HANDOFF.md`·`.artibot/split/gotchas.md`·`.artibot/ledger/`·`.artibot/handoffs/` 는 gitignore 라 다른 머신에 **없다**. 이 파일이 다른 머신으로 넘어가는 요지본이다. 다른 머신에서는 `git pull` 후 `/resume` 이 "핸드오프 없음"을 내므로 **이 파일을 직접 Read** 하고 시작한다. 갱신 주체: 세션 종료 시 리더가 `/save` 와 함께.
>
> 이 머신(AsusHeechangLee)의 자동 메모리 6건(`~/.claude/projects/.../memory/`)도 머신별이다. 요지는 아래 "정본 위치" 표로 대체한다.

## 지금 상태 (2026-09-04 17:58 실측)

| 항목 | 값 |
|---|---|
| Branch | `master` @ `e569e2da` (이 커밋 직전), origin ahead/behind 0/0 |
| Tree | 클린(mod 0 / staged 0 / untracked 0), worktree 메인 1개뿐 |
| Tests | 14505/14518 pass (`/save` 17:46 시점, 리포 전체) |
| 릴리스 | **미실시(의도)** — 1차·2차 배치 변경은 설치본에 없다. 오너가 보는 자리에서 실행 |
| stash | autopilot 체크포인트 10개(9/4 03:41~05:57), 로컬 전용. 버려도 되는지 미확인 |

## 다음 할 일 (우선순위순)

| # | 작업 | 근거·주의 |
|---|---|---|
| ~~P0~~ 완료 | ~~**오너 결정 10건 회신**~~ — **2026-09-04 23:1x 확정(nowhe 머신)**. 10건 전부 설계안 권장안 채택. 정본 `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md` **부록 0-2 후속(3)** 에 기록 | 3차 배치 착수 전제 **충족**. 아래 "오너 결정 대기 10건" 표는 확정값으로 갱신 |
| P0 | **3차 배치 `/split plan`** — L2 Check 10 + replay tool_use_id 조인(오너 승인됨, #42) · docs:check 스코프 · trail D9 동결 · hooks.json 매처 문법 A/B(#49) · timeout 단위 재설정(#50) · `ci-utils.js:74 gitTrackedNames` 링크드 worktree 결함(#56) · handoff-builder :433·stop-review-gate :225(#44) | 2차는 `/split` 창 대신 `/team`+`isolation: worktree` 로 돌렸다(#37). 3차 형태는 오너 참관 여부로 결정 |
| P1 | **릴리스 v4.55.0** — 1차+2차 배치 CHANGELOG 일괄(리더 소유) → `npm run release` → `claude plugin update` → L1 D4·L2 D3/D4 라이브 판정(Check 7 · `spawns.ndjson` route.selected/route.bound) | 라이브 판정은 릴리스 후에만 가능 |
| P2 | `templates/split/PROMPT-TEMPLATE.md`·`commands/split.md` 가 2차에서 착지했는지 **라이브 dispatch 1회**로 검증 | 회고 §7 2차 절은 e569e2da 로 이미 착지 — 남은 것은 dispatch 검증뿐 |
| P2 | 3차 승인 **보류분**(건드리지 말 것): HOOK-VISIBILITY H-1~6 · PLANNER-PARALLELIZATION · landing-lock 근본안(tmp+linkSync — 최소 수리 e0aa2580 으로 운용) | #42 오너 결정 |

## 오너 결정 10건 — 확정값 (2026-09-04 23:1x, 정본 = ARTIBOT-5.0-DESIGN.md 부록 0-2 후속(3))

| 설계안 | 질문 | 오너 확정 |
|---|---|---|
| MODEL-POLICY §5 ① | 조사 역할을 process/judge 로 분리? | **분리** (설계안 §5 원문 권장. 이 표의 종전 "권장 없음"은 요약 누락이었다) |
| MODEL-POLICY §5 ② | A안(역할이 이름을 이김) 허용? | **아니오, 지금은 불허** |
| MODEL-POLICY §5 ③ | D 에이전트 2종 신설 + allowlist 8→10? | **예** |
| MODEL-POLICY §5 ④ | `review.claim_audit` 어휘 +1? | **예** |
| MODEL-POLICY §5 ⑤ | fable 예산 상한 | **상한 없이 집계만(Observe)** |
| DOCS-CHECK §4 ① | 렌더링 위반 15건 고치고 넣기 vs baseline | **고치고 넣기** |
| DOCS-CHECK §4 ② | 서브트리 허용목록 vs `.artibot/**` | **허용목록 + 추적 파일만** |
| TRAIL §5 ① | D9 동결 지금? | **지금 동결** |
| TRAIL §5 ② | 목적지 decisions 스토어? | **decisions 스토어** |
| TRAIL §5 ③ | 기존 trail 972·9건 그대로? | **그대로 두기** |

## 2026-09-04 세션 총괄

- **1차 배치**(4줄기, `/split` 창 4개) → master `520886bd`. **2차 배치**(4줄기 l1-ups · l2-d1 · test-git-sandbox · p19-rest, `/team`+worktree) → master `838d86bd`. 이후 docs 2건(`f09fa2c0` 설계안 2건, `e569e2da` 회고 §7). 7cbb37b9 대비 104파일 +8,915/-860.
- 2차 랜딩 실패 2회: ① README 수치 게이트(26→27 등록·69→70 스크립트, `18b8b126` 수리) ② 줄기 간 상호작용 3건(`838d86bd` 수리 — land --json 7행 · 스포너 래칫 +1 · observeRoute 인용 심볼).
- 코드 결함 확정 3: landing-lock 빈 파일 회수(`e0aa2580` 수리) · sessionstart 테스트 실 리포 부작용(`60dab1dd`) · ci-utils 링크드 worktree(#56, **미수리**, 3차 후보).
- 1차 창 4개 닫음 → 죽은 pid 락 unlock 후 worktree 4·브랜치 4 제거(#61).
- 리더 오류 패턴(회고 §7): 수치에 측정 시각 누락 · 관측 일반화(#39 #43 #45 #47 #57 #59). 규율 §4·§6.
- 팀: 팀원 16명 스폰(구현 5 · 검수 6 · 조사 3 · 기록 2). review-tgs 는 세션 한도로 종료(보고는 완결).

## 정본 위치 (다른 머신에서 읽을 순서)

1. `reports/SPLIT/split-9d6dc2.md` — 1차 §0~6 + 2차 §7, 교훈 원장 61건 전문(§3.2 #1~37 · §7.5 #38~57 · §7.8 #58~61). gotchas.md 의 대체본.
2. `.artibot/guides/v5-design/DESIGN-MODEL-POLICY-role-override.md` · `DESIGN-DOCS-CHECK-scope-artibot.md` · `DESIGN-TRAIL-migration-projectRoot.md` — 각 §5 가 결정 질문.
3. `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md` — 정본. 부록 0-2 후속 기록 위치.
4. `plugins/artibot/scripts/hooks/subagent-handler.js` · `plugins/artibot/tests/firewall/dispatcher-cwd-sandbox-required.test.js` — 2차 배치 핵심 변경.
5. `.artibot/guides/vnext-design/ADDENDUM-2026-09-02.md` — /split vNext 결정(완료 판정 = first-parent 최신 트레일러).

## 크로스머신 주의

- 이 파일을 다시 쓰는 머신이 `/save` 를 돌리면 그 머신의 로컬 `HANDOFF.md` 가 생긴다 — 돌아올 때 **이 파일도 함께** 갱신해 푸시할 것.
- `.artibot/split/gotchas.md` 에 새 교훈을 적으면 회고 §7.8 뒤에도 옮겨 적어야 다른 머신에 간다.
- 한글 경로 리포 — git 경로 파싱은 `-z`.

---

# (구) NEXT-SESSION — 2026-09-02, master 1d895903 + 2차 커밋

> **병합 메모(2026-09-02)**: 이 파일은 같은 날 두 세션이 갱신했다 — 위 헤더·아래 "다음 할 일"은 Artibot 세션(Fable 2티어·/split·v4.52.0 릴리스), 아래 "이전 갱신(2026-08-31, /ultrareview 라운드)" 절은 origin/master 에서 온 기록이다. 우선순위 표는 두 세션의 P0 를 합쳐 읽는다.

> 로컬 `.artibot/HANDOFF.md` 는 머신별이라 git 을 타지 않는다. 이 파일이 다른
> 머신으로 넘어가는 요지본이다. 갱신 주체: 세션 종료 시 리더가 `/save` 와 함께.

## 다음 할 일 (우선순위순, 2026-09-02 갱신)

| # | 작업 | 근거 |
|---|---|---|
| P0 | **릴리스** — 버전 범프(4.51.0 → 다음) → push → 마켓플레이스 갱신 → `claude plugin update`. 그 전까지 이번 주 커밋 전부(/save P0 수정 · /split 스크립트 8종+lane-state · supervisor 스파인 · Fable 2티어 · PostCompact 훅)가 **설치본에 없다** — Ontology 창은 지금도 결함 있는 /save 를 쓴다 | blindspot 2026-09-02 1순위. 설치본 cache/4.51.0 = daf7fec, `scripts/split` 0·`lib/supervisor` 0 실측 |
| P0 | **Fable 첫 실스폰 1회 확인** — `Agent(subagent_type="artibot:architect")` 같은 allowlist 8종을 한 번 띄워 실제 5.1 로 뜨는지(스폰 원장 `.artibot/ledger/spawns.ndjson` 의 canonicalModel, 또는 SubagentStart 경고 유무) | 프론트매터 `model: fable` 을 호스트가 받는다는 것은 문서 근거뿐, 실행 미확인 |
| P1 | **PostCompact 훅 라이브 1회 관찰 후 켜기** — `split.contextLifecycle.enabled=true` 로 바꾸기 전에 compact 1회 발생 시 `~/.claude/artibot/post-compact/<stamp>.md` 가 생기는지 | 라이브 compact 0회. 하네스가 PostCompact 를 실제 스폰하는지·systemMessage 가 모델에게 보이는지 미확인 |
| P1 | **다음 /split 캠페인에서 3가지** — ① `lane-state <limb> active|review|done` 를 적기 시작(probe 오탐 억제·watch ops 열이 그때 켜진다) ② 첫 랜딩에 `land --base <라이브 ref>` 를 손 체크리스트와 나란히 ③ `dispatch <limb>` 포인터를 받은 창이 prompt.md 를 따르는지 관찰 | 스크립트 8종 전부 임시 리포 테스트 + Ontology 읽기 전용 스모크까지만 실측 |
| P1 | **/split limb 권한 모드 정렬** — limb 세션의 권한 모드 클래스가 리더와 달라 크로스세션 완료 보고가 "Held message" 로 걸림 | 2026-08-28 라이브 런 실측. 미해결 |
| P2 | vNext 다음 PR 순서: DR01(checkpoint store — suspend 의 `Split-Limb: wip` 와 재개 정본 결정 선행) → CX02(첫 emitter) → DR02(입력이 쌓인 뒤) | `.artibot/guides/vnext-design/ADDENDUM-2026-09-02.md` §6 |
| P2 | stash-ref-isolation 타임아웃 처방 — 단독 27s/30s 상한, 동시 실행 시 33s 로 red(2026-09-02 재현 2회) | 부하성 플레이크, 코드 무관 |

## 2026-09-02 세션 총괄

- 오너 요청 3건: Fable 5.1 활용 감사(제안) · 상위 커맨드 8종 점검(제안 + 문서 오기 정정) · /split 업그레이드(구현). 이후 2차 라운드: Fable 2티어 적용(설계·검수 8종만) · PostCompact 재주입(기본 OFF) · blindspot 후속(lane-state) · 설계 정합성 점검.
- 커밋: f0157141 /save 추적 보호+슬러그 · 219ab8b3 split 1단계 · 1d895903 커맨드 문서 정정 · (2차 커밋은 이 파일과 같은 묶음).
- 보고서(아티팩트) 에 운영자 관점 "어제까지 → 이제" 표와 설계안 대비 구축률(PR 14개 중 구현 4·부분 2·미착수 8)이 있다.
- 확정 결정: 완료 판정은 first-parent 최신 트레일러(ADDENDUM §1, 되돌리지 말 것) · Fable 은 allowlist 8종 + phaseRoles(build opus/review fable) · PostCompact 는 기본 OFF.

## 이전 갱신 (2026-08-31, /ultrareview 라운드 — origin/master 에서 병합)

> **5차 갱신 (/ultrareview 잔여 백로그 6레인 착지)**: egress 3결함(`41554374`) ·
> core fail-open 2건(`53cbf5bc`) · swarm config 오염 + A-1(`c08c7ff5`) ·
> genesis ACE(`06320386`) · PII 4결함(`2841af82`). CI 7/7 그린, 전체 스위트
> 11,331 pass / 0 fail. **크로스체크가 그린 상태에서 실결함 5건을 잡았다** —
> 상세와 백로그는 memory `project_ultrareview_backlog_20260831`.
> **다음 P0**: 실세션 관측 2건이 아직 미실증이다 — ① decision-events 가 실제
> 훅 발화로 `runtime/decisions/` 에 non-diag ndjson 을 쓰는지(플러그인 재등록
> 후 첫 세션) ② 다음 릴리즈의 `wait_for_green` 첫 회차 `total>0`(persist-credentials
> 수정 실증). **사용자 액션 1건**: `ARTIBOT_LANDING_PAT` 이 fine-grained user
> PAT 인지 확인. **검증 규율 정정**: `npm run prebuild`·`build` 는 이 리포에
> 없다(정본은 플러그인 `npm run ci`) — rules §11 체크리스트가 어긋나 있다.
> — 이하 이전 라운드 기록:

# (구) NEXT-SESSION — 2026-08-30, master a78dd239

> **4차 갱신 (/ultrareview 전수 적대검수 + 능동발생 3건 수정)**: 플러그인 전수
> 검수 5레인 → CRITICAL 1+HIGH 11. 능동발생 3건 착지: checkpoint 무락
> lost-update(`b6265225`) · 자동커밋 git add -A 인덱스 오염(`69a9ec3a`) ·
> SAFE_OVERRIDES 게이트 무력화(`a78dd239`). **원 P1 라이브 재현**: 전체 npm test
> 동시실행이 추적 artibot.config.json swarm 을 enabled:true 로 뒤집음(로컬
> swarm-consent optedIn:true + 전체동시성 트리거, 단일디렉터리·CI 무재현) — 커밋 전
> config 복원 필수. **다음 P0(잔여 조건부 HIGH, swarm OFF 시 잠복)**: A-1 swarm-client
> run.app 정규식 egress 우회 · E3 safeFetch 리다이렉트 미검증 · A-2 .local=localhost ·
> D-1 verify-gen import() ACE(fix: node --check) · E2/E5/E6 PII 스크럽 훼손 · B/H-2
> denylist §8 · B/H-3 Git Bash cwd 가드해제. 상세 memory project_ultrareview_20260830.
> 유발 테스트 특정 미완(전체 동시성 필요). — 이하 H 라운드 기록:

> **3차 갱신 (같은 날 H 라운드)**: 2차의 잔여 3건 전부 해소 + 중대 발견 2건.
> ① effort-order mtime 화석 → 링크드 샌드박스 이전(`08e6f9f7`) ② landing-serialization
> cwd 의존 수정 + 전역 census(`e4d7d366`) ③ **artibot 플러그인이 미등록 상태였음을
> 발견**(캐시 orphaned 2026-08-23, 훅 전용 산출물 3종이 07-10 부터 정지) → 리더가
> 재등록 + 미러/캐시를 ac988452 신배선으로 재구축. **다음 세션 시작 시 훅이 처음
> 로드된다** — 프롬프트 1회 후 **`<projectRoot>/.artibot/runtime/decisions/`** 에 non-diag ndjson
> 생성 여부가 P0 관측. ④ checkpoint 샌드박스 탈출 수정(`afedb3c9`): ARTIBOT_STATE_DIR
> seam + vitest setupFiles 기본 배선 + 발행-home 유효범위 가드 — 실 사용자 상태
> 오염(checkpoints.json 100/100 픽스처) 종식, 오염분은 삭제됨.
> 잔여 백로그: session-start.test.js 리포루트 단언 전제 · cache-roi/watch-ingest
> 리터 부작용 · trail-sandbox state-restore-contract mechanism 은퇴(+samples 동반
> 삭제 필요) · getHomeDir 문자열 비교 정규화 · badge-stall 타 릴리스 런 로그 미조사.

## 이전 우선순위 (2026-08-28) — 참고

| # | 작업 | 근거 |
|---|---|---|
| P0 | **다음 릴리즈에서 라이브 실증 2건 관측** — ① `wait_for_green` 첫 회차 로그가 `total=N (N>0)` 인지 (f3505fd9 의 persist-credentials 수정 실증. 0건이면 rc=2 가 2분 만에 escalate — 그땐 PAT 토큰 종류가 원인) ② 릴리즈 전 사용자에게 `ARTIBOT_LANDING_PAT` 이 fine-grained **user** PAT 인지 확인 요청 | v4.51.0 ff 착지 실패(#114) 원인 = checkout persist-credentials 기본값이 GITHUB_TOKEN 을 영속 → 인라인 PAT 을 덮음(actions/checkout#181) → push 이벤트 미발생. 수정은 착지했으나 라이브 발화 0회 |
| P1 | **decision-events 실세션 관측** — 슬래시 커맨드 몇 번 후 **`<projectRoot>/.artibot/runtime/decisions/`** 에 ndjson 이 쌓이는지(*이 줄은 2026-08-28 당시 “실제 플러그인 루트 `runtime/decisions/`” 였다 — 경로가 바뀌었다*). 이어서 `/doctor` Check 7 거짓 그린 처방(S3 게이트가 `current-effort.json#updatedAt` 24h 창 밖이면 기록 0건이어도 pass) + `current-effort.json` mtime(08-23)/updatedAt(07-10) 모순 규명(OneDrive 가설) | 구 P0 의 배선 결함은 d6fdd2fa 로 수정 완료(라이브 재현 recorded:2 실측). 남은 것은 실세션 관측과 Check 7 게이트 자체 |
| P2 | **/split limb 권한 모드 정렬** — limb 세션의 권한 모드 클래스가 리더와 달라 크로스세션 완료 보고가 "Held message" 로 걸림(사용자 수동 승인 요구, 무인 진행 깨짐). `/split open` 이 창을 띄울 때 리더와 같은 모드로 정렬 | 2026-08-28 라이브 런 실측. dispatch 자체는 실작동 확인(2e6c123f 첫 라이브 증거). Deny 해도 무해 — 완료 판정은 git 트레일러가 정본 |
| P3 | stash-ref-isolation 타임아웃 처방(스폰 ~60회가 원인, 무부하 8.4s/30s 상한 — 스폰 축소 vs timeout 상향) + runtime/autopilot 잔여 test-engine-state 계열(런당 +11) 정리 배선 | 부하성 간헐 red, 재발 예측 가능 |

> **경로 정정 각주(2026-09-03 결정 D)**: 위 두 곳(`:61`·`:74`)이 적고 있던 `<pluginRoot>/runtime/decisions/` 는
> 더 이상 사실이 아니다. 오너 결정으로 decisions 기본 저장소가 **projectRoot `.artibot/runtime/decisions/`** 로
> 바뀌었다(정본: `lib/observability/decision-events.js` 의 `DECISIONS_REL = ['.artibot','runtime','decisions']`
> + `getDecisionStoreDir` 가 `projectRoot` → `resolveProjectRoot(cwd)` 순으로 해석). 이유는 `claude plugin update` 가
> pluginRoot 를 교체하면 Observe KPI 분모가 통째로 사라지기 때문이다. 결정 원장:
> `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md` 「부록 0-2 후속. 오너 결정 (2026-09-03 확정)」.

## 2026-08-30 세션 총괄 (519e2529 → f3505fd9, 2커밋 — hee 머신)

d6fdd2fa **decision-events 배선 수정** (D5·D7 이 `state.context` 를 넘겨 기록 100%
skipped 이던 것을 `state.input` 으로 — 실파이프라인 회귀 4건 신설) ·
f3505fd9 **릴리즈 ff 착지 수정** (persist-credentials:false + PR_REMOTE 동반 +
wait_for_green total=0 조기판정 + firewall 게이트 release-landing-credentials 9건).
전체 스위트 11,207 pass / 40 skip (513파일, 커밋 직전 실측). 크로스체크·뮤테이션
대조 전건 통과. 사용자 액션 잔여: PAT 토큰 종류 확인 · `ci/sync-badges-v4.51.0`
브랜치 삭제(파생값이라 체리픽 불필요) · #114 수동 종료(자동 해소 조건 영구 거짓).

## 확정 결정 (재논의 불필요)

## 2026-08-28 세션 총괄 (daf7fec0 → 1665eb48, 8커밋)

afe799a9 decision-trail lost-update 해소 · ec53a208 ndjson 증거 -text 고정 ·
6f4821ac trail 격리 firewall 게이트 · 5d30cf6b PRD 스모크 누출 차단 ·
c898461c **trail explainability Step1+2** (/doctor Check 7 + append-only 판단 기록) ·
3f15663b projectRoot 게이트 + deleteSessionArtifacts + 잔재 2,824건 정리 ·
9a024696 ULTRAPLAN 정본 `.artibot/guides/` 구제 · 1665eb48 GRPO 백필 쌍 은퇴(−956줄)

전체 스위트 11,224 pass / 10 skip (511파일). v4.51.0 설치 검증 결함 0.

## 확정 결정 (재논의 불필요)

- **swarm = 의도적 OFF**: 2026-06-08 머지가 로컬 enabled:true 를 되돌린 게 88일
  정지의 근인이었으나, merged-weights 의 프로덕션 소비자가 0 이라 켜지 않기로
  확정. 켤 조건: ① 라우팅이 병합 가중치를 읽는 소비자 배선 ② 2번째 머신 실사용.
- **ledger→학습 승격 = 형식 불일치로 무가치**: 시범 249건 spread 0.0000.
  잔여 2,670건 전량 거부 완료. 재개 조건: `toExperience` 가 결과 차원
  (duration·testsPass)을 싣게 매핑 수정.
- **GRPO 완전 은퇴**: 데이터·백필 쌍 삭제 완료. 보존 필수: config
  `learning.grpoRouting.{skillPolicy,effortPolicy}` 키(라이브 reader 실재),
  `/dreaming`, learning-diag 의 부재 렌더 경로.

## 함정 (다른 머신에서 주의)

- 오늘 8커밋은 **플러그인 미릴리스** — `claude plugin update` 는 4.51.0 까지만.
  설치본으로 신기능을 쓰려면 리포에서 `sync:local` 또는 다음 릴리스 출하.
- 설치 검증 시 `git show HEAD:` blob 대조는 CRLF 로 전건 거짓 불일치 —
  기준선은 마켓플레이스 클론 체크아웃본. 정본은 `installed_plugins.json`.
- 설계문서를 리포에 커밋할 때 `plugins/artibot/docs/` 는 split-config-firewall
  스캔에 걸린다 — `.artibot/guides/` 가 정본 위치.
- 랜딩은 ci/** 브랜치 → SHA 의 체크런 **7종 전부** 그린 → ff master.
  (워치는 run 1개가 아니라 SHA 체크런 전체를 봐야 한다 — 오늘 1회 게이트에 걸림)

## 백로그 (급하지 않음)

- **부하성 플레이크 4파일(2026-09-02 전체 스위트 6회 실측)**: stash-ref-isolation·landing-serialization 30s 타임아웃, handoff-store 임시 디렉터리 rename EPERM(Windows, 전체 6회 중 4회 — atomicWrite 에 EPERM 재시도 검토), 병합 후 신규 git-dir.test.js "nests several segments" 8.3 단축경로 vs 장경로 불일치(53cbf5bc 이후, 단독 통과·전체에서만 red → repo-root-cache 정규화 경합 의심). 전부 단독 재실행 통과, 로직 회귀 아님.
collectExperience 크로스 프로세스 RMW(trail 과 동형) · concurrency 테스트
저빈도 플레이크(0/20 까지만 배제) · docs/PRD 역사적 잔재 4,165건 · aux
`.artibot-new` 는 이 머신에서 병합 완료(다른 머신은 각자 sync 시 정리) ·
CI 리눅스에서의 tmpdir lock 이벤트 거동 미확인.
