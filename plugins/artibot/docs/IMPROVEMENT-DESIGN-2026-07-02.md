# Artibot 종합 감사 & 개선 설계 (2026-07-02)

- 세션: `ap-20260702-014333-740tk3` (autopilot, 6 병렬 감사팀)
- 대상: `plugins/artibot/` post-v4.29.0 master
- PRD: `docs/PRD/…-ap-20260702-014333-740tk3.md` (루트, 세션 산출물)
- 세션 리포트: `reports/AUTOPILOT/ap-20260702-014333-740tk3.md`
- 성격: **READ-ONLY 감사** — 본 문서 작성 외 소스 0줄 수정 (git status 검증 완료)

---

## 1. 종합 점수 — **7.8 / 10**

6축 가중 루브릭 (가중치 합 100%), 축별 점수는 담당 감사 에이전트가 file:line 증거 기반으로 제안:

| 평가 축 | 가중치 | 점수 | 담당 | 핵심 근거 |
|---------|--------|------|------|-----------|
| 아키텍처 견고성 | 20% | **8.5** | T1 | 계층 5→1 단방향 위반 0건, dispatch-table drift 0, exit0 규율 6/6 준수. 감점: in-process 훅 타임아웃 비대칭(P-05 Med) |
| 자가학습 성숙도 | 20% | **7.0** | T2 | 캡처·관측·dream 폐루프 완결 + 가드 전부 실배선. 감점: F-06 review-queue **end-to-end dormant**(L-01 HIGH) + redact URL 자격증명 갭(L-03) |
| 기능 폭·깊이 | 15% | **8.5** | T4 | 73 커맨드 엔진 참조 깨진 것 0건, 모델정책 CI 게이트 정합. 감점: auto-invoke 스킬 46%의 description 품질 미게이트(F-03) |
| 품질 엔지니어링 | 15% | **8.5** | 리더 종합 | 10,600+ tests / 4지표 커버리지 CI 게이트(85/76/85/85) / lint 0 / 검증기 스크립트 8종. 감점: 검증기 커버리지 갭(D-08, F-01)·branch 커버리지 여유 얇음·과거 tag-time 검증 실패 이력 |
| 문서·DX | 15% | **7.0** | T3 | 카운트 클레임 100% 정합 + 327문서 링크 0 broken. 감점: 스코프 밖 drift 3건(버전/벤치점수/PRD) + PRD 라이프사이클 부재(D-05) |
| 오케스트레이션 UX | 15% | **7.5** | T5 | goal-loop 다층 가드 실재, auto-fire 문서·코드 정합, "workflow" 다의어 문서 분리 우수. 감점: classifyRisk 미배선+허위 약속(W-01 HIGH), 트리거 평가기 불일치(W-04) |

**가중 합산: 8.5×.2 + 7.0×.2 + (8.5+8.5+7.0+7.5)×.15 = 7.825 ≈ 7.8/10**

> 자기평가 편향 방어: 루브릭은 PRD에 사전 고정, 축별 점수는 독립 에이전트 산출, HIGH 발견 2건은 리더가 grep 재검증(CONFIRMED), null-result(문제 없음 판정) 12건 허용.

## 2. 생태계 상대 위치 (T6, 2026-07 공개 명세 기준)

| 축 | vs SuperClaude / wshobson/agents / 공식 plugins | 판정 |
|---|---|---|
| 기능 폭 | 28ag/72cmd/114sk + MCP + 마케팅 수직선 (wshobson 194ag는 정적 카탈로그라 성격 상이) | 동등 |
| 자가학습/메모리 | RLVR + 계층 메모리 + ambient ledger — 비교군 전무 | **우위** |
| 오케스트레이션 | 네이티브 Agent Teams + 5패턴 + S1/S2 라우팅 | **우위** |
| 품질 엔지니어링 | 10,600+ tests vs 비교군 코드 테스트 사실상 없음 | **우위** |
| 문서/DX | 깊이 최상 vs 학습곡선 가파름 (상쇄) | 동등 |
| 설치/업데이트 | git clone+bash vs 네이티브 `/plugin install @marketplace` | **열위** |

**요약**: 능력 깊이(자가학습+오케스트레이션+품질 3축 동시 보유) 기준 조사 대상 중 **상위 ~5% 추정** — 이 조합을 가진 사례를 비교군에서 발견하지 못함. 단 채택·가시성(star, 마켓플레이스 등재)은 하위권이며, 유일한 구조적 열위는 **배포·설치 접근성**. ※ 내부 메모리 "CC에 플러그인 마켓플레이스 없음"(2026-02-23)은 outdated로 판명 — 네이티브 마켓플레이스가 현존.

## 3. 개선 설계 — 우선순위 통합 목록 (20항목: 부채 16 + 신기능 4)

### P0 — 즉시 (신뢰성·프라이버시 직결)

**[IMP-01] autopilot classifyRisk 실배선 + 허위 약속 제거** `부채`
- 축: 워크플로우 / 문제: 위험 분류기가 정의만 존재, 호출부 0건 (`lib/autopilot/safety.js:67`, export `index.js:59`). 생성 PRD가 "safety.classifyRisk 자동 차단"을 허위 명시 (`lib/autopilot/prd-generator.js:185`). approve-all 환경에서 force-push/rm -rf 무검증 실행 가능.
- 제안: Bash PreToolUse 가드 훅 신설 → classifyRisk(danger→block, caution→warn). 병행: shouldPause danger-error 死분기(safety.js:141)에 severity:'danger' 신호원 연결(W-02 동시 해소). 배선 전까지 최소 prd-generator 문구 즉시 수정.
- 영향×노력: High×Med / 위험: PreToolUse 추가는 훅 latency 예산 확인 필요, false-positive 시 개발 흐름 방해 → caution은 warn-only로 시작.

**[IMP-02] F-06 review-queue 거취 결정 — 배선 또는 공식 dormant** `부채`
- 축: 자가학습 / 문제: 간판 기능 "학습신호 환류 검토 게이트"가 라이브러리+테스트만 존재, 생산자/게이트 소비자 호출부 0건 (`lib/learning/ledger/review-queue.js:92,120,130,154`; egress 브리지 `learning-bridge.js:52`도 dormant).
- 제안: (택1) ① `/learning review` 서브커맨드로 enqueueFromCorpus+listPending+approve/reject 표면 배선 + SessionEnd 훅 자동 enqueue. ② dream 경로가 동일 목적을 이미 달성하므로 "Intentionally Dormant" 공식 문서화(WIRE-01/02/19 선례) 후 차기 스프린트에 제거 검토.
- 영향×노력: High×Med(①) 또는 Med×Low(②) / 위험: ①은 리뷰 UX 부담 증가, ②는 F-06 릴리즈 서사와 충돌 — CHANGELOG 정정 필요.
- **✅ 해소 (2026-07-03 — 옵션 ① 채택)**: `/learning review` 서브커맨드로 `enqueueFromCorpus`+`listPending`+`renderReviewReport`+`approve`/`reject` 실배선. 신규 `scripts/ledger-review.js`(mutating CLI, read-only `learning-diag.js`와 분리) + `commands/learning.md` 라우팅 + `/learning` 대시보드 pending>0 시 `/learning review` 유도 nudge. **SessionEnd 자동 enqueue는 범위에서 제외**(pull-model — 휴먼 게이트 원칙 유지). review-queue API 런타임 소비자 0→1건, L-01 dormant 해소. 테스트 `tests/scripts/ledger-review.test.js` 신규.

**[IMP-03] redact 스코프에 URL 임베드 자격증명 편입** `부채·프라이버시`
- 축: 자가학습 / 문제: ledger redact 스코프 4개(`lib/learning/ledger/redact.js:28`)에 `url_with_credentials`(category network, `lib/privacy/pii-detector.js:360`)가 빠져 `https://user:pass@host` 원문이 ledger에 저장.
- 제안: redact 스코프에 network 카테고리 중 자격증명 패턴 선별 편입, 회귀 테스트 추가. base64 80~85자 경계값(P2 IMP-16)과 별도 처리.
- 영향×노력: Med×Low / 위험: 낮음 (마스킹 확대는 안전측).

### P1 — 다음 스프린트

**[IMP-04] validate-skills.js description 품질 게이트** `부채`
- 축: 기능 / 문제: 스킬 52/114(46%)가 순수 auto-invoke인데 유일한 발견 경로인 description 품질을 CI가 미강제 (`scripts/ci/validate-skills.js:12` — 존재만 검사). 모범 규격(feedback/polish 스킬)은 존재하나 저자 규율 의존.
- 제안: 트리거 절("Triggers:"/"Use when"/한글) + whenNotToUse + 최소 길이 검증 추가. 기존 114개 일괄 스캔 → 미달 목록 백로그화.
- 영향×노력: High×Med / 위험: 기존 스킬 대량 실패 시 게이트를 warn→error 2단계 도입.

**[IMP-05] auto-team-trigger minComplexity 실제 비교** `부채`
- 축: 워크플로우 / 문제: 훅이 키워드 이진 판정으로 medium에서 발화 (`scripts/hooks/auto-team-trigger.js:162`) vs config·정본은 high만 허용 (`lib/cognitive/workflow-plan.js:128`). 주석 "never disagree" 보증 미이행.
- 제안: 훅에 TIER_ORDER 비교 이식 + 두 평가기 패리티 회귀 테스트.
- 영향×노력: Med×Low.

**[IMP-06] readme-claims-registry 커버리지 확장** `부채`
- 축: 문서 / 문제: CLAIM_PATTERNS 5종(카운트만) — 버전 문자열(README.md:198 "4.8.0" stale), opus/sonnet 비율(README.md:52 "73%/27%" vs 실측 75%/25%), persona 세부(README.md:53 "11개" vs 실측 12, 존재하지 않는 스킬명 2개) 미검증 (`scripts/ci/readme-claims-registry.js`).
- 제안: 버전(3 manifest 대조)·비율·persona 세부 카운트 패턴 추가 → sync-readme-claims 자동수복 편입. README 프로즈 3건은 즉시 손수정.
- 영향×노력: Med×Low.

**[IMP-07] PRD 라이프사이클 상태머신** `부채`
- 축: 문서 / 문제: PRD 5개 전부 Draft/Approved 고정, Shipped/Archived 전환 0건 (D-05). 실증: PRD-EFFORT-DYNAMIC-WORKFLOW.md가 Approved인데 기반 GRPO 서브시스템은 삭제됨(D-03, `artibot.config.json:936` 코멘트만 기록) + PRD-LEARNING-ACTIVATION.md:81 dangling 참조(D-04).
- 제안: frontmatter Status 상태머신(Draft→Approved→Shipped→Archived/Superseded) + CI "Approved 90일+ 경과" 경고. GRPO 폐기 각주 2건은 즉시 추가(Low×Low).
- 영향×노력: Med×Med.

**[IMP-08] 네이티브 마켓플레이스 등재 + 원라인 설치** `신기능` `[검증 필요]`
- 축: 배포/DX / 문제: 생태계 유일 열위 축. 비교군은 `/plugin install …@marketplace` 원라인, Artibot은 git clone+bash 수동 (README.md:24-26).
- 제안: ① anthropics/claude-plugins-official external_plugins 제출 요건 조사 ② 자체 marketplace.json 등록 ③ npx 래퍼(install.sh↔ps1 패리티 매트릭스 재사용) 3안 비교 스파이크 1개.
- 영향×노력: High×Med / 위험: 마켓플레이스 심사 기준(보안/품질) 사전 확인 필요. 내부 메모리 outdated 정정 선행.

**[IMP-09] UserPromptSubmit in-process 타임아웃 격리** `부채`
- 축: 파이프라인 / 문제: rewriter+5 병렬 기여자가 per-hook 타임아웃 없이 외곽 15s에만 의존 (`scripts/hooks/_userprompt-dispatcher.js:207,215-224`) — 자식-프로세스 디스패처(개별 타임아웃+SIGTERM)와 비대칭.
- 제안: Promise.race 타임아웃 래핑(특히 순차-우선 rewriter), 또는 rewriter 자식-프로세스 이관.
- 영향×노력: Med×Med.

### P2 — 백로그

| ID | 항목 | 축 | 태그 | 영향×노력 | 근거 |
|----|------|-----|------|-----------|------|
| IMP-10 | shouldPause danger 死분기 정리 (IMP-01에 흡수 가능) | 워크플로우 | 부채 | Med×Low | safety.js:141 vs engine-state.js:103-124 |
| IMP-11 | config excludeTrivial 실소비 or 제거 | 워크플로우 | 부채 | Low×Low | artibot.config.json:146-149 죽은 설정, 훅은 자체 30자 하드코딩 |
| ↳ IMP-11 해소 | **제거로 종결 (2026-08-22)** | 워크플로우 | 해소 | — | `team.autoApplyTriggers.excludeTrivial` 블록을 `artibot.config.json` 에서 삭제. 판정 근거: 리포 전역 JS 소비자 0(독립 2인 수렴 실측), `maxLines`/`singleFile` 은 diff 를 전제한 어휘라 프롬프트 문자열에 대응 의미가 없음. 훅의 30자·≤1도메인·≤1서브태스크 하드코딩(`scripts/hooks/auto-team-trigger.js#evaluatePrompt`)이 정본이며 그 사실을 같은 함수 JSDoc 에 명시 |
| IMP-12 | runParallel 중복 키 dev-모드 경고 | 파이프라인 | 부채 | Low×Med | create-artibot-agent.js:82-105 컨벤션 의존 불변식 |
| IMP-13 | defaultPipeline 주석 정정 (phase2 병렬 서술) | 파이프라인 | 부채 | Low×Low | create-artibot-agent.js:245 vs :342-347 |
| IMP-14 | 벤치마크 표 타임스탬프 명시 or 단일 정본화 | 문서 | 부채 | Med×Med | README.md:59 v4.13.0 스냅샷 vs MEMORY 9.63/10 이원화 |
| IMP-15 | MEMORY.md 정정 2건 (마켓플레이스 outdated + 미추적 아티팩트 해소됨) | 문서 | 부채 | Low×Low | D-09: TRACK-B/workflow-*.json tracked, RELEASE_NOTES_4.8_KO 부재 |
| IMP-16 | base64 80~85자 경계값 마스킹 | 자가학습 | 부채 | Low×Low | pii-detector.js:488 identifiers 카테고리 제외 |
| IMP-17 | azure_key 정규식 앵커 (false-positive 축소) | 자가학습 | 부채 | Low×Low | pii-detector.js:154 — 안전측 오류라 후순위 |
| IMP-18 | 행동 모드 명시 토글 (브레인스토밍 모드) | 기능 | 신기능 `[검증 필요]` | Med×Med | SuperClaude 5 modes 대비 — 기존 output-style과 중복 여부 선확인 |
| IMP-19 | 멀티하네스 단일 카탈로그 자동 발행 | 기능 | 신기능 `[검증 필요]` | Med×High | wshobson 6하네스 — /export 어댑터 5개 보유, 자동화 수준 실사 |
| IMP-20 | 커뮤니티 기여 큐레이션 파이프라인 | 기능 | 신기능 `[검증 필요]` | High×High | 깊이 vs 폭 전략 전환 — 별도 의사결정(ADR) 필요 |

### WIRE 백로그와의 관계
- 기존 `.artibot/WIRE-BACKLOG-TRIAGE.md` 22항목과 중복 없음 확인 — 본 목록의 dormant 계열(IMP-02/10/11)은 WIRE의 "Intentionally Dormant 공식 문서화" 원칙을 그대로 따른다 (dormant ≠ 결함, 결정 명문화가 핵심).
- IMP-02 선택지 ②를 채택하면 WIRE-01/02/19와 함께 "Intentionally Dormant" 섹션에 일괄 기록 권장.

## 4. null-result (정직성 원칙 — 문제 없음 확정 항목)

- 계층 5→1 단방향 import 위반 0건 (T1 P-01)
- 훅 timeout 예산·dispatch-table drift·exit0 규율 전부 정상 (T1 P-02~P-04)
- 카운트 클레임(114/73/28) 100% 정합, 327문서 링크 0 broken (T3 D-06/D-07)
- alias 표면(recap/ultrareview 등)은 방치가 아닌 문서화된 의도 (T4 F-04)
- 73 커맨드 엔진 참조 깨진 것 0건 (T4 F-05)
- 자가통제 가드(kill-switch/rollback/first-run/risk-classifier) 전부 실배선 (T2 L-05)
- ledger 외부 egress 경로 사실상 부재 + swarm-client 거부 가드 라이브 (T2 S-03)
- MEMORY.md의 "미추적 아티팩트" 이슈는 이미 해소된 상태 (T3 D-09)

## 5. 다음 액션 제안

1. **P0 3건을 단일 스프린트로**: IMP-01(+10 흡수) → IMP-02 결정 → IMP-03. 예상 규모: 신규 훅 1 + 커맨드/문서 수정 + 회귀 테스트 ~30개.
2. IMP-06/07의 즉효 하위작업(README 프로즈 3건, GRPO 각주 2건, MEMORY 정정 2건)은 30분짜리 묶음 커밋으로 선처리 가능.
3. IMP-08은 스파이크(조사만) 먼저 — 마켓플레이스 등재는 배포 전략 전환이라 ADR 작성 권장.
4. 6개월 후(2027-01) 동일 루브릭 재감사 — 본 문서가 기준선.

---
*생성: Autopilot ap-20260702-014333-740tk3 / 감사팀: T1 architect · T2 llm-architect · T3 doc-updater · T4 code-reviewer · T5 general · T6 repo-benchmarker / 리더 cross-check: HIGH 2건 grep 재검증 CONFIRMED*
