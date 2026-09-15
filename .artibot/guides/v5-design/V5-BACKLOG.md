# Artibot v5.0 백로그 — 진행률 단일 분모 (정본)

- 생성: 2026-09-11 (세션 25918244, NEXT-SESSION 「Wave 6 착지 + Wave 7 준비」 22:1x 절 이후). 작성: planner(fable) 초안, 리더 Write.
- 기준 master: `c2f300e3` (release: v4.62.0 — Wave 9 착지분 출하, 2026-09-14 12:5x; 아래 §1 표는 3ba981eb 기준 그대로 — 4.62.0 은 기능 코드 0)
- 설치본: 4.62.0 (`sync:local` 2026-09-14 13:0x, 설치 경로 `dev-verify-gate.js` 에 `recordUnmeasuredDenominator` 3건 — 호스트 재시작 전)
- **오너 결정 2026-09-14(E1·E2·E3·G1, ADR-012)**: 감사 F01~F10 은 로드맵 ID 의 선행 불변식이면 로드맵으로 세고 해당 ID 비고에 F 번호를 명기한다(E1) · Observe ⑤ 는 Shadow 이월, 종료 판정은 ①②③④(E2) · RouteBench 는 B안(E3) · v5.0 GA 조건 = GA-02 기전 GA 만, GA-01·GA-03 은 v5.1(G1). Wave 10 편성 정본 = `.artibot/adr/ADR-012-*.md` + `docs/PRD/v5-ga-roadmap-audit-fold-20260914.md`.
- **이 문서가 v5.0 진행률의 정본이다.** 로드맵 항목의 status·evidence 는 여기서만 갱신한다. 갱신 규칙: 웨이브 착지(배치 랜딩 커밋)마다 리더가 해당 항목의 status·evidence(커밋 SHA 또는 file#symbol)를 갱신하고 헤더의 기준 SHA 를 올린다. `done` 은 evidence 가 있을 때만. 항목 추가는 설계 정본(`ARTIBOT-5.0-DESIGN.md` §4·§7.3·§8.4·부록 결정)에 근거가 있을 때만 — 정찰 후속은 §3 부채 트랙으로.
- 출처 우선순위: `ARTIBOT-5.0-DESIGN.md` §4 로드맵 > §7.3(§48 P0 14 사상) > §8.4(§55 P0 15 사상) > 부록 0-2 후속(1)(2)(3) 오너 결정 > `NEXT-SESSION.md` > `CHANGELOG.md`.
- 인용은 `file#symbol` 또는 `§번호`. 줄번호는 쓰지 않는다.

## §1 진행률 요약 (분모 = §2 항목 수, 2026-09-14 `3ba981eb` 기준 — Wave 9 8/8 착지 반영)

| 단계 | 항목 | done | in-progress | todo | 보류 | 기각 | 진행률(done/항목) | 이번 웨이브 변동 |
|---|---|---|---|---|---|---|---|---|
| Phase 0 정본 착지 | 16 | 13 | 1 | 2 | 0 | 0 | 81% | — |
| Observe 기록만 | 27 | 20 | 5 | 2 | 0 | 0 | 74% | OB-26 todo → done (+1, Wave 11) |
| Shadow 비교 | 30 | 6 | 9 | 12 | 3 | 0 | 20% | — (SH-02·SH-13 evidence 만 갱신) |
| Canary 저위험 자동 | 20 | 1 | 0 | 18 | 0 | 1 | 5% | — |
| GA | 7 | 1 | 0 | 6 | 0 | 0 | 14% | — |
| **합계** | **100** | **41** | **15** | **40** | **3** | **1** | **41%** | done 40 → 41 |

계산식(재현): 단계별 done 을 §2 표에서 세어 합산 — 13 + 20 + 6 + 1 + 1 = **41**, 분모 16+27+30+20+7 = **100** → 41%. 단계 진행률은 Observe 20/27 = 74.0% → 74%, Phase 0 13/16 = 81.3% → 81%, Shadow 6/30 = 20%, Canary 1/20 = 5%, GA 1/7 = 14.3% → 14%(전부 소수점 버림). **Wave 11 에서 status 가 바뀐 항목은 `OB-26` 단 1건**이다 — OB-07·OB-17·SH-04·SH-06·SH-20·SH-29·CA-13 은 evidence·비고만 갱신했고(착지했으나 done 조건 미충족), hg09·wire-preintake 는 §3 부채 트랙이라 이 표에 들어가지 않는다. 직전 Wave 9 의 유일한 변동은 OB-21 이었다.

> Wave 11 (split-wave11-20260915, base `2b10fd31`, 8줄기 + 롤링 1 = 9 착지, 2026-09-15 02:4x~06:3xZ, 리더 artibot-28) 착지 이력: 배치 1 `bb868e7f` = ob26-config-seven(OB-26 done, 줄기 `464b7f7d`) · 2 `a7ebffcc` = hg09-update-set-quadratic(§3 부채, 줄기 `cb668070`) · 3 `16ea4c57` = wire-preintake-data-only(§3 부채, 줄기 `5b3fa076`) · 4 `059e81e1` = sh29-carrier-writer(SH-29 skill 키만, 줄기 `1943cae8`) · 5 `6a2a0eff` = ob17-switch-reasons(OB-17 H1+K1, 줄기 `55b0defa`) · 6 `a40534e1` = sh06-engine-record-wiring(SH-06 기록 배선, 줄기 `f2c09d70`) · 7 `686df95b` = outcome-md-emitter(SH-20·CA-13 emitter, 롤링, 줄기 `6d612dbf`) · 8 `ea44a1ab` = f04b-followplan-transition(SH-04 F04(b), 줄기 `a1dc8497`) · 9 `9165196f` = verify-completed-producer(OB-07 measured 버킷, 줄기 `f7d0e7f9`, 16:59 KST 착지). base `2b10fd31` → 배치 9 `9165196f` = **84 files +11,728/−439**(리더 `git diff --shortstat` 실측; 배치 8 시점 중간값 75/+10,252/−312). 줄기별 합 88/+11,730/−441 과의 차이(files 4 · ins 2 · del 2)는 **sh29·outcome 이 같은 4파일을 연달아 고쳐 접힌 것으로 확인됐다** — 교집합 = `hooks/dispatch-table.json` · `tests/dispatcher/dispatch-table.test.js` · `README.md` · `plugins/artibot/README.md`. 전체 게이트 = 비테스트 8/8 green · vitest 18,425 passed / 10 failed / 12 skipped(분모 18,447; 진짜 실패 1 = split-tools F07 플래키, `lib/core/file.js:144` renameSync EPERM). 상세 CHANGELOG [Unreleased] "Wave 11 배치 착지".

> Wave 10 (split-wave10-20260914, base f52b0a98 → 롤링 forkPoint, 8줄기 + 롤링) 착지 이력(2026-09-14, 리더 artibot-5d, 오너 /autopilot 위임): 배치 1 `a38a5ade` = scorecard-absent-contract(§4 ② A′) · 2 `c9ad9819` = nl-activation-report(SH-03 계측기) · 3 `d480c026` = economics-coverage(§4 ④ fold + SH-07 pricing 기본 true) · 4 `c732eaa9` = verify-numerator-rate(OB-07 분자 판독기, A 만) + split-ops-remediation(§3 F06~F08 + forkPoint) + routing-single-decision(SH-04 F04 기록·F05) · 5 `f43ce513` = guard-l2-followups(§3 부채) · 6 `e10ebabe` = autopilot-phase-transition(F01·F02, CA-03 선행) · 8 `25d3a4b0` = batch-landing-push-classify(F09) · 9 = routebench-scenarios-live(SH-25 후속, E3=B) + plan-md-emitter(SH-02 plan.md) · 배치 10 `971f0f26` = autopilot-budget-units(F03+F10, 줄기 `666683cb`) · 배치 11 `096d5897` = dispatch-base-forkpoint(§3 부채 — dispatch 가 `{BASE}`·포인터를 렌더 전에 forkPoint 로 해석, 줄기 `f8a35282`) · 코드 0 판정 = ob17-models-current(OB-17, 오너 결정 D1/D2). 상세 CHANGELOG [Unreleased]. **Observe ③ 분모 t0 = 2026-09-14 05:21Z**(설치본 `schemas/` 패키징 수정 `df85f702` 시점 — 4.62.0 재시작이 아님).

> Wave 9 (split-68e984w9, base a81ee154, 8줄기) 착지 이력: p1 `18ac5644` = avoided-switch-fold(OB-21) + routebench-b4-agenttype(SH-25 후속) + split-ops-dispatch-land(§3 부채) · p2 `f1f8311e` = session-end-vocab(§4 ④ 분모) + resume-contract-dr02(SH-13) · p3 `3ba981eb` = guard-command-position(§3 부채) + verify-gate-wiring(OB-07) + review-md-writer(SH-02). a81ee154→3ba981eb 합계 **44 files +8,800/−112**(`git diff --shortstat`, 2026-09-14 10:3x 실측 — 줄기별 8개 diff 의 합과 정확히 일치), 줄기별 수치는 CHANGELOG [Unreleased] Wave 9 절. **done 으로 올리지 않은 것**: OB-07(훅 호출자는 생겼으나 설치본 미갱신으로 층별 UNMEASURED 분모 여전히 0), SH-02(review.md 경로만 — `plan.revised`·`mission.completed` emitter 0), SH-13(report-only 만 — apply·`/resume --contract` 실행 경로 부재), SH-16(Wave 8 부터 유지).

> Wave 8 (split-68e984w8, base a40b8448, 8줄기) 착지 이력: p1 `e9e24e2e` = checkpoint-store-dr01(SH-21 DR01) + plugin-manifest-agents(§3 부채) · p2 `34b6dbf6` = pricing-unify(SH-07) · p3 `b906264a` = context-receipt-cx02(SH-16) · p4 `9300568e` = intent-md-generator(SH-01/02) + routebench-baseline(SH-25) + verdict-verify-writer(OB-06/07) + README 카운트 동기화(p4 1차 `ca0f0da7` not-green: hooks.json 핀 2건 → 줄기 수정 `7d75031a` 후 2차 초록) · p5 `ee86a639` = human-resolved-writer(SH-27). a40b8448→ee86a639 합계 74 files +14,989/−277(`git diff --shortstat`), 줄기별 수치는 CHANGELOG [Unreleased] Wave 8 절. **done 으로 올리지 않은 것**: SH-16(writer 착지, PostCompact 시점 11 leaves 결손으로 라이브 발행 0 — 구조적), SH-02(intent.md 만, review/outcome.md 핸들러 실행 0), OB-07(verify.completed writer 착지, 런타임 호출자 0).

읽는 법: 진행률은 done 만 센다(in-progress 는 0). 보류·기각은 분모에 남긴다(오너 결정으로 되살아날 수 있음). §3 부채 트랙은 이 표에 섞지 않는다.

## §2 항목 표

status 어휘: done / in-progress / todo / 보류 / 기각. evidence 없는 항목은 status 를 done 으로 쓰지 않았다.

### Phase 0 · 정본 착지 (16)

| ID | 항목 | 출처 | status | evidence | 게이트 | 비고 |
|---|---|---|---|---|---|---|
| P0-01 | v5-design 디렉터리 커밋 | §4 · B8 | done | `.artibot/guides/v5-design/` 16파일 실재(Glob) + `scripts/ci/ci-utils.js#ROOT_SCAN_TREES` 가 추적 파일만 스캔(4.56.0 DC-2) | `no-control-bytes`(root 8) | 커밋 SHA 미확인 |
| P0-02 | `ARTIBOT.md` 진입 계약 + CLAUDE.md parity | §4 · §3.7 · B3 | done | `ARTIBOT.md` 실재; 4.58.0 `state.yaml` 마커 제거 | `artibot-entry-parity` | B3 = 복제 + parity(include 미지원 가정) |
| P0-03 | `.artibot/project.md`(Core Principles · Human Approval Boundaries HG-01…13) | §4 · §3.7 | done | `.artibot/project.md` 실재; `lib/security/human-gates.js#HUMAN_GATE_MATRIX` | `project-md-contract` | |
| P0-04 | `PRD-…-2.md` 병합 | §4 · §3.3 | done | `.artibot/guides/PRD-SPLIT-CROSS-SESSION-MULTI-WORKTREE.md` 1건, `-2` 없음(Glob) | `artifact-governance` #1 | |
| P0-05 | 표류 원장 삭제(원장 분산 검사 #4) | §4 · §3.3 | todo | 미확인 | `artifact-governance` #4 | 게이트 그린이면 done — 리더 재판정 |
| P0-06 | ADR 단일 계열 `.artibot/adr/` | §4 · B2 · 부록 후속(1) | done | `.artibot/adr/ADR-001~011 + INDEX.md` 실재 | `artifact-governance` #2 · `gitignore-boundary` TRACKED_PATHS | B2 3라운드 끝 확정 |
| P0-07 | 루트 status 파일 아카이브 | §4 · §3.7 R12 | done | `.artibot/archive/2026-06/` 4파일(부록 0-2 §0-1 행, T-04) | `artifact-governance` | |
| P0-08 | 헌법 단계 A 8건(A-2…A-8) | §4 · §3.7 | done | `tests/firewall/constitution-stage-a-rules.test.js` · `constitution-stage-a-commands.test.js` | 동좌 | A-6(team.md 스니펫 삭제)·A-8(홈 rules §13) 개별 이행 미확인 |
| P0-09 | `.gitignore` `runtime/`·`transcripts/` | §4 · §3.3 | done | `.gitignore` `**/.artibot/runtime/`·`**/.artibot/transcripts/`·`**/.artibot/state.yaml` 실측 | `gitignore-boundary` | |
| P0-10 | eslint 레이어 등록 11 디렉터리(+ `lib/{replay,checkpoint,scorecard}/`) | §4 · §1-8 · §8.4 | done | `plugins/artibot/eslint.config.js` L2 files 목록(checkpoint·economics·mission·project-state·recovery·replay·review·routing·scorecard·verification) + topology L4 | `layer-registration-coverage` | `lib/checkpoint/` 은 등록만, 디렉터리 부재 |
| P0-11 | 파생 파일 validator(v1.1 P0-6) | §4 P0 9항 · §3.3 | done | `tests/firewall/artifact-governance.test.js` | 동좌 | |
| P0-12 | 온톨로지 ID · common-meta 예약(§48 #1) | §7.3 | done | `schemas/common-meta.schema.json`(11 `$defs` 예약, 부록 T-19) | `ledger-vocab-allowlist` | |
| P0-13 | Artifact Registry 스키마(based_on·provenance·schema_version, #7) | §7.3 | todo | 미확인 | — | `schemas/project-state.schema.json` 등이 대체하는지 미열람 |
| P0-14 | staleness 규칙 정의(#8, 판정 코드) | §7.3 | done | `lib/runtime/artifact-lifecycle.js#classifyStaleness`(Check 9 주입) | — | 자동 차단은 CA-08 |
| P0-15 | Receipt 스키마 3종 + Exact Model Identity + `routing_epoch_id` 봉투 필드(§55 #1·#5·#6·#7) | §8.4 | done | `schemas/route-receipt.schema.json` · `attempt-receipt.schema.json` · `context-receipt.schema.json` · `ledger-envelope.schema.json`; 부록 T-29 epoch required | `usage-receipt-schema-guard` · `ledger-vocab-allowlist` | G1: epoch = agentId 확정 |
| P0-16 | 조사 I1~I7 | §7.6 | in-progress | I2(스키마 enum, T-18)·I3(B3 복제)·I5(T-21 + ADR-011 linked worktree 테스트)·I6(불필요) 해소 / I4 부분(4.58.0 `canonicalModel:"fable"` 등장) / I1(가격: `usage.receipt` cost null·pricing_version unresolved)·I7(실행 중 전환) 미해소 | — | I1 은 SH-07 선행 |

### Observe · 기록만 (27)

| ID | 항목 | 출처 | status | evidence | 게이트 | 비고 |
|---|---|---|---|---|---|---|
| OB-01 | `event-writer` + `ledger.jsonl` + mission_id 세션 fallback(§48 #9) | §4 · §3.6 | done | `lib/runtime/event-writer.js#ledgerFilePath` · `lib/mission/mission-id.js`; 위치 ADR-011 `f4882946`·`921dcf3c`·`a1be029c`(4.60.0) | `ledger-append-survival`(60/60, 8프로세스 추가) · `ledger-vocab-allowlist` · `ledger-store-colocation` | 실 원장 이관·`.pre-adr011` 삭제는 §3 |
| OB-02 | StateStore + `state.yaml` 투영 + `state.updated` 1:1(§48 #5, B1) | §4 · §1-2 · OD-4 | done | `lib/project-state/state-manager.js#createProjectStateStore` · `store-location.js#resolveStoreLocation`; 배선 4.57.0 `lib/runtime/middleware/tasks.js`; `.artibot/state.yaml` 실재(gitignored) | `state-updated-pairing` · `worktree-gitdir-resolution` | 4.58.0 ARTIBOT.md 마커 제거 = 착지 선언 |
| OB-03 | `compileMission` 모든 프롬프트(기록만) | §4 · §3.1 | done | `lib/mission/compiler.js#compileMission` · `tasks.js` `mission.candidate_deferred` | `nl-activation-fixture`(93/93) | S4·S6 미배선 → deferred 다수(부록 T-25), 발화율 분모 미측정 |
| OB-04 | 라우터 Observe: `route.selected`(PreToolUse Agent) + `route.bound` + `AGENT_ACTION_CLASS` 32키 + epoch=agentId(§48 #11 · §55 #2·#5) | §4 · §3.2 · 후속(1) receipt 위치 · 후속(2)-b D-2 | done | 4.55.0 `scripts/hooks/route-observe-pre.js` · `subagent-handler.js#observeRoute`; 라이브 PASS(4.57.0·4.58.0 판정 4) | `host-payload-contract` · Check 10 | `canonicalModel` 4.58.0 부터 값 등장(원인 미확인); spawn-ledger 필드는 D7 임시 |
| OB-05 | `decision-events` 훅 배선 + `topology-recommended` | §4 · §3.5 | done | `lib/observability/decision-events.js` 어휘 5종 · `lib/topology/topology-router.js`; 스토어 projectRoot(후속(1) 결정 D) | `decisions-store-sandbox-required` · `hook-decision-invariance` | |
| OB-06 | `independent-reviewer` verdict 파싱·기록 + clean-room `buildReviewRequest`(§48 #13) | §4 · §3.4 · MP-4 | done | Wave 8 p4 `9300568e`(줄기 done `7298bc34`): `lib/review/verdict-writer.js`·`claim-audit-writer.js`(pure + ports) + SubagentStop 배선 `scripts/hooks/_review-stop-record.js#recordReviewFromStop`(`last_assistant_message` 실림 실측, stdout 바이트 불변 4케이스) + idempotency(usage-receipt 선례 형태) + `tests/hooks/subagent-handler-review-writer.test.js` | `review-verdict-adapter` · `hook-decision-invariance` | 파싱률 분모 = 배포 후 라이브 원장(2026-09-13 두 원장 233+349행 모두 0 = 미측정); `team.md` v2+claim_audit 준수율 라이브 0 |
| OB-07 | `unified-verifier` UNMEASURED 카운트 | §4 · §3.4 · C4 | in-progress | Wave 8 p4 `9300568e`: `lib/verification/verify-writer.js`(`verify.completed`, pure + ports) 착지. Wave 9 p3(줄기 done `de8d238a`): Stop 훅 `scripts/hooks/dev-verify-gate.js` 가 **분모행**(전 층 UNMEASURED)을, CLI `scripts/ledger/record-verify.mjs` 가 **분자행**을 쓴다(리더 결정 L-3) — 런타임 호출자 0 → **≥1** | — | **in-progress 유지 근거**: done 조건은 "호출자 ≥1 **AND** 층별 UNMEASURED 분모" 두 가지인데(next-batch-plan §0 행 3), 첫째만 충족했다. 설치본이 갱신되기 전이라 라이브 `verify.completed` 는 여전히 0 — 분모는 미측정. 정정: **SubagentStop 은 이 게이트를 타지 않는다**(dispatch-table Stop 슬롯만). Wave 10 배치 4 `c732eaa9`(줄기 `399c9ff2`) `verify-numerator-rate` 로 **분자 판독기** `lib/verification/verify-rate.js` + `scripts/ledger/verify-rate.mjs`(판독 전용, 분류 단위 = (session_id, verification_id) 쌍) 착지 — 서브번들 A 만. **라이브 분모 수치는 미측정** — 판독기 결과를 받은 뒤 리더가 별도 갱신한다(§4 ③ 참조). 후속 — `record-verify.mjs` 호출률 측정 수단 0 · `saveFingerprint` 실패 시 이중계수 승계 · `existingKeys` 선형 판독(200k 행 572ms). **Wave 11 배치 9 `9165196f`**(줄기 `f7d0e7f9`, 커밋 `321da9a6`·`8f6df73f`·`f7d0e7f9`, 9 files +1,476/−127) `verify-completed-producer` 착지 — `lib/verification/deterministic-source.js`(F1/R1/A1) + `verify-rate` **4버킷**(self > measured > hook > other) `measured_rate` + `emptyRun` 봉인. **라이브 분자는 여전히 미측정**(설치본 갱신·호스트 재시작 전) |
| OB-08 | usage receipt 파서 + writer(§55 #8) | §4 · §3.2 · D2 | done | 4.57.0 `scripts/hooks/session-end.js#recordUsageReceipts` · `lib/economics/usage-receipt.js#buildUsageReceipts`; 라이브 PASS(4.57.0·4.58.0 판정 2) | `usage-receipt-schema-guard` | cost.total null · pricing_version unresolved(I1); 커버리지 ≥95% 비율 미계산 |
| OB-09 | `/doctor` Check 8(+9·10 동승) | §4 · §3.6 | done | `lib/project-state/doctor-checks.js#checkLedgerStateParity`·`#checkStateVersionGaps`; W5-a `23ec79be`·`d1ded07f`(4.60.0) | Check 8 실행형 worktree 테스트(4.58.0 #G16) | 4.60.0 설치본 재판정 필요(§4) |
| OB-10 | Mission Controller 기록 전용(§48 #2) | §7.3 · F4 | todo | `lib/mission/` 6파일 중 controller 없음(Glob) | — | 전이 결정은 CA-14 |
| OB-11 | Execution Profile 8키 기록(§48 #4, F2) | §7.3 · G-1 | done | `lib/routing/execution-profile.js#PRIORITY_ALIASES`(4.55.0) · `schemas/execution-profile.schema.json` | `v5-config-firewall` | G-1b(economy 손실) 미결 |
| OB-12 | Task Graph 스키마 + store(§48 #6) | §7.3 | in-progress | `schemas/task-graph.schema.json` · `lib/project-state/lease.js` · `state-manager.js#claimTask`(만료 재클레임 포함)·`#releaseTask` **실재**(리더 grep 2026-09-14) | — | 구현 있음 · 프로덕션 호출자 0(자기 배선 + resume-controller 주석뿐). done 조건 = 호출자 ≥1(CA-05 `/save`=checkpoint 또는 resume-apply) |
| OB-13 | 5개념 분리 `lib/routing/` 5모듈(§48 #12) | §7.3 · §3.2 | done | `adaptive-model-router.js` · `model-switcher.js` · `escalation-controller.js` · `route-hysteresis.js` · `execution-profile.js`(+`action-classifier`·`route-scorer`) | `layer-registration-coverage` | `resolveModel` byte-identical 유지 |
| OB-14 | completion gate 카운트(§48 #14, C4) | §7.3 · 후속(1) C4 | done | `lib/runtime/artifact-lifecycle-gates.js#DEFAULT_POLICY`(unmeasuredBlocksOutcome) · config `review.verify` | — | 강제는 CA-13; config 키 소비처 0(config 주석 실측) |
| OB-15 | file ownership Task Graph 필드 기록(§48 #16) | §7.3 | todo | 미확인 | 강제는 기존 `lib/git/limb-landing-check.js` | |
| OB-16 | redaction 재사용(§25) | §7.3 | done | `lib/runtime/ledger-redaction.js`(memo · MAX_REDACT_NODES, 부록 T-20) | `ledger-append-survival` | |
| OB-17 | Switching Cost 추정치 기록(measured:false, §55 #4) | §8.4 | in-progress | `lib/routing/route-hysteresis.js` 존재. Wave 11 배치 5 `6a2a0eff`(줄기 `55b0defa`, 10 files +1,584/−49) `ob17-switch-reasons`: **H1 `residency-unknown` 사유 코드**(fail-closed 유지, 오너 W11-Q2) + **K1 incumbent = 전사 tail**(오너 W11-Q1 — `session-start.js` 무접촉, 호스트 payload 에 `model` 키가 없어 전사 마지막 assistant `message.model` 을 카탈로그 티어로 사상) | — | `terms{}` 원장 기록 미확인. 잔여 — `lib/core/model-catalog.js` 의 sonnet id 가 라이브 전사(`claude-sonnet-5`)와 어긋나 **카탈로그 미등재 모델은 미공급**(드리프트, 리더 todo 17) |
| OB-18 | Replay 읽기 모델(§55 #9) | §8.4 · §8.3 | done | `lib/replay/replay.js#loadReplay` · `route-bind.js`(Check 10) · `existence-audit.js`; dedupe 5필드(4.58.0) | `tests/replay/replay.test.js` | |
| OB-19 | Snapshot Scorecard `/save` 렌더(§55 #10) | §8.4 · §31 | in-progress | `lib/scorecard/{session-scorecard,routing-scorecard,render,metric}.js` · `commands/scorecard.md` 존재; `commands/save.md` 에 checkpoint/렌더 0건(grep) | `command-output-invariance` | `/save` 순서 확정은 CA-05 |
| OB-20 | 메모리 주입 계측만(현행 기본값 유지) | §8.4 · G2 | done | `decision-events.js` `memory-injection-measured` 어휘 · `tests/hooks/runtime-prompt-memory-instrumentation` | — | A/B 는 SH-22(보류) |
| OB-21 | Avoided Switch 계산 | §8.4 · §38 | done | Wave 9 p1 `18ac5644`(줄기 done `c158a718`): `lib/scorecard/routing-scorecard.js` 가 "추천≠정책 스폰 중 pin 사유가 있는 회피" 를 원장 fold 로 계산 + `lib/scorecard/index.js` export + `tests/scorecard/routing-scorecard.test.js`; 라이브 첫 값 `route.selected` 102행 중 12 = 11.8%(2026-09-14 09:10, dedupe 후) | — | **출처 정정**: 종전 "§36" 은 delegation 한도 행(설계 `ARTIBOT-5.0-DESIGN.md:386`)이고 Avoided Switch 원문은 §38(`MODEL-SWITCHING-SCORECARD.md` "38. Avoided Switches도 성능이다")이다 — 설계 `:479` 가 §36·§38·§37·§39 를 한 행으로 묶은 탓. 사유 3분류(cache affinity / low benefit / residency)는 미배선 — `data.source` 133/133 shadow · `residency:unavailable` 133/133 · pin 0(`route-observe-pre.js:259-276` 이 `currentTier` 미전달). `metric()` absent 계약 충돌 KNOWN DEFECT 핀 `:504-517`(오너 결정 A/A′ 대기) |
| OB-22 | `human.asked` 훅 writer + Write/Edit 대칭(§19 writer 비대칭) | §8.2 §19 · §3.4 OD-5 | done | 4.57.0 `lib/runtime/human-asked-record.js#recordHumanAsked`; 라이브 PASS(4.57.0·4.58.0 판정 1, HG-04) | `human-gate-matrix-selfcheck` · `hook-decision-invariance` | `human.resolved` writer 는 SH-27 |
| OB-23 | `HUMAN_GATE_MATRIX` HG-01…13 정의 + `pre-bash`/`pre-write` block 사유 | §3.5 · C2 | done | `lib/security/human-gates.js#HUMAN_GATE_MATRIX`; HG-07 `human`(부록) | `human-gate-matrix-selfcheck` · `project-md-contract` | HG-07/12/13 강제 확대·C3 는 CA-04 |
| OB-24 | Existence Audit 카운트(훅·커맨드·스킬 발화) | §4 종료조건 · §3.7 D18 | in-progress | `lib/replay/existence-audit.js`; 분모 부재 `unmeasured:no-event-carries-<kind>`(부록 T-44) | `existence-audit-section` | carrier 필드 결정은 SH-29 |
| OB-25 | `decision-trail.json` 동결(D9, TR-1~3) | §5 D9 · 후속(3) | done | 4.56.0 `lib/core/decision-trail.js` `enabled:false` + config `ago.decisionTrail.enabled=false` | `trail-sandbox-required` | |
| OB-26 | `split.recommendMinSubtasks` = 7(Observe 데이터용) | §5 D12 | done | Wave 11 배치 1 `bb868e7f`(줄기 `464b7f7d`, 4 files +23/−11): config 값 `null` → **7** | `split-config-firewall` | D12 권고 이행 완료(종전 "미이행" 정정) |
| OB-27 | D안 에이전트 2종(investigator·auditor) + allowlist 8→10 + `review.claim_audit` 어휘 | 후속(3) MP-1~5 | done | 4.56.0 `agents/investigator.md`·`auditor.md`; allowlist +1 | `agent-name-references` · `validate-model-policy` | `plugin.json#agents` 28 vs 30 누락은 §3 |

### Shadow · 비교 (30)

| ID | 항목 | 출처 | status | evidence | 게이트 | 비고 |
|---|---|---|---|---|---|---|
| SH-01 | `missions/<M>/intent.md` 생성 시작(§48 #3, v1.1 P0-4) | §4 · §3.1 · C9 | done | Wave 8 p4 `9300568e`(줄기 done `7d75031a`): PreToolUse `Write\|Edit` 훅 `scripts/hooks/intent-observe-pre.js`(stage-② S1 확정 → `mission.created` + `missions/<id>/intent.md`, stdout 바이트 불변 3케이스) + `lib/runtime/artifact-lifecycle.js#apply` 게이트 3(`write===true`) writer; 임시 리포 실측 intent.md 677B 왕복 동일 3회 독립; `tasks.js` title 운반 | `artifact-governance` · `hooks-schema-shape`(핀 갱신) | C9 베이스라인 created/(created+deferred)=20/243=8.23%(stage-② 배포 전, 우회 직접 측정 아님); 4.61.0 `false` 출하(결정 2026-09-14 ①), ON 전환 = Shadow 진입 릴리스; 프로젝트 단위 게이트는 Wave 9 후보(설계 :284 B4 동반); 라이브 호스트 발화 미측정 |
| SH-02 | artifact-lifecycle 이벤트→intent/plan/review/outcome.md(§48 #10) | §7.3 · Hardening §6 | in-progress | intent.md 쓰기는 SH-01(p4 `9300568e`)로 착지. Wave 9 p3(줄기 done `15af93e2`): `lib/review/review-artifact.js` 직렬화기 + SubagentStop 경로 `scripts/hooks/_review-stop-record.js` 배선으로 **review.md 경로 착지**(`review.completed` → review.md 왕복을 테스트로 실증) | — | **in-progress 유지 근거**: 4경로 중 review.md 1개만 착지했고 `plan.revised`·`mission.completed` 는 **emitter 가 0**(lib·scripts grep) 이라 plan.md·outcome.md 는 생성 경로 자체가 없다 — `ledger.js:484` 로 미션이 영구히 열린 상태. 라이브 0 은 정답이다(4.61.0 이 `runtime.artifactLifecycle.enabled=false` 출하, 리더 결정 ①). 후속 — review revision 승계는 설계 §7.2 결정 대기 · apply "never clobbers" 프로세스 간 TOCTOU(`file.js:139-149`, 발생률 미측정) · `plan.md ← plan.revised`(부록 T-40) |
| SH-03 | `command_activation` vs 실제 슬래시/힌트 수락 + nl-activation eval ≥90% 실사용 대조 | §4 · §3.1 | in-progress | `tests/evals/fixtures/nl-activation.cases.jsonl` + `nl-activation-fixture.test.js`(93/93) | `nl-activation-fixture` | 실사용 대조 0; A3 Act 시점은 원장 1릴리스 후. Wave 10 배치 2 `c9ad9819`(줄기 `92aa2f71`) `nl-activation-report` 로 읽기 전용 Shadow **계측기** `scripts/evals/nl-activation-report.mjs`(축 3개) 착지 — 분자 writer 는 리포 전역 0(오너 결정 대기)이라 activation 2축은 0/0 → null, `mission.deferral-rate` 251/274 = 0.916(@05:42Z) 만 값이 있다. status in-progress 유지(실사용 대조는 원장 표본 뒤) |
| SH-04 | `topology-actual` vs 추천 일치율(`/doctor`) | §4 · §3.5 | todo | lib grep `topology-actual` 0건 | — | **선행 = 감사 F04/F05**(E1 산입): `tasks.js:630` 이 System 2 만으로 팀을 정하면 actual≠recommended 가 구조적이라 분모 의미가 없다 → Wave 10 배치 4 `c732eaa9` `routing-single-decision`(줄기 `743ad7bb`) 착지로 **"착지 뒤 측정" 전제는 충족**. 단 착지분은 **F04 기록 전용**이다 — `decision-events` `data.mode` 1필드 + 양 System 에서 `buildWorkflowPlan` 계산·기록이고, `team.followWorkflowPlan` 은 예약 키로 **소비자 0**(전환은 미착지, config 무접촉, `auto-team-trigger` 는 분모 제외). F05 effort identity(`sessionId+promptId`, `current-effort.json` 병행 기록, `expiresAt` 만료 게이트)는 착지. **측정 자체는 미실시** → status todo 유지. Wave 11 배치 8 `ea44a1ab`(줄기 `a1dc8497`, 20 files +1,417/−113) `f04b-followplan-transition` 착지로 **F04(b) 소비자**가 생겼다 — 단 **코드 기본 false**, `artibot.config.json` 등재는 별 커밋(리더 todo 15), 전환 ON 은 Wave 12 |
| SH-05 | 라우터 추천 스폰의 영수증·평가점수 비교 | §4 · §3.2 | todo | 미확인(라이브 표본: 4.58.0 investigator recommended opus→selected fable 1건) | — | |
| SH-06 | recovery 분류 기록(기존 고정 전이와 달랐을 때) | §4 · §3.4 | in-progress | `lib/recovery/{failure-classifier,recovery-controller,plan-repair}.js` 존재(`recovery-controller.js#decide` 실재, engine 호출자 0 — `lib/recovery/*` 는 engine.js 를 import 하지 않음, critic 2026-09-14). Wave 11 배치 6 `a40534e1`(줄기 `f2c09d70`, 커밋 `fabee5cc`·`5ff0faf9`·`f2c09d70`, 표적 28파일 757/757) `sh06-engine-record-wiring`: `lib/autopilot/recovery-record.js` 가 VERIFY 결과를 **관측 저널**로 기록(never-throw 봉인). 기록 위치 = `state.recoveryJournal` + 원장 `recovery-decided` | — | **선행 = 감사 F02**(E1 산입): 전이 함수 `nextTarget(state)` 추출(Wave 10 창 1) 위에만 기록 배선을 얹는다 — F02 전 배선 금지. engine 기록 배선은 Wave 11 에 착지했으나 **status in-progress 유지** — 기록만이고 전이 소비자는 없다. **CA-03 은 C4 producer(Wave 12) 뒤**: 자유형 `verifyResult` 로는 모든 VERIFY 가 `ask_human` 으로 몰린다(리더 todo 5) |
| SH-07 | 가격 단일화 + 5.1 계수 실측(D1·I1, cache-roi 명시) | §4 · §3.2 · 부록 가격표 행 | done | Wave 8 p2 `34b6dbf6`(줄기 done `d6cccd0c`): `lib/core/model-catalog.js` 단일 가격표 → `lib/economics/usage-receipt.js`·`lib/runtime/middleware/cache-roi.js` 가 읽음 + `tests/economics/pricing-parity.test.js` 패리티 게이트(카탈로그·cache-roi·receipt·routing 한 표) | `usage-receipt-schema-guard` · `pricing-parity` | `cost.total` null 핀 유지(5.1 계수 실측은 미완 — 계수는 미검증 수치, I1 잔여). Wave 10 배치 3 `d480c026`(줄기 `ebd6bc8b`) `economics-coverage` 2부에서 **`priceReceipts` 기본 true**(행동 변화 — `usage.receipt.cost.total` 이 숫자가 된다, `=== false` 만 opt-out, 방화벽 핀 갱신 같은 커밋, end-to-end 실측 0.038825 USD) → null 핀은 해소 방향. 5.1 계수 실측은 여전히 미완 |
| SH-08 | seeded-defect 코퍼스 N 확정 + catch-rate·FP·위치정확도(opus 비교군) | §4 · §3.4 · C6 | todo | 코퍼스 grep 0건(픽스처 언급만) | — | **오너 결정 C6 선행(N·목표)** |
| SH-09 | 헌법 단계 B(B-1 체크포인트 결정형만 · B-2 Rationalizations 강등 · B-3 GRPO 절, A4) | §4 · §3.7 | todo | 미확인 | — | 조건: Observe 원장 1릴리스 후 |
| SH-10 | HANDOFF/NEXT-SESSION 렌더 뷰 전환(`derived-from` 헤더) | §4 · §3.3 | todo | 미확인 | `artifact-governance` #6 | |
| SH-11 | split run → `state.yaml.workers` 어댑터 | §4 · §3.5 | in-progress | `lib/topology/split-state.js` · `split-state-sources.js` 존재(쓰기=run.json) | `split-telemetry-callsites` | StateStore 착지 시 뒤집기 대기 |
| SH-12 | lease/heartbeat(§48 #15) | §7.3 · Hardening §9 | in-progress | `lib/project-state/lease.js` · `schemas/lease.schema.json`; heartbeat emitter 0(vnext ADDENDUM) | — | reclaim 은 CA-09 |
| SH-13 | resume/reconcile(§48 #17-18, vNext DR02) | §7.3 · Hardening §13 | in-progress | `lib/project-state/reconcile.js` 존재. Wave 9 p2 `f1f8311e`(줄기 done `2df68903`): `lib/checkpoint/resume-controller.js` + `lib/supervisor/lane-reconcile.js` 신설(둘 다 **report-only**) + `commands/resume.md` 규약 + `tests/firewall/resume-contract-report-only.test.js` — DR02 판독 경로 done | — | **in-progress 유지 근거**: 이 행은 resume/reconcile 전체를 덮는데 착지분은 report-only 뿐이다 — `/resume --contract` 실행 스크립트 부재 · `lib/supervisor/index.js` 배럴 미등록 · Canary 단계 10(lease 회수·모델 전환·스냅샷) 미구현 · CA-05 `/save` 배선 미완. apply 는 후속 줄기(`resume-contract-apply` 브리프 초안). `run.json` 어휘가 `LANE_OPS_STATES` 밖이라 라이브 전 레인이 `reconcile:ops-state-unknown`(split-ops 영역). revision 표기 3분기 — store 중첩 `intent.revision` vs 체크포인트 최상위 `intent_revision` vs 원장 `plan_revision`(공급 0), schemas 정본 결정 필요 |
| SH-14 | idempotency 런타임 원칙(§48 #19) | §7.3 · Hardening §11 | in-progress | `session-end.js#recordUsageReceipts` idempotency key · `lib/supervisor/run-store.js#appendEvent` actionId | — | 전 writer 일반화 미확인 |
| SH-15 | evidence registry `.artibot/runtime/evidence.jsonl`(§48 #20) | §7.3 · Hardening §23 | todo | 미확인 | — | 부록 유보(v1.1 runtime/ 허용 범위) 미해소 |
| SH-16 | Context Receipt writer(`context.compiled`, §55 #7 · §48 #21) + vNext CX02 | §8.4 · §8.2 §8 | in-progress | Wave 8 p3 `b906264a`(줄기 done `fc21e99e`): `lib/context/context-pressure.js`(순수 점수, `round4(clamp(tokens/maxTokens))`, 호스트 `context_window` 없으면 null) · `context-receipt.js`(조립기, dotted missing) · `rehydration.js#reportContextReceipt`(writer 주입 포트) + PostCompact 배선; 2×2 source 실측 핀(hook 거부·worker 수락). **라이브 발행 0 — 구조적**: PostCompact 시점 필수 10키 중 6(라이브 5)만 채움, mission_id·based_on·transforms·cache 생산자가 훅 경로에 없음 | — | 결정 2026-09-14 ②: `worker` 유지. 재개 조건 = 훅 호출자가 10키 실측 공급 가능 시, 그때 §8.2 문구 정정 우선 검토; `context-tracker.js` 128k 하드코딩 vs 카탈로그 ctxLimit 드리프트(§3) |
| SH-17 | Artifact Health `/doctor` Check 9(§48 #24) | §7.3 | done | `doctor-checks.js#checkArtifactHealth` · `commands/doctor.md` Check 9; 라이브 실행(unmeasured, missions 0) | — | Shadow 사상이나 이미 착지 |
| SH-18 | ADR question gate 4조건 기록(§48 #27) | §7.3 | in-progress | `lib/planning/question-gate.js` 존재; `adr.*` 이벤트 0(부록 T-40) | — | 강제는 CA-15 |
| SH-19 | delegation depth 기록(§36) | §7.3 | todo | 미확인 | — | |
| SH-20 | Final Scorecard(outcome.md 트리거, §55 #11) | §8.4 | todo | 미확인 | — | SH-02 선행. Wave 11 배치 7 `686df95b`(줄기 `6d612dbf`, 16 files +4,514/−24) `outcome-md-emitter` 착지 — SessionEnd `mission-complete-record` + `outcome-census` CLI + gates `requiredLayers`(C4 (i)). **킬스위치 false 출하**라 라이브 생성 0 이 정답 |
| SH-21 | Checkpoint/Resume DR01·DR02 `lib/checkpoint/` + 불변성 테스트(§55 #12·#13) | §8.4 · §8.2 §21~26 · vnext ADDENDUM §6 | done(DR01) | Wave 8 p1 `e9e24e2e`(줄기 done `40a8d21d`): `lib/checkpoint/{checkpoint-store,checkpoint-service,checkpoint-validator}.js` + `adapters/` · `lib/supervisor/contracts.js#validateCheckpoint` · `tests/firewall/checkpoint-immutability.test.js` · `tests/checkpoint/` 4파일 | `checkpoint-immutability` | DR02(재개 주입)는 미착수 — 순서 DR01→CX02→DR02; 재개 정본 = 트레일러 증거·checkpoint 는 주입 번들(§3.5 확정) |
| SH-22 | 메모리 주입 A/B(`ARTIBOT_RUNTIME_MEMORY_DISABLE`) | §8.4 · G2 | 보류 | 후속(1) G2: 계측만 유지, 표본 n>1 축적 후 | — | 임계 미확인 |
| SH-23 | Mission Reflection(미션 경계 reflect) | §8.4 · §8.2 §16 | todo | 미확인 | — | G2 후 |
| SH-24 | Generated Knowledge `.artibot/generated/` | §8.4 · G3 | 보류 | 후속(1) G3: 도입 보류(소비처 0) | — | 소비처 ≥1 시 재검토 |
| SH-25 | RouteBench + 기준선 B0~B4 | §8.4 · §8.2 §11 · G4 | done | Wave 8 p4 `9300568e`(줄기 done `560d1bce`): `scripts/bench/routebench.mjs`(오프라인 채점, 결정성 핀, 네트워크 금지 39토큰 + 양성 대조) + `tests/evals/fixtures/routebench/baselines.{json,schema.json}`(B0~B6; B2=`resolveModel` 호출, B3/B4 `definition_confidence:"inferred"`, B6 `unimplemented`) + `scenarios.schema.json` 선택 `agentType` + 러너·픽스처 테스트 2; 봉투 `policy_source{fable_enabled,allowlist_size}` + `baselines_sha256` | `no-control-bytes`(pairKey NUL 수리) | 예시 시나리오 2건 전부 `fixture-pending`(배관 증명, 정책 재현 아님). **후속 착지**: 오너 결정 2026-09-14 ③ "공급" 을 Wave 9 p1 `18ac5644`(줄기 done `1fbe6961`, 5 files +260/−25)가 이행 — `routebench.mjs` B4 resolver 가 `routeModel` 에 `input:{agentType}` 을 넘기고 `baselines.{json,schema.json}` 을 맞췄다(lib 무변경). `baselines_sha256` 이 바뀌므로 `_benchmarks/routing/` 의 이전 로컬 리포트와 비교 불가 라벨이 붙는다. 잔여 — B3 정적 표의 security-reviewer→fable 괴리(denylist 는 `resolveModel` 전용) · 봉투 `policy_source.config_path` 미기록 · 러너 테스트 로컬 BASELINES 사본의 `schema_version` 1 잔존(의도) · 시나리오 라이브화는 Wave 10 후보(`routebench-scenarios-live` 브리프 초안) |
| SH-26 | Replay EXACT/PARTIAL/SIMULATED 라벨 | §8.4 · §8.2 §13 | todo | 미확인 | — | |
| SH-27 | Human kind 3분리 `human.resolved{kind}` writer | §8.4 · §8.2 §19 | done | Wave 8 p5 `ee86a639`(줄기 done `c20ca01f`): `lib/runtime/human-asked-record.js#recordHumanResolved`(kind enum 3, 스킵 사유 5, decision 3,072B 사전검사) + CLI `scripts/ledger/record-human-resolved.mjs`(모델이 답 직후 호출, `question_id` 를 asked 와 같은 경로로 재계산 — 실제 pre-write 훅 spawn 대조) + `.artibot/project.md` §Human Approval Boundaries 규약 7줄 | `ledger-vocab-allowlist` · `project-md-contract` | 호출부 (a) PostToolUse 부적합(페이로드에 subject 없음, 호스트 발화 미확인) → (b) CLI; `kind_source:"self-report"`; **CLI 호출 주체 아직 0**(호출률 미측정); 라이브 `human.asked` 52 / `human.resolved` 0(2026-09-13) |
| SH-28 | residency/cooldown 보정 | §8.4 · G5 | 보류 | 후속(1) G4·G5: `UNCALIBRATED` 유지 | — | 보정 자격 측정 미확인 |
| SH-29 | Existence Audit carrier 필드 결정(`tool.used.data.skill` 등) | 부록 T-44 | todo | Wave 11 배치 4 `059e81e1`(줄기 `1943cae8`, 13 files +1,190/−59) `sh29-carrier-writer`: `tool.used` writer 를 PostToolUse Skill 로(dispatch-table 12, hookScripts 74) | — | OB-24 의 분모. 오너 W11-Q3(a) 로 **skill 키만** 착지 — command(`intent.detected` writer)·hook(신규 이벤트)은 Wave 12 어휘 결정 동반이라 status todo 유지 |
| SH-30 | decisions 사이드채널 sources 규칙 통일(hook 발행자 이벤트) | 부록 T-51 2차 C | todo | 미확인 | — | |

### Canary · 저위험만 자동 (20)

| ID | 항목 | 출처 | status | evidence | 게이트 | 비고 |
|---|---|---|---|---|---|---|
| CA-01 | 저위험 커맨드 자동 활성(A2 allowlist 5종 + autopilot 게이트 히트 0∧allowlist) | §4 · A2·A3 | todo | — | — | A3: Shadow 원장 1릴리스 후 |
| CA-02 | `classify·status` 만 haiku/sonnet 실적용(`routing.canary.actionClasses`) | §4 · §3.2 OD-2 · D5 | todo | config `routing.canary.actionClasses: []` 실측 | `v5-config-firewall` | I4·I7 선행 |
| CA-03 | autopilot `nextPhase` = verdict 함수 | §4 · §3.4 | todo | — | — | SH-06 선행. **선행 = 감사 F01·F02**(E1 산입, Wave 10 창 1 `autopilot-phase-transition`): F01 결과 보존 불변식 없이는 verdict 가 정리를 트리거할 때 미통합 결과 브랜치를 지우고, F02 전이 단일화 없이는 verdict 함수가 꽂힐 자리(`pendingPhase`)가 없다. Wave 12 에 config 기본 false 로 착지, Wave 13 에 ON. CA-14 와 같은 결정. **선행 충족**: Wave 10 배치 6 `e10ebabe`(줄기 `a88eb5e7`) `autopilot-phase-transition` 착지 — F01 결과 보존(`resultHead/resultRef/integrationTarget`, integrationTarget 부재 = 삭제 금지) + F02 durable 전이(`nextTarget` 순수함수 추출, `pendingPhase`, attempt journal, session v3 + `.bak`), 프로브 AP-01/02/05 false. 4.62.0 노트 ③ 의 F01 임시 경고는 이 착지로 해제. verdict 함수 자체는 미착수 → status todo 유지 |
| CA-04 | `HUMAN_GATE_MATRIX` 훅 강제 확대(HG-07/12/13) + `.claude/` 축소(C3) | §4 · §3.5 · C3 | todo | 4.57.0 Known "HG-07/12/13 강제는 Canary 미착수" | `human-gate-matrix-selfcheck` | |
| CA-05 | `/save`=checkpoint 순서(§31) · `/resume`=ARTIBOT 읽기 순서 | §4 · §3.3 · §8.2 §31 | todo | `commands/save.md` checkpoint 0건 | `command-output-invariance` | SH-21 선행 |
| CA-06 | 헌법 단계 C-1(ROUTING advisory-only 단계 표기) | §4 · §3.7 | todo | — | — | |
| CA-07 | (D04) bounded blindspot 자동수정 | §4 · A1 | 기각 | 후속(1) A1: 자동수정 금지, dry-run 제안까지만 | — | |
| CA-08 | staleness 자동 차단(§48 #8) | §7.3 | todo | — | — | P0-14 규칙 위 |
| CA-09 | lease reclaim(§48 #15) | §7.3 | todo | — | — | |
| CA-10 | delegation cap 차단(§36) | §7.3 | todo | — | — | |
| CA-11 | split 통합(§48 #22) | §7.3 | todo | — | — | |
| CA-12 | fast objective 실적용(§48 #23) | §7.3 · §3.2 | todo | — | — | G6 `wallclock_throughput` UNATTESTED 유지. **선행 = 감사 F03·F10**(E1 산입, 롤링 줄기 `autopilot-budget-units`): 토큰/USD 예산 단위 분리(`budgetTokens`+선택 `budgetUsd`) 없이는 fast 가 상한 없이 돌고, `--no-team`(F10) 이 instruction 에 반영되지 않는다. unknown usage 정책은 E9(경고만). **선행 충족**: Wave 10 배치 10 `971f0f26`(줄기 `666683cb`) `autopilot-budget-units` 착지 — `budgetTokens` 정본 + `budget` 미러(1릴리스) + 선택 `budgetUsd`, `normalizeBudget` 단일 읽기, 단위별 `thresholdsFired{tokens,usd}`, `receiptId` 중복 1회 계수, pause 사유 `budget-exceeded`, 미측정 사용량은 `unknown` + 경고 1회/세션(E9), `budget:0`·비수치는 기본 2M fail-closed. F10 = `--no-team` 이 실행 지시에서도 단독(`execution:'solo'`, Agent 스폰 0). 프로브 AP-03·AP-04 false(→ 5/5 false), 라이브 영향 = 부모 store 2,668 세션 중 pause 로 뒤집히는 세션 0. fast objective 실적용 자체는 미착수 → status todo 유지 |
| CA-13 | 완료 게이트 강제 = outcome.md 생성기(§48 #14 · §55 #15) | §7.3 · §8.4 · §3.4 | todo | Wave 11 배치 7 `686df95b`(줄기 `6d612dbf`) `outcome-md-emitter`: 생성기 + gates `requiredLayers`(C4 (i)) 착지 | — | SH-02·SH-20 선행. **킬스위치 false 출하** — 강제(생성 거부)는 미적용이라 status todo 유지 |
| CA-14 | Mission Controller 전이 결정(§48 #2) | §7.3 · F4 | todo | — | — | OB-10 선행 |
| CA-15 | question gate 강제(§48 #27) | §7.3 | todo | — | — | SH-18 선행 |
| CA-16 | Switch Controller 실적용(`switch` decision, 스폰 단위, §55 #3) | §8.4 | todo | — | — | I7 미확인 → 단위 = 스폰 |
| CA-17 | Fable review binding `assertIntentBinding`(§55 #14) | §8.4 · §3.4 | todo | 미확인(심볼 존재 미열람) | — | |
| CA-18 | Switch Efficiency KPI | §8.4 | todo | — | — | |
| CA-19 | Builder≠Reviewer 위반 거부(C5) | §5 C5 | todo | 미확인(`assertIndependence` 미열람) | — | Observe 는 기록 |
| CA-20 | human-gate 매트릭스 자기검증 게이트 | §4 게이트 열 | done | `tests/firewall/human-gate-matrix-selfcheck.test.js` 실재 | 동좌 | 게이트만 선착지 |

### GA (7)

| ID | 항목 | 출처 | status | evidence | 게이트 | 비고 |
|---|---|---|---|---|---|---|
| GA-01 | 저위험 외로 확대 | §4 | todo | — | — | **오너 결정 G1(2026-09-14): v5.1 트랙** — v5.0 릴리스 조건 아님. baseline 캠페인(30~50과제×3회) 뒤 |
| GA-02 | 4티어 전면 | §4 · §3.2 | todo | — | — | |
| GA-03 | split 자동 진입(WP02 선행) | §4 · §3.5 | todo | — | — | 창을 사람이 여는 한 불가. **오너 결정 G1(2026-09-14): v5.1 트랙** — WP02 = 프로세스 스폰 = HG 매트릭스 신규 행(감사 DEFER "자동 창 실행"). GA-02 는 "기전 GA"(allowlist 로 열리고 config 1키 되돌림 실증)로 v5.0 조건 유지 |
| GA-04 | §48 P2 7항(#25 identity · #26 role/permission · #28 audit summary · #29 retention/GC · #30 memory promotion 코드 게이트 · #31 schema migration · #32 cross-repo) | §7.3 | todo | `memory.*` 5이벤트 어휘만 존재 | — | 스키마는 Phase 0 예약 |
| GA-05 | §57 P2 7항(Shadow Learner · 학습 임계 · Canary Router · 롤백 · RouteBench CI · 멀티리포 · 토폴로지 인지 평가) | §8.4 | todo | — | — | Learner 불가침 4경계(§8.2 §14) |
| GA-06 | GA 비의존 목록 5종 명문화(online RL · 재귀 생성 · 무제한 debate · 은닉 캐시 해킹 · cache_transfer 필드) | §8.2 §9·§58 | todo | 미확인 | — | 문서 항목 |
| GA-07 | 파괴·배포·외부쓰기·제품결정 사람 게이트 영구 | §4 · OD-1 | done | HG-07 `human` 확정(부록 T-38) · `human-gates.js#HUMAN_GATE_MATRIX` | `human-gate-matrix-selfcheck` | 영구 조건 — 되돌림 없음 |

## §3 기술 부채·안전 결함 트랙 (로드맵 밖, 진행률 불산입)

| 항목 | status | evidence | 선행 조건이 되는 단계 |
|---|---|---|---|
| L2 `dd`·`curl`·`wget`·`git push` 4계열 ReDoS `{0,192}` | done | `8f473a9e`(4.60.0) `lib/autopilot/safety.js` | Canary(PreToolUse 5초 예산 안에서 HG 강제) |
| 잔여 5규칙 2차식(L1 rm 2 · pipe 2 · L2 sql-delete) | in-progress | Wave 7 `guard-redos-residual` done `f5353232`(배치 랜딩 중) | Canary |
| L1 `normalizeCommand` 줄바꿈 보존 · fork bomb 규칙 · `dd of=/dev/` L1 | done | `3ca95219`(4.60.0) `lib/core/guard-registry.js#normalizeCommand` · `blocked-patterns.js` | Canary |
| `git branch -d` `/i` 오탐 · lease caution · TRUNCATE 문 형태 · `dd` L2(오너 4건) | done | `9a4794c3`(4.59.0) | Canary |
| `git checkout -- .` · lease+force 면제 구멍 | done | `8f473a9e`(4.60.0) | Canary |
| guard-command-position(`echo "X"` 언급 발화, L1 34/34·L2 17/17) + human-gates.js:179/:181 4.9s | done | Wave 9 p3 `3ba981eb`(줄기 done `10cb53ff`, 11 files +1,925/−57): `lib/core/command-segments.js` 신설이 명령 위치를 앵커해 언급형과 실행형을 가르고 `guard-registry.js`·`safety.js`·`human-gates.js` 가 이를 경유. 실측 — 언급 8래퍼 0/39 발화(`echoBare` 4/39 정당), 실행형 양성 손실 0(2,872건 L1 490→476, 손실 14 전부 언급형), PARITY 38→50(agreed 44 / owner-decision 6), 전체 PreToolUse 40,962B 최악 35.0ms | Canary |
| guard L2 잔여 2건 — `sql-delete-no-where` 가 `DELETE FROM t WHERE id=1` 을 danger 로 오판(몸통 클래스가 공백 포함) · `rm-rf-root` 가 루트 타깃 직후 따옴표·괄호를 못 잡음(L1 block / L2 safe) | todo | Wave 9 `guard-command-position` 줄기가 **핀만** 남김(둘 다 소유 밖, `DANGEROUS_PATTERNS` 무접촉 조건). 수리안 = 몸통 클래스 축소 · 타깃 클래스에 따옴표·괄호 추가 | Canary |
| 정규식 정적 스캔 4번째 카탈로그(`guard-registry` SENSITIVE/SECRET · `scripts/hooks/**` · command-segments 자체 정규식 · `normalizeCommand` 바운드 2건) | todo | Wave 9 실측: `normalizeCommand` 의 `$(…)`·`${…}` 2차식을 줄기 안에서 `{0,192}` 로 수리했으나 **현 3카탈로그 스캔이 이 두 정규식을 보지 못한다**(구조적 사각) | Canary |
| split 운용 — `resolveDispatch` 완료줄기 선제외(gotcha 92) + `land.mjs` 설정 파일 핀 테스트 나열(gotcha 91) | done | Wave 9 p1 `18ac5644`(줄기 done `2fc59540`, 5 files +558/−14): `lib/git/split-dispatch.js` 선제외 + `scripts/split/land.mjs` 핀 테스트 나열 + `tests/split/land-pin-tests.test.js` 신설 · `commands/split.md` 문구. **잔여**: `excludeLimbs` 가 `split.md` 절차 코드에만 배선(`dispatch.mjs` 는 `resolveDispatch` 미호출) · `pinTestsFor` 는 줄기 자신이 추가한 테스트를 못 봄 · `run.json` `dispatched`/`landed` writer 는 여전히 리더 수기(lib·scripts 0) | (랜딩 게이트 신뢰) |
| release.yml 산문 동기화 순서 + SYNC_PATHS 9경로 | done | `c298a7f0`(4.60.0); 라이브 실증 v4.60.0 배지 `f75e849f` | (릴리스 절차) |
| 원장 위치 ADR-011 이관 실행(`ledger.jsonl`·`spawns.ndjson` 리더 수동 1회) + `.pre-adr011` 삭제 | **done(이관) / 삭제 대기** | 리더 실행 2026-09-14 12:31 KST: 레거시 `.artibot/runtime/ledger.jsonl` 349행 + 라이브 `.git/artibot/ledger.jsonl` 389행(선존재 함정 — 옆으로 옮겨 마지막 `--worktree` 입력) → **738행**, lineCountMatch true, sha256 `a9f35e0d…`, `readLedgerCensus` duplicate 0, Check 8 pass(journal 28). 보존: `ledger.jsonl.pre-adr011`(349) · `ledger.jsonl.live-premerge-20260914`(389). spawns 는 레거시 파일 부재 → 대상 없음(공유 125행). 절차 5(라이브 창 2개 확인) 미실행. **삭제는 4.63.0 릴리스 체크리스트** | Observe 종료 판정(Check 8 분모) |
| `tests/supervisor/v11-status-mapping.test.js` 가 gitignored `_benchmarks/`·미추적 `_reports/` 를 walk — 전체 vitest 유일 실패(환경 오탐) | done | `ba7d29bb`(2026-09-14) SKIP_DIRS 에 두 디렉터리 추가; 4.62.0 CI 17,365 pass / 0 fail | (랜딩 게이트 신뢰) |
| 감사 F06~F09(split pointer prompt.md 미참조 · done 창 선제외 잔여 · `interpret-trailers --parse HEAD` 문구 · push 거절 = moved 오분류) | done | 수리 착지 — Wave 10 배치 4 `c732eaa9` `split-ops-remediation`(줄기 `22cc4323`): F06 pointer 에 prompt.md 경로 · F07 lane writer 단일화 + allowlist 밖 state 경고 · F08 `%(trailers:key=Split-Limb,valueonly)` (+ `plan.limbs[].forkPoint`, `materializeLimb` SIBLING_FILES, `schema_version`) / Wave 10 배치 8 `25d3a4b0` `batch-landing-push-classify`(줄기 `4f4e9c5f`): F09 `classifyFfRefusal` — 원격 tip 재읽기 뒤 같으면 `push-failed`(stderr 원문·보존 batch SHA), 다르면 `moved`(RED 실증 2·2·2·needs-human → 1·1·1·push-failed). 감사 원본 `_reports/v5-pipeline-audit-2026-09-14/AUDIT.md` + 리더 HEAD 재현 2026-09-14(S1·S3·S4 reproduced) | (랜딩 게이트 신뢰) |
| `spawns.ndjson` 공유 스토어 이관(spawn-ledger-store) | in-progress | Wave 7 done `1f32cab2`(배치 랜딩 중), 드라이런 Σ443 일치 | Observe(Check 10 비대칭) |
| Check 8 프로젝트명 fold(W5-a) | done | `23ec79be`·`d1ded07f`(4.60.0) `doctor-checks.js#checkLedgerStateParity` | Observe 종료 판정 |
| ledger reader dedupe pid 충돌(ts 키) | done | 4.58.0 `lib/runtime/ledger.js#dedupeKey`·`replay.js` | Observe |
| UPS 발신자 가드(task-notification · cross-session · agent 봉투) | done | 4.57.0 + 4.58.0 `_userprompt-dispatcher.js`; 라이브 PASS 4.58.0 판정 5 | Observe(routing-classified 분모) |
| install 이중 적재 · rules 전달(ADR-002) | done | 4.58.0 `install.sh`/`install.ps1` | — |
| frontmatter 중복키·블록 스칼라·빈 description 게이트 | in-progress | `62d4d608`(4.60.0) done; W7 `frontmatter-hardening` `4f432d24` done(배치 랜딩 중) | — |
| `plugin.json#agents` 28 vs `agents/*.md` 30(auditor·investigator 누락) | done | Wave 8 p1 `e9e24e2e`(줄기 `8e59d7ca`·`007b527b`): `plugin.json#agents` 30 등록 + `tests/ci/agents-manifest-parity.test.js` 매니페스트↔디렉터리 패리티 게이트(중복 항목 보고 포함) | Observe(MP-3 에이전트 실효) |
| 테스트 플레이크(git-dir spawn · handoff-store EPERM · landing-serialization rebuild 30s) | in-progress | `c571b49d` EPERM 재시도 done; W7 `test-load-flakes` done `c5fbaf2f`(배치 랜딩 중) | (랜딩 게이트 신뢰) |
| hook-latency-bench(N=20, 예산 초과 0) | done | `40cdf344`(4.58.0 Wave 4) | Canary(훅 확대 시 예산) |
| skill-description-render 원인(호스트 `skillUsage` 규약) | done | `033e19da` | — |
| `landing-lock` 근본안(tmp+linkSync) | 보류 | 오너 #42; 최소 수리 `e0aa2580` 운용 | — |
| lock-harness(직렬 실경합 실측) | todo | worktree-ineligible, 단일 창 `/team` | — |
| hooks.json 매처 평문화·timeout 초 단위 | done | 4.56.0 #49·#50 | Observe(보안 훅 발화) |
| decisions 스토어 projectRoot + 후속 12 B/D | done | 4.55.0 `flushRecorderStats` stderr · `decisions-store-sandbox-required` | Observe |
| git 경로 `-z` 14자리(후속 19) | done | 4.55.0(제외 2자리 오너 결정) | — |
| `runtime/user-profile.json` 벤치 오염 25/25 | 오너 판단 대기 | NEXT-SESSION 22:1x | — |
| `ci-utils#gitTrackedNames` 훅 환경(#56) | done | 4.56.0 | — |

## §4 Observe 종료 판정 현황

설계 §4 종료 조건 5축(분모 있는 수치) — 2026-09-11 기준 **판정 0/5**. 인프라 라이브 판정(4.57.0·4.58.0 5항)과 구분한다.

| 축 | 판정 | 근거 | 재판정 |
|---|---|---|---|
| ① compile 성공률 · substantive 분포 | 미판정 | 분모 미측정 — S4·S6 미배선으로 deferred 다수(부록 T-25), Check 9 item 5 missions 0 | writer 는 있음; 분포 집계 스크립트 0 |
| ② 추천≠정책 스폰 비율 | **첫 수치 있음, 판정 보류** | OB-21 fold 착지(Wave 9 p1 `18ac5644`) 로 첫 값이 나왔다 — **`route.selected` 102행 중 12 = 11.8%**(2026-09-14 09:10, dedupe 후, 이 리포 원장 1개). 표본 1회·단일 머신이라 종료 판정 임계로 쓸 수 없고, 사유 3분류는 아직 배선 0(`data.source` 133/133 shadow · `residency:unavailable` 133/133 · pin 0 — `route-observe-pre.js:259-276` 이 `currentTier` 미전달) | 설치본 갱신 후 재집계 + OB-17 `actionsSinceSwitch` 배선으로 사유 분류 · `metric()` absent 계약 A/A′ 오너 결정 |
| ③ verdict 파싱률 · 층별 UNMEASURED 비율 | **분모 쌓이는 중, 판정 보류** | 라이브 0 의 진짜 원인은 설치본 미갱신이 아니라 **설치본 `schemas/` 디렉터리 부재**(install.sh/ps1 가 복사 안 함 → `getAllowlist()` 빈 {} → 모든 이벤트 `unregistered-event` 거부, `df85f702` 수정). 수정 뒤 `verify.completed` 가 05:21Z 부터 누적: 13 id/6세션(@05:4xZ) → 112줄/28 id(@08:44Z, 전부 unmeasured, self-report 0). 분자 판독기 `scripts/ledger/verify-rate.mjs`(Wave 10 배치 4) 착지 — 분류 단위 (session_id, verification_id) 쌍 | 1릴리스 라이브 뒤 `verify-rate.mjs` 로 세션·발화 비율 재집계; 세션 salt(훅 id 세션 간 동일) · C4 UNMEASURED 정책은 Wave 11 정찰 `verify-completed-producer` |
| ④ 영수증 커버리지 ≥95% | 미판정(**분모 어휘·fold 착지**) | Wave 9 p2 `f1f8311e`: `session.ended` allowlist 등재 · Wave 10 배치 3 `d480c026`: `lib/replay/session-coverage.js#foldSessionCoverage` + `scripts/ledger/session-coverage.mjs`(조인 분자 정본, 분모 0 → null). 라이브(05:32Z 창 실측) ended 0 / coverage null / receipt_sessions 12 — 설치본 `schemas/` 수정 뒤 `session.ended` 도 쌓이기 시작할 것(**미확인** — 세션 종료 표본 아직 0). 같은 배치에서 `priceReceipts` 기본 true → cost.total 숫자(end-to-end 실측 0.038825 USD) | 1릴리스 라이브 뒤 `session-coverage.mjs` 재집계 |
| ⑤ 훅·커맨드·스킬 발화 카운트(Existence Audit) | **Shadow 이월(오너 결정 E2, 2026-09-14)** | 분모 부재 `unmeasured:no-event-carries-<kind>`(부록 T-44); 4훅은 디스크 산출물 0(4.55.0 「구조적 한계」). carrier 없이는 구조적 FAIL 이라 Observe 종료 판정은 **①②③④ 4축**으로 한다 | SH-29 carrier writer(`tool.used.data.skill\|command\|hook` 3키, E5 권장)는 Wave 12 Shadow 계측 |

인프라 라이브 판정(재사용 프로브 5종): 1 PreToolUse cwd/session_id PASS · 2 SessionEnd usage.receipt PASS · 3 Check 8 — 4.58.0 FAIL(측정 프레임) → 09-10 17:5x 원장 병합 후 parity PASS, 이후 W5-a(23ec79be) 수리 + ADR-011 위치 이관 → **4.60.0 설치본에서 재판정 진행 중(investigator, 2026-09-11 23:0x)** · 4 route.selected PASS · 5 UPS 가드 PASS(4.58.0).

판정: Observe "만들 것" 은 17/27 done 이지만 **종료 조건은 한 축도 수치가 없다**. 종료 선언 전에 최소 ②·④ 집계 스크립트(읽기 전용, `lib/replay/` fold)와 Check 8 재판정이 필요하다. ③·⑤ 는 writer/carrier 가 없어 Shadow 로 이월하지 않으면 Observe 가 닫히지 않는다 — 이월 여부는 오너 결정.

## §5 Shadow 진입 최소 집합 (선행 순서 · 크기 · 소유)

크기 등급: S ≤150줄 · M 150~600 · L >600 (구현+테스트 합, 추정 — 미측정).

| 순서 | 줄기 | 백로그 ID | 크기 | 소유(lib 디렉터리 단위) | 선행·결정 |
|---|---|---|---|---|---|
| 1 | DR01 checkpoint store + 불변성 게이트 | SH-21 | M | `lib/checkpoint/`(신설) · `lib/supervisor/contracts.js#validateCheckpoint` · `tests/checkpoint/` · `tests/firewall/checkpoint-immutability.test.js` | 재개 정본 결정은 §3.5 에서 이미 확정(트레일러=증거, checkpoint=주입 번들). 백엔드 OD-4 JSONL |
| 2 | CX02 context-pressure emitter + Context Receipt writer | SH-16 | S/M | `lib/context/` · `scripts/hooks/post-compact-rehydrate.js`·`pre-compact.js` · `tests/context/` | `split.contextLifecycle.enabled` 라이브 1회 관찰 후 |
| 3 | DR02 crash reconcile + Resume Contract `/resume` | SH-13 | M | `lib/project-state/reconcile.js` · `lib/supervisor/`(lane reconcile) · `commands/resume.md` | **lane-state 라이브 기록이 쌓여야 착수**(입력 비어 있음) — 1·2 뒤 |
| 4 | intent.md 생성기(S1·S2 도구 시점 확정 + missions/ 추적) | SH-01·SH-02 | M/L | `lib/intent/artifact.js` · `lib/runtime/artifact-lifecycle*.js` · `lib/mission/` · PreToolUse 훅 1(신설 또는 `pre-write`) · `.gitignore` · `tests/intent/`·`tests/runtime/` | Observe ① 분포 선행(S4·S6 배선). C9 우회율 측정 동반 |
| 5 | RouteBench 기준선 B0~B4 정의 + 러너 | SH-25 | M | `tests/evals/fixtures/routebench/` · `scripts/bench/routebench.mjs`(신설) · `_benchmarks/routing/`(로컬) | G4 B2 = 현행 2티어. seeded-defect 7축은 `high_risk_review` 픽스처 |
| 6 | seeded-defect 코퍼스 | SH-08 | L | `tests/evals/fixtures/seeded-defect/`(신설) · 1결함 1브랜치 | **오너 결정 C6(N·목표 catch-rate) 선행** |
| 7 | nl-activation 실사용 대조 리포트 | SH-03 | S | `tests/evals/nl-activation*` · `scripts/eval/`(신설, 읽기 전용) | 원장 표본 |
| 8 | verdict/verify writer 배선 | OB-06·OB-07 | M | `lib/review/` · `lib/verification/` · `scripts/hooks/subagent-stop`(또는 stop-review-gate) · `commands/team.md` Phase 3.5 | Shadow 분모 "outcome.md 조건 적용 시 막혔을 건수" 의 전제 |
| 9 | `human.resolved{kind}` writer | SH-27 | S | `lib/runtime/human-asked-record.js` · 커맨드 규약 1줄 · `tests/runtime/` | |
| 10 | 가격 단일화 | SH-07 | S | `lib/core/model-catalog.js` · `lib/economics/usage-receipt.js` · `lib/runtime/middleware/cache-roi.js` | I1 조회 1회 선행 |

겹침: 1↔3 은 `lib/supervisor/` 공유 가능 → 직렬. 4↔8 은 `artifact-lifecycle` 을 4 만 만진다면 무겹침. 나머지 pairwise 무겹침(디렉터리 기준).

## §6 다음 웨이브 권장 구성 2안

**(a) Shadow 진입 중심 7줄기** — DR01(1) · CX02(2) · intent-md-generator(4) · routebench-baseline(5) · verdict-writer-wiring(8) · human-resolved-writer(9) · pricing-unify(10). 소유 겹침 0(§5 표 기준). DR02(3)·seeded-defect(6) 은 선행 조건 미충족으로 제외. 권장 — Shadow 진입 항목 7/30 을 한 웨이브에 in-progress→done 으로 올리며, Observe ③·④ 분모도 같이 생긴다.

**(b) 부채 정리 혼합 6줄기** — spawn-ledger-store(W7 잔여) · guard-command-position(W8; `lib/core/blocked-patterns.js`·`lib/autopilot/safety.js` — W7 guard-redos-residual 착지 후) · plugin-manifest-agents(`plugin.json#agents` + 매니페스트↔디렉터리 게이트) · test-load-flakes 잔여 · DR01(1) · intent-md-generator(4). 겹침: guard-command-position 은 W7 같은 파일이라 W7 랜딩 선행; 나머지 0. 실 원장 이관(§3)은 줄기가 아니라 리더 수동 1회.

두 안 모두 `split.maxWindows=8` 안. 권장은 (a) — 단 W7 이 미랜딩이면 (b) 의 W7 잔여 2건을 먼저 닫는다. **리더 결정(2026-09-11 23:0x)**: (a) 채택 + 부채 예산 2(guard-command-position + human-gates 5s · plugin-manifest-agents) = Wave 8 총 8~9줄기 후보(창 상한 8 이내로 조정).

## §7 미확인 (추측으로 메우지 않음)

1. 기준 SHA `f75e849f` 는 loose ref 파일 읽기 — `git rev-parse`·packed-refs 대조 미실행(planner 창 Bash 없음). 리더 확인: master = f75e849f (2026-09-11 22:5x `git log`).
2. `git log --oneline v4.55.0..master` 미실행 — 커밋 SHA 는 CHANGELOG·NEXT-SESSION 인용값.
3. v5-design 디렉터리 git 추적 여부 직접 미확인(docs:check 스코프로 간접).
4. P0-05 표류 원장 삭제 실행 여부.
5. P0-13 Artifact Registry 스키마 존재.
6. 헌법 A-6·A-8 개별 이행. 홈 `~/.claude/rules/artibot/verification-discipline.md` 는 §12 까지(§13 없음) — 플러그인 `rules/` 사본 미열람.
7. OB-07 `unified-verifier` 런타임 호출자.
8. OB-12 Task Graph store 구현(claimTask/releaseTask).
9. OB-17 hysteresis `terms{}` 원장 기록.
10. OB-21 Avoided Switch 계산 코드.
11. SH-10 `derived-from` 헤더 존재.
12. SH-15 evidence.jsonl · SH-19 delegation depth · SH-26 Replay 라벨 — 코드 grep 미실시.
13. CA-17 `assertIntentBinding` · CA-19 `assertIndependence` 심볼 존재.
14. `_benchmarks/routing/` 로컬 존재.
15. 종료 조건 5축 수치 전부(planner 창에서 라이브 원장 재측정 0).
16. 4.60.0 설치본 Check 8 재판정(investigator 진행 중).
17. I7 호스트 실행 중 서브에이전트 모델 전환.
18. `canonicalModel` 이 4.58.0 부터 값이 생긴 원인(호스트 vs 바인딩).
19. §5 크기 등급 전부 추정(줄 수 미측정).
20. W7 4줄기 최종 랜딩 여부(배치 진행 중).
21. `plugin.json#agents` 누락이 신규 설치에서 실제 스폰 실패를 내는지(추론).
