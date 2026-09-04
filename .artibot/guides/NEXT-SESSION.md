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
