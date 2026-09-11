# Artibot v5.0 백로그 — 진행률 단일 분모 (정본)

- 생성: 2026-09-11 (세션 25918244, NEXT-SESSION 「Wave 6 착지 + Wave 7 준비」 22:1x 절 이후). 작성: planner(fable) 초안, 리더 Write.
- 기준 master: `f75e849f` (Wave 7 4줄기 done — 배치 랜딩 진행 중, 착지 SHA 로 갱신 예정)
- 설치본: 4.60.0 (NEXT-SESSION 22:0x 관측)
- **이 문서가 v5.0 진행률의 정본이다.** 로드맵 항목의 status·evidence 는 여기서만 갱신한다. 갱신 규칙: 웨이브 착지(배치 랜딩 커밋)마다 리더가 해당 항목의 status·evidence(커밋 SHA 또는 file#symbol)를 갱신하고 헤더의 기준 SHA 를 올린다. `done` 은 evidence 가 있을 때만. 항목 추가는 설계 정본(`ARTIBOT-5.0-DESIGN.md` §4·§7.3·§8.4·부록 결정)에 근거가 있을 때만 — 정찰 후속은 §3 부채 트랙으로.
- 출처 우선순위: `ARTIBOT-5.0-DESIGN.md` §4 로드맵 > §7.3(§48 P0 14 사상) > §8.4(§55 P0 15 사상) > 부록 0-2 후속(1)(2)(3) 오너 결정 > `NEXT-SESSION.md` > `CHANGELOG.md`.
- 인용은 `file#symbol` 또는 `§번호`. 줄번호는 쓰지 않는다.

## §1 진행률 요약 (분모 = §2 항목 수, 2026-09-11 f75e849f 기준)

| 단계 | 항목 | done | in-progress | todo | 보류 | 기각 | 진행률(done/항목) |
|---|---|---|---|---|---|---|---|
| Phase 0 정본 착지 | 16 | 13 | 1 | 2 | 0 | 0 | 81% |
| Observe 기록만 | 27 | 17 | 6 | 4 | 0 | 0 | 63% |
| Shadow 비교 | 30 | 1 | 11 | 15 | 3 | 0 | 3% |
| Canary 저위험 자동 | 20 | 1 | 0 | 18 | 0 | 1 | 5% |
| GA | 7 | 1 | 0 | 6 | 0 | 0 | 14% |
| **합계** | **100** | **33** | **18** | **45** | **3** | **1** | **33%** |

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
| OB-06 | `independent-reviewer` verdict 파싱·기록 + clean-room `buildReviewRequest`(§48 #13) | §4 · §3.4 · MP-4 | in-progress | 파서 `lib/review/independent-reviewer.js#parseReviewVerdict`·`#parseClaimAudit`; **`review.completed`·`review.claim_audit` writer 0**(scripts grep 0, 4.56.0 Known) | `review-verdict-adapter` | Shadow 분모(파싱률) 생기려면 writer 필요 |
| OB-07 | `unified-verifier` UNMEASURED 카운트 | §4 · §3.4 · C4 | in-progress | `lib/verification/unified-verifier.js` 존재; `verify.completed` writer scripts 0 | — | 런타임 호출자 미확인 |
| OB-08 | usage receipt 파서 + writer(§55 #8) | §4 · §3.2 · D2 | done | 4.57.0 `scripts/hooks/session-end.js#recordUsageReceipts` · `lib/economics/usage-receipt.js#buildUsageReceipts`; 라이브 PASS(4.57.0·4.58.0 판정 2) | `usage-receipt-schema-guard` | cost.total null · pricing_version unresolved(I1); 커버리지 ≥95% 비율 미계산 |
| OB-09 | `/doctor` Check 8(+9·10 동승) | §4 · §3.6 | done | `lib/project-state/doctor-checks.js#checkLedgerStateParity`·`#checkStateVersionGaps`; W5-a `23ec79be`·`d1ded07f`(4.60.0) | Check 8 실행형 worktree 테스트(4.58.0 #G16) | 4.60.0 설치본 재판정 필요(§4) |
| OB-10 | Mission Controller 기록 전용(§48 #2) | §7.3 · F4 | todo | `lib/mission/` 6파일 중 controller 없음(Glob) | — | 전이 결정은 CA-14 |
| OB-11 | Execution Profile 8키 기록(§48 #4, F2) | §7.3 · G-1 | done | `lib/routing/execution-profile.js#PRIORITY_ALIASES`(4.55.0) · `schemas/execution-profile.schema.json` | `v5-config-firewall` | G-1b(economy 손실) 미결 |
| OB-12 | Task Graph 스키마 + store(§48 #6) | §7.3 | in-progress | `schemas/task-graph.schema.json` · `lib/project-state/lease.js` 존재 | — | claimTask/releaseTask 구현 미확인 |
| OB-13 | 5개념 분리 `lib/routing/` 5모듈(§48 #12) | §7.3 · §3.2 | done | `adaptive-model-router.js` · `model-switcher.js` · `escalation-controller.js` · `route-hysteresis.js` · `execution-profile.js`(+`action-classifier`·`route-scorer`) | `layer-registration-coverage` | `resolveModel` byte-identical 유지 |
| OB-14 | completion gate 카운트(§48 #14, C4) | §7.3 · 후속(1) C4 | done | `lib/runtime/artifact-lifecycle-gates.js#DEFAULT_POLICY`(unmeasuredBlocksOutcome) · config `review.verify` | — | 강제는 CA-13; config 키 소비처 0(config 주석 실측) |
| OB-15 | file ownership Task Graph 필드 기록(§48 #16) | §7.3 | todo | 미확인 | 강제는 기존 `lib/git/limb-landing-check.js` | |
| OB-16 | redaction 재사용(§25) | §7.3 | done | `lib/runtime/ledger-redaction.js`(memo · MAX_REDACT_NODES, 부록 T-20) | `ledger-append-survival` | |
| OB-17 | Switching Cost 추정치 기록(measured:false, §55 #4) | §8.4 | in-progress | `lib/routing/route-hysteresis.js` 존재 | — | `terms{}` 원장 기록 미확인 |
| OB-18 | Replay 읽기 모델(§55 #9) | §8.4 · §8.3 | done | `lib/replay/replay.js#loadReplay` · `route-bind.js`(Check 10) · `existence-audit.js`; dedupe 5필드(4.58.0) | `tests/replay/replay.test.js` | |
| OB-19 | Snapshot Scorecard `/save` 렌더(§55 #10) | §8.4 · §31 | in-progress | `lib/scorecard/{session-scorecard,routing-scorecard,render,metric}.js` · `commands/scorecard.md` 존재; `commands/save.md` 에 checkpoint/렌더 0건(grep) | `command-output-invariance` | `/save` 순서 확정은 CA-05 |
| OB-20 | 메모리 주입 계측만(현행 기본값 유지) | §8.4 · G2 | done | `decision-events.js` `memory-injection-measured` 어휘 · `tests/hooks/runtime-prompt-memory-instrumentation` | — | A/B 는 SH-22(보류) |
| OB-21 | Avoided Switch 계산 | §8.4 · §36 | todo | 미확인 | — | `routing-scorecard.js` 가 `model.switched` 만 참조 |
| OB-22 | `human.asked` 훅 writer + Write/Edit 대칭(§19 writer 비대칭) | §8.2 §19 · §3.4 OD-5 | done | 4.57.0 `lib/runtime/human-asked-record.js#recordHumanAsked`; 라이브 PASS(4.57.0·4.58.0 판정 1, HG-04) | `human-gate-matrix-selfcheck` · `hook-decision-invariance` | `human.resolved` writer 는 SH-27 |
| OB-23 | `HUMAN_GATE_MATRIX` HG-01…13 정의 + `pre-bash`/`pre-write` block 사유 | §3.5 · C2 | done | `lib/security/human-gates.js#HUMAN_GATE_MATRIX`; HG-07 `human`(부록) | `human-gate-matrix-selfcheck` · `project-md-contract` | HG-07/12/13 강제 확대·C3 는 CA-04 |
| OB-24 | Existence Audit 카운트(훅·커맨드·스킬 발화) | §4 종료조건 · §3.7 D18 | in-progress | `lib/replay/existence-audit.js`; 분모 부재 `unmeasured:no-event-carries-<kind>`(부록 T-44) | `existence-audit-section` | carrier 필드 결정은 SH-29 |
| OB-25 | `decision-trail.json` 동결(D9, TR-1~3) | §5 D9 · 후속(3) | done | 4.56.0 `lib/core/decision-trail.js` `enabled:false` + config `ago.decisionTrail.enabled=false` | `trail-sandbox-required` | |
| OB-26 | `split.recommendMinSubtasks` = 7(Observe 데이터용) | §5 D12 | todo | config 값 `null` 실측 | `split-config-firewall` | D12 권고 미이행 |
| OB-27 | D안 에이전트 2종(investigator·auditor) + allowlist 8→10 + `review.claim_audit` 어휘 | 후속(3) MP-1~5 | done | 4.56.0 `agents/investigator.md`·`auditor.md`; allowlist +1 | `agent-name-references` · `validate-model-policy` | `plugin.json#agents` 28 vs 30 누락은 §3 |

### Shadow · 비교 (30)

| ID | 항목 | 출처 | status | evidence | 게이트 | 비고 |
|---|---|---|---|---|---|---|
| SH-01 | `missions/<M>/intent.md` 생성 시작(§48 #3, v1.1 P0-4) | §4 · §3.1 · C9 | todo | `.artibot/missions/` 부재(Glob 0; 4.58.0 "진짜 미착지"); 자재 `lib/intent/artifact.js` · `schemas/intent-md.template.md` 존재 | `artifact-governance` | 선행: Observe substantive 분포(S4·S6 배선) |
| SH-02 | artifact-lifecycle 이벤트→intent/plan/review/outcome.md(§48 #10) | §7.3 · Hardening §6 | in-progress | `lib/runtime/artifact-lifecycle.js` 핸들러(plan.revised·review.completed·mission.completed) 존재; 실행 0(missions 0) | — | `plan.md ← plan.revised`(부록 T-40) |
| SH-03 | `command_activation` vs 실제 슬래시/힌트 수락 + nl-activation eval ≥90% 실사용 대조 | §4 · §3.1 | in-progress | `tests/evals/fixtures/nl-activation.cases.jsonl` + `nl-activation-fixture.test.js`(93/93) | `nl-activation-fixture` | 실사용 대조 0; A3 Act 시점은 원장 1릴리스 후 |
| SH-04 | `topology-actual` vs 추천 일치율(`/doctor`) | §4 · §3.5 | todo | lib grep `topology-actual` 0건 | — | |
| SH-05 | 라우터 추천 스폰의 영수증·평가점수 비교 | §4 · §3.2 | todo | 미확인(라이브 표본: 4.58.0 investigator recommended opus→selected fable 1건) | — | |
| SH-06 | recovery 분류 기록(기존 고정 전이와 달랐을 때) | §4 · §3.4 | in-progress | `lib/recovery/{failure-classifier,recovery-controller,plan-repair}.js` 존재 | — | engine 배선 미확인; 적용은 CA-03 |
| SH-07 | 가격 단일화 + 5.1 계수 실측(D1·I1, cache-roi 명시) | §4 · §3.2 · 부록 가격표 행 | todo | `usage.receipt` cost null · pricing_version unresolved(NEXT-SESSION 09-09 P2) | `usage-receipt-schema-guard` | `lib/runtime/middleware/cache-roi.js` 미참조 교차 테스트 0 |
| SH-08 | seeded-defect 코퍼스 N 확정 + catch-rate·FP·위치정확도(opus 비교군) | §4 · §3.4 · C6 | todo | 코퍼스 grep 0건(픽스처 언급만) | — | **오너 결정 C6 선행(N·목표)** |
| SH-09 | 헌법 단계 B(B-1 체크포인트 결정형만 · B-2 Rationalizations 강등 · B-3 GRPO 절, A4) | §4 · §3.7 | todo | 미확인 | — | 조건: Observe 원장 1릴리스 후 |
| SH-10 | HANDOFF/NEXT-SESSION 렌더 뷰 전환(`derived-from` 헤더) | §4 · §3.3 | todo | 미확인 | `artifact-governance` #6 | |
| SH-11 | split run → `state.yaml.workers` 어댑터 | §4 · §3.5 | in-progress | `lib/topology/split-state.js` · `split-state-sources.js` 존재(쓰기=run.json) | `split-telemetry-callsites` | StateStore 착지 시 뒤집기 대기 |
| SH-12 | lease/heartbeat(§48 #15) | §7.3 · Hardening §9 | in-progress | `lib/project-state/lease.js` · `schemas/lease.schema.json`; heartbeat emitter 0(vnext ADDENDUM) | — | reclaim 은 CA-09 |
| SH-13 | resume/reconcile(§48 #17-18, vNext DR02) | §7.3 · Hardening §13 | in-progress | `lib/project-state/reconcile.js` 존재; `/resume` Resume Contract 미배선 | — | DR02 입력(lane-state 라이브) 비어 있음 |
| SH-14 | idempotency 런타임 원칙(§48 #19) | §7.3 · Hardening §11 | in-progress | `session-end.js#recordUsageReceipts` idempotency key · `lib/supervisor/run-store.js#appendEvent` actionId | — | 전 writer 일반화 미확인 |
| SH-15 | evidence registry `.artibot/runtime/evidence.jsonl`(§48 #20) | §7.3 · Hardening §23 | todo | 미확인 | — | 부록 유보(v1.1 runtime/ 허용 범위) 미해소 |
| SH-16 | Context Receipt writer(`context.compiled`, §55 #7 · §48 #21) + vNext CX02 | §8.4 · §8.2 §8 | in-progress | 어휘·스키마 존재; writer `lib/context/rehydration.js` PostCompact — config `split.contextLifecycle.enabled=false`, 라이브 0회 | — | CX02 context-pressure emitter 0 |
| SH-17 | Artifact Health `/doctor` Check 9(§48 #24) | §7.3 | done | `doctor-checks.js#checkArtifactHealth` · `commands/doctor.md` Check 9; 라이브 실행(unmeasured, missions 0) | — | Shadow 사상이나 이미 착지 |
| SH-18 | ADR question gate 4조건 기록(§48 #27) | §7.3 | in-progress | `lib/planning/question-gate.js` 존재; `adr.*` 이벤트 0(부록 T-40) | — | 강제는 CA-15 |
| SH-19 | delegation depth 기록(§36) | §7.3 | todo | 미확인 | — | |
| SH-20 | Final Scorecard(outcome.md 트리거, §55 #11) | §8.4 | todo | 미확인 | — | SH-02 선행 |
| SH-21 | Checkpoint/Resume DR01·DR02 `lib/checkpoint/` + 불변성 테스트(§55 #12·#13) | §8.4 · §8.2 §21~26 · vnext ADDENDUM §6 | todo | `lib/checkpoint/` 부재(Glob 0) · `tests/firewall/checkpoint-immutability.test.js` 부재 | (신설 예정) | 순서 DR01→CX02→DR02; 재개 정본 = 트레일러 증거·checkpoint 는 주입 번들(§3.5 확정) |
| SH-22 | 메모리 주입 A/B(`ARTIBOT_RUNTIME_MEMORY_DISABLE`) | §8.4 · G2 | 보류 | 후속(1) G2: 계측만 유지, 표본 n>1 축적 후 | — | 임계 미확인 |
| SH-23 | Mission Reflection(미션 경계 reflect) | §8.4 · §8.2 §16 | todo | 미확인 | — | G2 후 |
| SH-24 | Generated Knowledge `.artibot/generated/` | §8.4 · G3 | 보류 | 후속(1) G3: 도입 보류(소비처 0) | — | 소비처 ≥1 시 재검토 |
| SH-25 | RouteBench + 기준선 B0~B4 | §8.4 · §8.2 §11 · G4 | in-progress | `tests/evals/fixtures/routebench/scenarios.{example.jsonl,schema.json}`(예시만) | — | 러너 0; `_benchmarks/routing/` 미확인; B2 = `resolveModel` 2티어 |
| SH-26 | Replay EXACT/PARTIAL/SIMULATED 라벨 | §8.4 · §8.2 §13 | todo | 미확인 | — | |
| SH-27 | Human kind 3분리 `human.resolved{kind}` writer | §8.4 · §8.2 §19 | in-progress | 어휘 allowlist 존재; writer scripts 0(#G22) | `ledger-vocab-allowlist` | 모델이 AskUserQuestion 직후 기록 |
| SH-28 | residency/cooldown 보정 | §8.4 · G5 | 보류 | 후속(1) G4·G5: `UNCALIBRATED` 유지 | — | 보정 자격 측정 미확인 |
| SH-29 | Existence Audit carrier 필드 결정(`tool.used.data.skill` 등) | 부록 T-44 | todo | 미확인 | — | OB-24 의 분모 |
| SH-30 | decisions 사이드채널 sources 규칙 통일(hook 발행자 이벤트) | 부록 T-51 2차 C | todo | 미확인 | — | |

### Canary · 저위험만 자동 (20)

| ID | 항목 | 출처 | status | evidence | 게이트 | 비고 |
|---|---|---|---|---|---|---|
| CA-01 | 저위험 커맨드 자동 활성(A2 allowlist 5종 + autopilot 게이트 히트 0∧allowlist) | §4 · A2·A3 | todo | — | — | A3: Shadow 원장 1릴리스 후 |
| CA-02 | `classify·status` 만 haiku/sonnet 실적용(`routing.canary.actionClasses`) | §4 · §3.2 OD-2 · D5 | todo | config `routing.canary.actionClasses: []` 실측 | `v5-config-firewall` | I4·I7 선행 |
| CA-03 | autopilot `nextPhase` = verdict 함수 | §4 · §3.4 | todo | — | — | SH-06 선행 |
| CA-04 | `HUMAN_GATE_MATRIX` 훅 강제 확대(HG-07/12/13) + `.claude/` 축소(C3) | §4 · §3.5 · C3 | todo | 4.57.0 Known "HG-07/12/13 강제는 Canary 미착수" | `human-gate-matrix-selfcheck` | |
| CA-05 | `/save`=checkpoint 순서(§31) · `/resume`=ARTIBOT 읽기 순서 | §4 · §3.3 · §8.2 §31 | todo | `commands/save.md` checkpoint 0건 | `command-output-invariance` | SH-21 선행 |
| CA-06 | 헌법 단계 C-1(ROUTING advisory-only 단계 표기) | §4 · §3.7 | todo | — | — | |
| CA-07 | (D04) bounded blindspot 자동수정 | §4 · A1 | 기각 | 후속(1) A1: 자동수정 금지, dry-run 제안까지만 | — | |
| CA-08 | staleness 자동 차단(§48 #8) | §7.3 | todo | — | — | P0-14 규칙 위 |
| CA-09 | lease reclaim(§48 #15) | §7.3 | todo | — | — | |
| CA-10 | delegation cap 차단(§36) | §7.3 | todo | — | — | |
| CA-11 | split 통합(§48 #22) | §7.3 | todo | — | — | |
| CA-12 | fast objective 실적용(§48 #23) | §7.3 · §3.2 | todo | — | — | G6 `wallclock_throughput` UNATTESTED 유지 |
| CA-13 | 완료 게이트 강제 = outcome.md 생성기(§48 #14 · §55 #15) | §7.3 · §8.4 · §3.4 | todo | — | — | SH-02·SH-20 선행 |
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
| GA-01 | 저위험 외로 확대 | §4 | todo | — | — | |
| GA-02 | 4티어 전면 | §4 · §3.2 | todo | — | — | |
| GA-03 | split 자동 진입(WP02 선행) | §4 · §3.5 | todo | — | — | 창을 사람이 여는 한 불가 |
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
| guard-command-position(`echo "X"` 언급 발화, L1 34/34·L2 17/17) + human-gates.js:179/:181 4.9s | todo | Wave 8 브리프 `guard-command-position/brief.md` + `leader-addendum.md` | Canary |
| release.yml 산문 동기화 순서 + SYNC_PATHS 9경로 | done | `c298a7f0`(4.60.0); 라이브 실증 v4.60.0 배지 `f75e849f` | (릴리스 절차) |
| 원장 위치 ADR-011 이관 실행(`ledger.jsonl`·`spawns.ndjson` 리더 수동 1회) + `.pre-adr011` 삭제(v4.61.0) | in-progress | `scripts/ledger/migrate-ledger-adr011.mjs`(선존재 exit 3); 설치본이 `.git/artibot/ledger.jsonl` 67KB 기록 중 | Observe 종료 판정(Check 8 분모) |
| `spawns.ndjson` 공유 스토어 이관(spawn-ledger-store) | in-progress | Wave 7 done `1f32cab2`(배치 랜딩 중), 드라이런 Σ443 일치 | Observe(Check 10 비대칭) |
| Check 8 프로젝트명 fold(W5-a) | done | `23ec79be`·`d1ded07f`(4.60.0) `doctor-checks.js#checkLedgerStateParity` | Observe 종료 판정 |
| ledger reader dedupe pid 충돌(ts 키) | done | 4.58.0 `lib/runtime/ledger.js#dedupeKey`·`replay.js` | Observe |
| UPS 발신자 가드(task-notification · cross-session · agent 봉투) | done | 4.57.0 + 4.58.0 `_userprompt-dispatcher.js`; 라이브 PASS 4.58.0 판정 5 | Observe(routing-classified 분모) |
| install 이중 적재 · rules 전달(ADR-002) | done | 4.58.0 `install.sh`/`install.ps1` | — |
| frontmatter 중복키·블록 스칼라·빈 description 게이트 | in-progress | `62d4d608`(4.60.0) done; W7 `frontmatter-hardening` `4f432d24` done(배치 랜딩 중) | — |
| `plugin.json#agents` 28 vs `agents/*.md` 30(auditor·investigator 누락) | todo | Wave 8 후보 `frontmatter-followups`(실결함, 신규 설치 스폰 실패 추론) | Observe(MP-3 에이전트 실효) |
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
| ② 추천≠정책 스폰 비율 | 미판정 | `route.selected`/`route.bound` 라이브 PASS(4.58.0 5/6 bound)이나 비율 집계 없음; 관측 1건(investigator opus→fable) | Avoided Switch(OB-21) 착지 후 |
| ③ verdict 파싱률 · 층별 UNMEASURED 비율 | 미판정(분모 0) | `review.completed`·`verify.completed` writer 0 | OB-06·OB-07 writer 착지 후 |
| ④ 영수증 커버리지 ≥95% | 미판정 | `usage.receipt` 라이브 PASS(source=hook)이나 커버리지 비율·parseFailures 집계 없음; cost null | 집계 + I1 가격 |
| ⑤ 훅·커맨드·스킬 발화 카운트(Existence Audit) | FAIL(구조적) | 분모 부재 `unmeasured:no-event-carries-<kind>`(부록 T-44); 4훅은 디스크 산출물 0(4.55.0 「구조적 한계」) | SH-29 carrier 필드 결정 후 |

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
