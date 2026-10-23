# 01. ARTIBOT 개선 구현 설계

**근거 기준:** Yoodaddy0311/artibot master@6149446eb5fc88d0537f07cb04010ba5ce4aa2a1 / v4.71.11 (2026-10-23에 재확인).
**구분:** [코드 확인] 직접 확인한 소스 관계 · [재현 필요] 통합 실행 전 추론 · [실험 대상] 효용 미측정 후보.
**상태:** 기능 구현 지시서, 적용 전 설계. 실제 성능 개선 수치 없음.

## 1. AS-IS → TO-BE

현재 중요 경로:

1. UserPromptSubmit → _userprompt-dispatcher.js → 문장 분류/힌트/컨텍스트 주입(호스트 응답 경로) → 모델의 *선택적* 이행.
2. 도구 실행 → _posttooluse-dispatcher.js → tool-tracker.js 등 자식 프로세스 → 일부 영속 기록 → 학습/관측.
3. SessionEnd → session-end.js / evolution-loop.js → 기록된 입력으로 압축·학습·분류; 사용자 가치나 다음 세션 행동 변화는 별도로 입증해야 함.
4. VERIFY → REPORT에서 attempt journal과 검증 결과를 보는 게이트; 현재는 'done' ACK만 있고 명시 FAIL이 없으면 결과 부재가 통과할 가능성이 있음.
5. /team, /split 등은 서로 다른 실행 표면. /split은 외부 창과 worktree, 사람의 창 열기, Git trailer 및 리더 통합을 사용함.

목표 경로(단순화):

사용자 의도 → **한 명의 실행 책임자** → 작업 난이도/독립성 판정 → native solo / native subagent / native team / /split 중 필요한 최소 경로 → 도구 호출의 원시 receipt 선기록 → 선택적 분류·학습 → 독립 검증 증거 → 현재 변경 SHA에 매인 완료 판정 → 선택적 기억 저장 → 다음 세션에서 실제 재사용/효과 확인.

원칙: native 기능 재구현을 기본값으로 하지 않는다. 관측 훅은 실행 중인 도구를 이미 되돌릴 수 없으며, 권한/차단은 해당 호스트의 실제 PreToolUse 계약으로만 증명한다. 임의의 'budget' 텍스트는 API 강제 제한이 아니다.

## 2. P0 세부 설계 — 기능 효과보다 먼저 실제 단절 수리

### IMP-01: 반복 호출 이력 영속화 [코드 확인, 통합 재현 필요]

- 원천: plugins/artibot/scripts/hooks/tool-tracker.js; lib/cognitive/loop-detector.js; scripts/hooks/_posttooluse-dispatcher.js.
- 문제: PostToolUse는 호출마다 자식 프로세스를 띄우지만 loopCallCounter는 프로세스 지역 변수이며 10번째/이미 탐지한 시점에만 이력을 저장. 첫 회 이력이 없는 상태에서 다수 호출 사이에 이력이 누적되지 않을 수 있다.
- 개선: LoopReceiptStore 인터페이스를 만들어 매 이벤트에 (project_id, session_id, tool_call_id, fingerprint, result, timestamp)을 원자적/멱등 기록. tool_call_id 중복 제거, TTL, 동시 접근 잠금/CAS, 실행 세션 격리, 비정상 입력의 UNMEASURED 기록.
- 수용: **실제 별도 Node 자식 프로세스 3회 동일 호출에서 경고 임계 확인, 5회에서 차단 *판정* 확인**; 8개 프로세스 동시 기록에서 loss 0; 서로 다른 세션 0건 오염.
- 기계적 시뮬레이터 PASS는 host 통합 PASS를 대체하지 못한다.
- 적용: observe-only 우선. 기존 이력 파일 일괄 삭제 금지.

### IMP-02: 루프 감지와 실제 도구 차단 분리 [코드 확인]

- 현재 tool-tracker의 'LOOP BLOCKED' stderr 문구는 호스트가 다음 도구를 실제 거부했다는 증거가 아니다.
- PostToolUse는 분류/receipt/관측만. 이후의 **PreToolUse**에서 명시적으로 지원하는 구조화된 deny 계약으로 미래 호출을 차단. 공식 호스트 출력 스키마·호스트 버전 확인 후 전환.
- 정상 테스트 재실행, polling, tail, 필요한 반복 읽기는 보호해야 한다. 단순 동일 문자열 5회만으로 자동 차단하지 않는다.
- 단계: shadow 정확도/오탐 수집 → 사용자 승인된 작은 canary → host tool execution의 denied 이벤트 확인.
- rollback: enforce OFF, observe ON, 필수 보안 가드 원상 유지.

### IMP-03: Bash 분류 실패도 원시 이벤트 보존 [코드 확인]

- 원천: scripts/hooks/tool-tracker.js의 buildContext(toolName, input) 결과가 null일 때 조기 반환하는 경로.
- 문제: 'npm test'와 'cd repo && npm test', 'CI=1 npm test'처럼 실행 내용은 비슷하나 분류 조건을 벗어난 호출이 학습·루프·성공/실패 통계에서 빠질 수 있다.
- 개선: **raw execution receipt를 buildContext 이전**에 최소 필드로 기록하고 분류 결과를 별도 선택값으로 저장; 모르면 category='unknown'으로 유지한다. 민감 인자는 저장 전 redaction; raw라 해도 비밀/토큰/명령 본문을 무제한 저장하지 않는다.
- 수용: 성공/실패 각 3종 문형 6경로에서 receipt 존재; classified/unclassified 합계=수집 성공 건수; 저장 장애는 0으로 조작하지 않고 UNMEASURED.
- 주의: Bash 문자열 임의 실행하거나 정규식만 늘려 '분류율' 숫자를 높이는 작업이 목표가 아니다.

### IMP-04: 실제 검증 증거 없는 REPORT 통과 방지 [코드 확인]

- 원천: lib/autopilot/report-verify-gate.js. 현재 룰은 latest VERIFY started/acknowledged, reason='done', latest EXECUTE 이후인지와 명시 FAIL 여부를 점검하지만, verifyResult가 비었거나 임의 객체인 경우도 PASS 취급할 수 있다.
- 제안 VerifyEvidenceV1: {task_id, attempt_id, target_git_sha, command_or_check_id, started_at, ended_at, exit_code, status, artifact_digest, collector_source}.
- 검증 인정은 현재 변경 SHA와 attempt에 연결된 **독립 수집된 테스트/검사 증거**가 있을 때만. 기록 없음 → UNMEASURED(성공 아님); FAIL은 거부.
- 배포: 모니터링 shadow로 신규 증거 수집 → 실제 업무별 검사 유형 정의 → canary → 필요한 업무에 strict gate. 기존 저장 세션 마이그레이션·수동 수행 업무 예외는 명시적 승인 필요.
- 수용: ACK done + verifyResult null / '완료' 산문 / 지난 SHA / FAIL / 미실행 검사에서 verified PASS=0. 유효 fresh evidence는 PASS. 실패했다고 모델의 최종 답변까지 신뢰할 수 있다는 의미는 아니므로 독립 외부 평가로 교차 검수.

### IMP-05: 설정 읽기 실패와 명시적 OFF 구분 [코드 확인]

- 원천: report-verify-gate.js#loadReportVerifyGateConfig. 구성 파일이 깨지면 false로 반환하며 '사용자가 명시적으로 꺼둠'과 '읽기 실패'가 구분되지 않는다.
- 개선: (valid_on, explicitly_off, config_invalid)의 명시 상태와 관측 이벤트로 분리. 안전 필수 검사에서 파손을 조용한 PASS로 처리하지 않는다. 보조 제안/측정은 fail-open이어도 위험과 사용자 제어를 손상시키지 않아야 한다.
- 수용: 잘못된 JSON/누락/권한 문제에 경고 및 유지 가능한 최후 유효 정책 처리. '설정 실패=검증 완료' 금지. 정책 적용 범위는 보고 검증 게이트에 한정하고 전체 보안 가드가 동일하다고 혼동하지 않는다.

### IMP-06: 추정 토큰·힌트와 실제 청구/usage 분리 [코드 확인]

- lib/runtime/middleware/token-usage.js와 runtime-prompt.js의 예상 토큰/effort 예산은 진단·권고 필드로만 둔다. 입력/출력/캐시 read/create/자식 세션/실제 모델을 호스트 OTel·종료 usage에서 수집한다.
- 데이터에는 source, measurement_status, attribution, run_id, model_id를 기록. 누락 → null/NOT_MEASURED, 절대 0 또는 절감액으로 대체하지 않는다.
- 요청의 'max_tokens' 힌트는 호스트 강제 제한이 아닌 것이 기본; 실제 강제 예산은 호스트가 지원하는 옵션/과금 데이터로 검증.
- 성공당 비용에는 실패·리트라이·추가 리뷰 비용 모두 포함. API billed / subscription usage / API-equivalent cost는 서로 다른 컬럼으로 집계한다.

### IMP-07: Native 기준선 오염 차단 [설계·환경 리스크]

- marketplace로 설치된 플러그인만 끄면 flat 설치된 전역 rules/CLAUDE.md가 남아 B군 결과를 오염시킬 수 있다.
- A/B/C/D 별 별도 HOME/프로필, 고정 project SHA, 모델·effort·권한·도구, 깨끗한 worktree, 설정/hook/skill 실제 로딩 manifest.
- 'Safe mode' 등의 CLI 옵션은 실험 PC의 cli --help와 문서/호스트 버전으로 검증하고 미지원 시 중단, 대체하려면 동일 격리 요건 충족 필요.
- 설치 프로필·개인 인증 파일 복사/변경 금지. 실험에는 실서비스 자격증명을 제공하지 않는다.

## 3. P1/P2 — 18개 개선 백로그 전체

우선순위 값은 초기 설계 판단이지 결함의 실제 발생 빈도/경제효과 실측이 아니다.

| ID | 우선 | 과제 | 검증 후 결정 |
|---|---|---|---|
| IMP-01 | P0 | 반복 감지 이력의 프로세스 간 누적 | FIX |
| IMP-02 | P0 | loop 경고와 진짜 차단 계약 | FIX, enforce는 canary |
| IMP-03 | P0 | 미분류 Bash 실행 receipt 유실 | FIX |
| IMP-04 | P0 | VERIFY 증거 없는 완료 보고 | FIX, shadow→canary |
| IMP-05 | P0 | invalid config에서 검사 silently OFF | FIX |
| IMP-06 | P0 | 실제 비용·토큰 vs 추정치 | FIX |
| IMP-07 | P0 | A/B 설정 오염·설치판 차이 | FIX |
| IMP-08 | P1 | SessionStart 부하/timeout | MEASURE → TUNE |
| IMP-09 | P1 | 단순 질의에 과도한 team/planning | MEASURE → BYPASS |
| IMP-10 | P1 | /split 사람 개입/병합·충돌 비용 | MEASURE → ON_DEMAND |
| IMP-11 | P1 | 메모리 재사용 가치와 오염 | MEASURE → KEEP/SIMPLIFY |
| IMP-12 | P1 | SessionEnd 학습 입력/다음 세션 소비 | MEASURE → SHADOW |
| IMP-13 | P1 | 스킬 오탐·중복 주입 | MEASURE → TUNE |
| IMP-14 | P1 | task/run/session/evidence ID 불일치 | ALIGN |
| IMP-15 | P1 | config 키와 실제 consumer의 대조 | AUDIT |
| IMP-16 | P2 | 중복 리뷰·quality guard | EVIDENCE → MERGE |
| IMP-17 | P2 | 모델 선택의 실제 비용/품질 이득 | SHADOW → A/B |
| IMP-18 | P2 | README, 규칙, 설정·현실 차이 | FIX DOC DRIFT |

작업 우선순위 사전 검토에만 사용할 점수: RPN = 발생가능성(1–5) × 영향도(1–5) × 노출도(1–5); 비교 우선점수 = RPN × 근거 신뢰도(0–1) ÷ (추정 작업일+1). **P0 안전/검증 항목이 우선**하며 임의 RPN으로 장애 영향도 또는 실제 이득을 산정하지 않는다.

## 4. 유지/단순화/보류의 판단 기준

- KEEP: B군 대비 독립 검증으로 유효성 확인. 유지 비용 설명 가능.
- FIX: 실제 producer→consumer/host 단절이 있고 해당 기능을 유지할 이유가 있음.
- MERGE/SIMPLIFY: 실사용 경로에서 동일 지시·판단·증거를 중복 생산함이 확인.
- ON_DEMAND: 복잡한 독립 업무에서만 이득(Team/Split/깊은 review/추가 모델).
- EXPERIMENTAL: 코드 존재하나 사용·효과 미검증. 관찰 우선.
- REMOVE: 회귀/보안 위험을 독립 검증하고 실제 소비자·효과가 없음을 증명한 뒤 별도 승인.

## 5. 단계별 실행·롤백

**Wave 0 (관찰):** Git SHA/설치 실제 로드 확인, 호출 그래프와 config consumer 목록, 로그 분모/누락, 테스트 시작점 및 차단/승인 지점을 고정. 프로덕션 동작 무변경.

**Wave 1 (P0 연결 수리):** raw receipt 수집 → loop 영속화 → 실호스트 결과 전달. 독립 자식 프로세스/Windows·Linux 경합 테스트. 초기 배포 observe-only.

**Wave 2 (검증 증거):** VERIFY attempt와 실제 검사 실행·Git SHA를 묶고 UNKNOWN을 PASS로 승격하지 않는다. 기존 데이터 backward compatibility. 잘못된 config는 명시 상태와 경고 처리.

**Wave 3 (비용/효율):** B/C paired 실험, instrumentation, Atlas 같은 새 플랫폼 구축 금지. 데이터 없는 절감/학습 이득 주장 금지.

**Wave 4 (경량화):** B/C 결과로 Lite 실험군 후보 고정, 독립 holdout에서 확인한 뒤 기본값을 전환. 유용한 기존 훅/메모리/보안 기반은 근거 없이 삭제 금지.

모든 Wave 공통: branch + PR, 최소 수정, 작업 전 RED 재현, 관련 테스트 GREEN, 실제 호스트 증거, 반대 검증, rollback flag/default, 불변 파일 범위, 기존 상태 파일 보존. Stop 조건: 비밀 노출/무허가 실행/거짓 완료 신호 상승/프로필 오염/데이터 유실/호스트 정책 위반.

## 6. 기존 ARTIBOT v5 정본과 충돌 방지

- V5-BACKLOG의 100항목 완료율은 기존 정본에만 기록, 이 문서의 18항목을 임의로 분모에 합치지 않는다.
- ARTIBOT-5.0-DESIGN.md가 정한 StateStore/ledger 유일 정본, Observe→Shadow→Canary→GA, 비대화형 인간 승인 시 pause를 존중.
- 본 설계는 '새 시스템 전부 재구축' 권고가 아님. 기존 도구와 소비자를 최대한 재사용하는 **수정 지침**이다.
