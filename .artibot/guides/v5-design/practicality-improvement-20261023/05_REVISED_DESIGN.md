# 05. 개정 설계안 — 검증(04)을 통과한 것만, 기존 부품 위에 (2026-10-23)

- **지위**: [01](01_IMPLEMENTATION_DESIGN.md)·[02](02_BASELINE_ROI_PROTOCOL.md)·[03](03_IMPLEMENTATION_HANDOFF.md) 의 **개정판**이다. 01·02 와 어긋나면 이 문서가 이긴다(§0 정정표). 원문은 보존한다.
- **기준**: master `6149446e`. 근거는 [04_VALIDATION_REPORT](04_VALIDATION_REPORT.md) 의 실측이고, 여기서는 재인용만 한다.
- **변경 0**: 이 문서는 설계다. 코드·설정·원장을 바꾸지 않는다. 구현은 Wave 별 별도 PR(§5), RED 재현 → GREEN, 오너 승인 뒤.
- **어휘**: 후보 판정은 `skills/problem-validation/SKILL.md`(NECESSARY / PARTIAL / DEFER / REJECT), 처분은 01 §4(KEEP / FIX / MERGE / ON_DEMAND / EXPERIMENTAL / REMOVE), 단계는 [ARTIBOT-5.0-DESIGN](../ARTIBOT-5.0-DESIGN.md) §4(Observe = 기록만·행동 변화 0 / Shadow = 비교 / Canary = 저위험 자동·config 1키로 되돌림 / GA).

## 0. 요약과 정정표

**한 줄**: P0 7건 중 5건(IMP-01~05)은 실측된 실제 단절이고, 1건(IMP-06)은 이미 구현돼 있으며, 1건(IMP-07)은 환경 설계다. 이 개정판은 **새 저장소·새 스키마·새 훅 등록 0** 으로 다섯 단절을 닫고, 비교 실험은 기존 영수증·판독기 위에서 한다. 모델에 보이는 변화는 전부 config 1키 뒤에 두고 출하 OFF 다.

| 01/02 의 제안 | 개정 | 이유(04 절) |
|---|---|---|
| IMP-01 LoopReceiptStore 신설(원자·멱등·TTL·CAS·잠금) | 기존 상태 파일 유지 · 호출마다 flush · O2 세션 경로 · 감지를 분류 앞으로 | 소비처 없는 저장소. 루프는 순차라 CAS 가 막는 경합이 없다(04 §2.1) |
| IMP-01 수용 "8 프로세스 동시 loss 0" | "별도 프로세스 **순차** 3회 warn · 5회 block" + 병렬 undercount 를 '못 보는 것' 으로 명기 | 손실은 미탐 방향, 오탐 아님 |
| IMP-02 PreToolUse 구조화 deny 로 전환 | 1단계 PostToolUse `additionalContext` 권고(기존 merge 배선) → 2단계 deny 는 오탐률 측정 뒤 오너 결정 | 호스트 문서 + `.artibot/project.md` Non-goals(04 §2.2) |
| IMP-03 raw execution receipt 저장소 | `bash:unknown:shell` 수용 + 접두 2종 처리. 디스패치 분모는 `hook.fired` | 둘째·셋째 저장소 금지(04 §2.3) |
| IMP-04 VerifyEvidenceV1 신규 스키마 10필드 | 규칙 6 을 `foldVerify` 허용목록으로 + 리포터 스냅샷에 `git_sha` 1키 + 규칙 7 | 10필드 중 9개가 기존 부품(04 §2.4) |
| IMP-05 "최후 유효 정책 유지" | 3상태 + 경고(행동 변화 0). 정책 전환은 오너 결정 #4(2026-10-05) 에 종속 | 결정과의 충돌 회피(04 §2.5) |
| IMP-06 추정/실측 분리 작업 | 작업 없음. C3 라벨 착지 + 02 비용 컬럼 = `usage.receipt` | 이미 구현(04 §2.6) |
| IMP-07 HOME 분리 | `CLAUDE_CONFIG_DIR` + `--setting-sources` + `--plugin-dir` + `--bare` + 프로젝트 `CLAUDE.md` Artibot 절 제거 | 호스트 공식 수단 · 누락 벡터(04 §2.7) |
| 02 §4 attempt 레코드 24필드 | 실험 매니페스트 ~14필드 + 원장 조인 | `attempt-receipt` 스키마와 중복(04 §4) |
| IMP-08 MEASURE → TUNE | 종결(2026-10-20 결정 유지) | 이미 측정(04 §3) |
| IMP-16 · IMP-17 | 기존 문서로 이관 | 중복(04 §3) |

## 1. 설계 원칙 (정본에서 가져옴)

1. **진실원 하나** — 원장·기존 스키마·기존 상태 파일을 재사용한다. 새 저장소는 소비처가 먼저 있을 때만(`plugins/artibot/CLAUDE.md` Existence Audit).
2. **허용목록** — 통과 조건은 열거하고, 열거 밖은 통과시키지 않는다(`rules/verification-discipline.md` §8).
3. **Observe → Shadow → Canary → GA** — 모델에 보이는 변화는 config 1키 뒤, 출하 OFF. Observe 단계에서 새 차단을 만들지 않는다(`.artibot/project.md` Non-goals).
4. **게이트는 vitest 로만** — RED 재현 → 수정 → GREEN. 게이트 옆에 못 보는 것을 적는다(verification-discipline §9·§10).
5. **PR 1건 = 모듈 1~2개 + 테스트** — 기존 상태 파일 일괄 삭제 금지, 바이트 불변 경로는 테스트가 핀.
6. **수치는 재현 명령과 함께** — 없는 값은 null/UNMEASURED, 0 으로 쓰지 않는다.

## 2. P0 설계

각 항목: 현상(04 재인용) → 수정 → 재사용 부품 → RED 테스트 → 수용 → 못 보는 것 → 롤백 → 단계·크기 → 판정.

### D-01 루프 이력 영속화 (IMP-01, IMP-03 의 순서 문제 포함)

- **현상**: 호출마다 새 프로세스라 `loopCallCounter % 10` 이 참이 될 수 없고, 감지도 없어 파일이 영구히 생기지 않는다(04 EXP-A). 상태 파일은 전역 1개. 미분류 Bash 는 감지 앞에서 반환된다.
- **수정**(`scripts/hooks/tool-tracker.js` 한 파일):
  1. `detectLoop` 호출을 `buildContext` 의 null 검사 **앞**으로 옮긴다.
  2. flush 조건을 "이력이 바뀌었으면" 으로 — 사실상 호출마다 `saveLoopState`. `LOOP_STATE_FLUSH_INTERVAL`·`loopCallCounter` 제거. 비용은 호출당 ≤20 엔트리(약 2KB) 원자 쓰기 1회 — 같은 프로세스가 이미 `tool-history.json`·`daily-experiences.json` 두 파일을 쓴다(04 EXP-A).
  3. 경로를 `lib/core/runtime-state.js#resolveScopedStatePath`(`session_id`, `loop-state.json`) 로 — O2 관례(`runtime/sessions/<sid>/`). `session_id` 가 없으면 지금의 플랫 파일(기존 동작 보존).
  4. 만료 30분(`STATE_EXPIRY_MS`) 유지.
  5. `:34-40` 주석을 사실로 바꾼다(IMP-18).
- **재사용**: `createLoopDetector` 그대로(임계 3/5, 창 20). `atomicWriteSync` 그대로. 상태 디렉터리 리졸버는 `resolveScopedStatePath` 가 이미 따른다 — 두 리졸버가 같은 홈 검사(`ARTIBOT_STATE_DIR_HOME`)를 공유하는지는 **미확인**이고, 기존 3건 테스트(`tests/hooks/tool-tracker-loop-state.test.js`)가 핀이다.
- **RED 먼저**(`tool-tracker-loop-state.test.js` 확장): ① cold start — 심은 파일 없이 SEEDED+1 회 spawn → 파일 존재 + 마지막 spawn stderr 에 `LOOP WARNING`(현 트리 RED, EXP-A 가 증명) · ② blockThreshold 회 → `LOOP BLOCKED` 라벨(RED) · ③ 세션 A 3회 + 세션 B 1회 → B 에 경고 없음(격리) · ④ `session_id` 없는 payload → 플랫 파일(불변).
- **수용**(01 수정): 별도 Node 프로세스 순차 3회 → warn, 5회 → block 라벨 · 두 세션 교차 0 · 기존 파일 삭제 0 · `tests/firewall/hook-timeout-budget.test.js` 그린(핸들러 예산 3000ms 불변).
- **못 보는 것**: 한 턴의 병렬 **상이한** 호출 N 개가 동시에 쓰면 N−1 개 이력이 사라진다(undercount; 루프 오탐 아님). 서브에이전트 payload 의 `session_id` 가 메인과 같은지 다른지 미확인 — 같으면 서브에이전트의 반복이 메인 이력에 섞인다(현행과 같음). 라이브 발동은 D-02 1단계 계수로 본다.
- **롤백**: revert(파일 1 + 테스트 1). 상태 파일 JSON 형은 같아 호환.
- **단계·크기**: Observe(기록 전용 훅의 설계 동작 복원, 모델 가시 변화 0) · XS.
- **판정**: NECESSARY · FIX.

### D-02 루프 신호의 도달 (IMP-02)

- **현상**: exit 0 의 stderr 는 모델이 보지 못한다(호스트 문서). 소비처 0. 효과 0(04 §2.2).
- **1단계 Observe**(D-01 과 같은 PR 또는 바로 다음): 감지 시 세션 상태 파일 안에 `detections: [{ts, tool, severity, count}]` 를 누적한다(같은 파일, 새 저장소 아님) + stderr 유지. 판독기 1개(읽기 전용, `scripts/ledger/recovery-journal-census.mjs` 선례)가 "세션당 warn/block 수 · 도구 분포 · 상위 fingerprint" 를 낸다. 여기서 **오탐 표본**(테스트 재실행 · polling · `tail` · 같은 파일 재읽기)을 손으로 분류한다.
- **2단계 Canary**(키 `cognitive.loopDetector.advisory`, 출하 `false`): 감지 시 stdout 에 `{ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[artibot:loop] <tool> 연속 N회 동일 인자. 같은 호출을 반복하기 전에 입력이나 접근을 바꿔라.' } }` 를 쓴다. 디스패처 `scripts/hooks/_dispatcher-utils.js#mergeResults` 가 연결해 호스트에 넘기고(실측 `:427-432`), 호스트는 도구 결과 옆에 시스템 리마인더로 넣는다(hooks.md PostToolUse decision control). **차단이 아니다.** 플립 조건: 1단계 표본에서 오탐 비율을 분모와 함께 기록한 뒤 오너.
- **3단계(설계만, 구현 보류)**: PreToolUse `permissionDecision: 'deny'`. 요구 — `*` 매처 신규 등록(호출당 node 1개 추가; PreToolUse 지연은 미측정, [gap review](../../../REPORTS/claude-updates-gap-review-2026-10-12.md) P-13) · 보호 허용목록(`npm test`·`vitest`·`tail`·`sleep`·polling 류는 차단 제외) · 1키 kill switch · `.artibot/project.md` Non-goals 개정(오너). 2단계 데이터에서 "권고 뒤에도 반복이 이어져 비용이 난" 사례가 관측될 때만 재론.
- **못 보는 것**: 모델이 additionalContext 를 따르는지는 미측정(`plugins/artibot/CLAUDE.md` 가 auto-activate 에 같은 유보를 적음). 설치본 호스트 버전의 PostToolUse additionalContext 지원은 문서만 확인.
- **롤백**: 2단계는 키 `false`. 1단계는 revert.
- **단계·크기**: 1단계 Observe · XS. 2단계 Canary(키 OFF 출하) · XS.
- **판정**: PARTIAL — 1·2단계 NECESSARY, 3단계 DEFER.

### D-03 미분류 Bash 수용 (IMP-03)

- **현상**: 선두 토큰 11종 밖은 행 0(04 EXP-B). `npx vitest run` 은 `execute` 로 오분류.
- **수정**(`tool-tracker.js#buildContext`·`#classifyBashCommand`): ① Bash 분기가 null 대신 `bash:unknown:shell` 을 돌려준다. 점수는 기존 `scoreResult`(exit_code · stderr) 그대로. **명령 본문은 저장하지 않는다**(현행 유지 = 01 의 redaction 요구 충족). ② 분류 전 정규화를 허용목록 2종으로 한정: 선두 `cd <path> &&`(또는 `;`) 1회 제거 · 선두 `NAME=value ` 반복 제거. ③ `vitest`·`npx vitest` → `test`. 그 밖의 정규식 확장은 하지 않는다(01 의 "분류율 숫자 올리기 금지" 수용).
- **분모**: 라이브 `tool-history.json` 의 `bash:unknown:shell` 비율을 전후로 적는다(한 줄 판독, 재현 명령 동반). 디스패치 분모는 `hook.fired`.
- **RED 먼저**(`tests/hooks/tool-tracker.test.js`): 02 Phase 0 #2 의 6문형 → 전부 행 존재 · `cd x && npm test` → `bash:test:shell` · `CI=1 npm test` → `bash:test:shell` · `bash scripts/run.sh` → `bash:unknown:shell` · 명령 본문이 어떤 저장 파일에도 없음.
- **못 보는 것**: unknown 행이 학습 추천의 노이즈가 될 수 있다 — `lib/learning/tool-learner.js` 가 unknown 컨텍스트를 추천에서 제외하는지 **미확인**(구현 전 확인 항목).
- **롤백**: revert. **단계·크기**: Observe · XS.
- **판정**: PARTIAL — 수용·접두 처리 NECESSARY, raw receipt 저장소 DEFER.

### D-04 REPORT 게이트의 증거 (IMP-04)

- **현상**: 규칙 6 이 부정 목록이라 null·산문·소문자·중첩·문자열이 통과한다(04 EXP-C). enforce 는 출하 true.
- **1단계 Observe**(읽기 전용 census): `lib/autopilot/report-verify-gate.js#censusReportVerifyEvidence` 옆에 `lib/autopilot/recovery-record.js#foldVerify` 의 분포(PASS / FAIL / UNMEASURED)를 세는 판독기 — 세션 스토어 입력, writer import 0(`recovery-journal-census.mjs` 선례). 출력 "REPORT 도달 세션 N 중 UNMEASURED M, 측정 시각". 이것이 2단계 플립의 분모다.
- **2단계 Canary**(키 `autopilot.reportVerifyGate.evidenceMode`, 허용값 `'ack'` / `'explicit-pass'` / `'deterministic'`, 출하 `'ack'` = 현행. 미지 값은 `'ack'` + D-05 의 경고):
  - `'explicit-pass'`: 규칙 6′ = `foldVerify(state.verifyResult) === 'PASS'` 필수. 아니면 신규 코드 `VERIFY_RESULT_UNMEASURED`(FAIL 과 구분) 로 pause, 메시지에 허용 형 3종을 적는다. 기존 `hasExplicitVerifyFail` 분기는 그대로 FAIL 로 남긴다.
  - `'deterministic'`: 규칙 7 추가 — `lib/verification/deterministic-source.js` 로 `runtime/last-test-result.json` 을 읽어 허용목록 규칙 6(exitCode 0)을 통과 **그리고** 스냅샷 `git_sha` = 현재 HEAD **그리고** 스냅샷 시각 ≥ 이번 VERIFY attempt 시작. 어느 하나라도 아니면 `VERIFY_EVIDENCE_STALE` / `VERIFY_EVIDENCE_MISSING`.
- **전제 변경 1건**: `tests/reporters/test-status-reporter.js` 가 `git_sha`(실행 종료 시 HEAD; 못 읽으면 키 생략, null 금지)를 쓰고 `schemaVersion` 3. `deterministic-source.js` 는 키가 없으면 "SHA 미확인" 으로 읽어 `'deterministic'` 모드에서만 거부한다(v2 파일은 그대로 읽힌다).
- **재사용**: `foldVerify` · `deterministic-source.js` · attempt 의 `checkpointSha`·시작 시각 · `verify.completed` writer(기록 측은 변경 없음). **VerifyEvidenceV1 신규 스키마는 만들지 않는다.**
- **RED 먼저**(`tests/autopilot/report-verify-gate.test.js`): EXP-C 7형 → `'explicit-pass'` 에서 `VERIFY_RESULT_UNMEASURED` · `'ack'` 에서 `ok`(기존 94건 바이트 불변) · 스냅샷 SHA 불일치 → STALE · 스냅샷 없음 → MISSING · 미지 키 값 → `'ack'` 동작.
- **수용**(01 수정): ACK done + null/산문/소문자/중첩/문자열 → verified PASS 0(`'explicit-pass'` 이상) · 유효 fresh evidence → PASS · `'ack'` 바이트 불변.
- **못 보는 것(게이트 옆)**: 결정적 증거는 **테스트 층만**이다 — lint·tsc·build 는 UNMEASURED(`deterministic-source.js` 헤더). 테스트가 없는 작업(문서·설정)은 `'explicit-pass'` 에서 드라이버가 `UNMEASURED` + 사유를 써도 **pause** 한다 — 예외 정책은 오너 결정(§7 #2). 스냅샷은 플러그인 루트의 `runtime/` 에만 있어 설치본(캐시) 세션에서는 항상 MISSING 이다 — `deterministic-source.js` R1 결정과 같은 한계. 게이트는 "검증이 의미 있었는지" 를 여전히 모른다(헤더 `:161-168`).
- **롤백**: 키를 `'ack'`. **단계·크기**: 1단계 Observe · S, 2단계 Canary(키 OFF 출하) · M.
- **판정**: PARTIAL — 규칙 6′ · SHA 결합 NECESSARY, 신규 스키마 REJECT.

### D-05 설정 읽기 상태 (IMP-05)

- **현상**: 깨짐·누락·명시 false 가 같은 `{enforce:false}` 다(04 EXP-D).
- **수정**: `loadReportVerifyGateConfig()` → `{ enforce, state, reason }`, `state ∈ { 'on', 'off', 'invalid', 'missing' }`(허용목록). `invalid` / `missing` 이면 세션당 1회 `tick(level: 'warn', type: 'config-unreadable')` + stderr 1줄. `enforce` 는 현행대로 false(**행동 변화 0**). 같은 수정을 `lib/autopilot/recovery-transition.js#loadRecoveryTransitionConfig` 에.
- **하지 않는 것**: fail-closed 전환. 그 자리는 오너 결정 #4(2026-10-05, [VERIFICATION-ECONOMICS-DESIGN](../../VERIFICATION-ECONOMICS-DESIGN.md) §0.2 — CA-04·R-5 일정) 가 갖고 있다. 이 설계는 그 결정에 "invalid 가 실제로 몇 번 일어났나" 라는 입력을 공급한다.
- **RED 먼저**: EXP-D 세 경우 + `enforce: "true"`(문자열) → `off` + 경고 tick 1회(세션 반복 호출에 1회).
- **못 보는 것**: 플러그인 업데이트 중 config 가 잠깐 비는 창에서 경고가 날 수 있다 — 빈도는 tick 으로 센다.
- **롤백**: revert. **단계·크기**: Observe · XS.
- **판정**: NECESSARY(가시화) · DEFER(정책).

### D-06 사용량 진실원 (IMP-06)

- **코드 신설 0.** (a) C3 라벨 정정을 VERIFICATION-ECONOMICS §4.3 범위 그대로 착지한다 — `scripts/hooks/statusline.sh`·`lib/tui/dashboard.js` 표기를 "현재 입력 추정 ≈" 로, `scripts/hooks/runtime-prompt.js#persistTokenUsage` 에 `kind: 'prompt-estimate'`. (b) 02 의 컬럼 정의: `cost_usd` = `usage.receipt.cost.total`(source=transcript 행만 집계, estimate 행은 별도 열) · `cost_basis` = `'catalog-api-equivalent:' + cost.pricing_version` · 구독 과금 열은 **항상 null**(oracle 없음). (c) 전 군 공통으로 OTel console 지표(`input_tokens`·`cache_read_tokens`·`cache_creation_tokens`)를 2차 출처로 받아 영수증과 ±5% 정합성 점검 — 불일치면 그 trial 은 INCONCLUSIVE.
- **판정**: REJECT(신규 분리 작업) · NECESSARY(a, b).

### D-07 공정 격리 런북 (IMP-07 + 02 §2 정정)

군별 프로필은 모두 사용자 실제 홈과 분리하고, 인증은 실험 전용 계정이다. `$P` 는 실험 프로필 루트.

| 군 | 명령 골격 | 로드되는 것 |
|---|---|---|
| A Pure | `CLAUDE_CONFIG_DIR=$P/A claude --bare -p …` | 모델 + 내장 도구만(문서: 훅·스킬·커맨드·서브에이전트·플러그인·MCP·자동 메모리·CLAUDE.md 생략) |
| B Native | `CLAUDE_CONFIG_DIR=$P/B claude --setting-sources project -p …` + 워크트리 `CLAUDE.md` 의 Artibot 절 제거 + `.claude/rules/` 에 artibot 없음 확인 | 프로젝트 규칙 · MCP · 권한만 |
| C Full | `CLAUDE_CONFIG_DIR=$P/C claude --setting-sources project --plugin-dir <artibot checkout @ 고정 SHA>/plugins/artibot -p …` | B + Artibot 고정 커밋 |
| D Lite | C 와 같되 config 스위치를 사전 고정(후보는 Phase 1 뒤 결정) | — |

- **공통 고정**: `--effort <값>` · 모델 · 권한 모드 · `--output-format stream-json --include-hook-events`(훅 발화 스트림 = 로드 매니페스트) · `--max-budget-usd <상한>`(안전망; 클라이언트 추정임을 기록) · trial 마다 깨끗한 worktree @ base SHA · 숨김 acceptance 검사는 모델 실행 뒤 **별도 체크아웃**에서.
- **사전 점검(실행 전 등록)**: 각 프로필에서 `claude --help` 로 위 플래그 존재 확인(미지원이면 중단 — 02 그대로) · 프로필 안 `plugins/`·`rules/`·`CLAUDE.md` 의 부재(B) / 존재(C) 를 `find` 로 매니페스트에 기록 · 프로젝트 `CLAUDE.md` 의 Artibot 절 유무 grep · B 프로필 안에 `artibot` 문자열 0.
- **측정**: C/D 는 원장(`.git/artibot/ledger.jsonl`) + [RUNBOOK](../MEASUREMENT-RUNBOOK.md) 판독기 5종. A/B 는 `scripts/ledger/usage-cost-table.mjs --projects-dir $P/<arm>/projects --live-session <id>` 로 transcript 를 접어 **같은 영수증 형**을 얻는다(추론 — 실행 미확인, Wave 5 시운전 첫 항목). OTel console 2차 출처는 전 군 공통.
- **판정**: NECESSARY.

## 3. P1/P2 처분표 (18행)

| ID | 판정 | 처분 | 이미 있는 부품 → 다음 행동 |
|---|---|---|---|
| IMP-01 | NECESSARY | FIX | D-01 |
| IMP-02 | PARTIAL | FIX(권고) · DEFER(차단) | D-02 |
| IMP-03 | PARTIAL | FIX | D-03 |
| IMP-04 | PARTIAL | FIX(키 뒤) | D-04 |
| IMP-05 | PARTIAL | FIX(가시화) | D-05 |
| IMP-06 | REJECT · NECESSARY(잔여) | KEEP | D-06 |
| IMP-07 | NECESSARY | FIX(런북) | D-07 |
| IMP-08 | REJECT | KEEP | 2026-10-20 결정 유지. 감시 조건(`session-digest` 3→5 s)만 NEXT-SESSION 그대로 |
| IMP-09 | DEFER · MEASURE | KEEP | `team.autoApplyTriggers` 우회 존재. 원장 `topology.selected` 로 "SIMPLE 에 팀 발화" 비율 측정 뒤 재론 |
| IMP-10 | MEASURE | ON_DEMAND(현행) | SH-12 진짜 `/split` 레인 + ADR-011 원장 + `topology-agreement.mjs` |
| IMP-11 | MEASURE | KEEP | `memory.*` 5이벤트 판독기 1개(읽기 전용) 추가 뒤 측정 |
| IMP-12 | DEFER | EXPERIMENTAL | Existence Audit `modules: null` — "다음 세션 소비" 측정 설계가 먼저 |
| IMP-13 | MEASURE | KEEP | description 린터 + nl-activation eval |
| IMP-14 | PARTIAL | ALIGN(최소) | D-04 가 필요로 하는 attempt↔증거 결합만. 봉투 7종 ID 는 그대로 |
| IMP-15 | PARTIAL | AUDIT | `triage-wiring-gaps.mjs` 대상 키에 이 설계의 신규 키 2개 추가 |
| IMP-16 | REJECT | — | VERIFICATION-ECONOMICS §2.3 으로 |
| IMP-17 | REJECT | — | MODEL-SWITCHING-SCORECARD · `route-compare.mjs` 로 |
| IMP-18 | PARTIAL | FIX DOC | 04 §2.8 의 2건을 D-01 PR 에 동반 |

## 4. 비교 실험 프로토콜 — 02 의 개정 사항

**유지**: 4군 · 짝지은 B/C 비교 · 실행 순서 무작위화 · 산식 전부 · 의사결정 Gate 6항 · Phase 2 실패주입 12종 · Split 특화 테스트.

**변경**
1. §2 격리: D-07 의 명령 골격·사전 점검으로 교체. 오염 벡터에 프로젝트 `CLAUDE.md` Artibot 절과 `~/.claude/{agents,commands,artibot}` 추가.
2. §4 레코드: 아래 **실험 매니페스트**로 교체. 토큰·비용·모델·run·훅 실패·wall time 은 원장과 영수증에서 조인한다(04 §4 매핑표).
3. 비용 컬럼: D-06 (b).
4. Phase 0: 항목 1·2·3·5 는 04 §7 로 완료. 잔여 4(오래된 SHA 성공 재활용 — D-04 규칙 7 의 RED 가 곧 이것) · 6(SessionStart 부하 — 2026-10-20 측정으로 대체) · 7~12.
5. 예산: 오너가 USD 상한을 매니페스트 머리에 적은 뒤 시작한다(NEXT-SESSION 의 "$6 중단선" 결정을 재론하는 자리).
6. RUNBOOK 과의 관계를 명문화: RUNBOOK = 같은 프로젝트 T0 → ON 관측 연구(v5.1), 02 = 격리 프로필 통제 실험. C 군 판독은 RUNBOOK 판독기, 결과 보관은 [evidence/README](../evidence/README.md) 관례.

**실험 매니페스트**(trial 당 JSON 1개, 실험 디렉터리에; 리포에는 요약만):

```json
{
  "task_id": "T-07", "trial": 2, "arm": "C",
  "host_version": "<claude --version>", "plugin_commit": "<sha or null>",
  "base_git_sha": "<sha>", "final_git_sha": "<sha>",
  "config_digest": "<sha256 of artibot.config.json or null>",
  "profile_manifest_digest": "<sha256 of find-listing>",
  "session_id": "<host session id>", "started_at": "<iso>", "ended_at": "<iso>",
  "human_minutes": 0,
  "hidden_check": { "command": "npm test -- tests/hidden/T-07.test.js", "exit_code": 0, "ran_at": "<iso>" },
  "independent_review": { "verdict": "PASS", "reviewer": "<id>" },
  "measurement_status": "measured",
  "notes": ""
}
```

`verified_pass` = `hidden_check.exit_code === 0` **그리고** `independent_review.verdict === 'PASS'`(둘 다 — 02 그대로). 비용·토큰은 `session_id` 로 `usage.receipt` 에 조인하고, `measurement_status` 는 영수증 `usage.source` 등급과 함께 보고한다. 빈 값은 null 이고 0 이 아니다.

## 5. Wave 재편 (PR 단위)

| Wave | 내용 | 바뀌는 파일 | 단계 | RED 먼저 | 롤백 |
|---|---|---|---|---|---|
| 0 | 이 검증(완료) + 라이브 분모 3종: 빈 verifyResult 로 REPORT 도달 비율 · `bash:unknown` 비율 · PostToolUse 일일 디스패치 | 판독만, 변경 0 | — | — | — |
| 1 | D-01 ①~⑤ + D-03 + 04 §2.8 주석 2건 | `scripts/hooks/tool-tracker.js` · `_posttooluse-dispatcher.js`(주석) · 테스트 2 | Observe | ✓ | revert |
| 2 | D-05(두 로더) + D-02 1단계 계수 + D-04 1단계 census | `report-verify-gate.js` · `recovery-transition.js` · `tool-tracker.js` · 판독기 1 | Observe | ✓ | revert |
| 3 | D-04 2단계(`evidenceMode` 키, 출하 `'ack'`) + 리포터 `git_sha` | `report-verify-gate.js` · `test-status-reporter.js` · `deterministic-source.js` · `artibot.config.json` · 테스트 | Canary(키 OFF 출하) | ✓ | 키 `'ack'` |
| 4 | D-02 2단계(`advisory` 키, 출하 `false`) | `tool-tracker.js` · `artibot.config.json` · 테스트 | Canary(키 OFF 출하) | ✓ | 키 `false` |
| 5 | D-07 시운전(Phase 0 잔여 + B 군 영수증 산출 시험, API 0) → Phase 1 pilot(오너 예산 뒤) | 문서 · 매니페스트 | 실험 | — | — |
| 6 | D Lite 후보 고정 → 독립 holdout | config(실험 프로필만) | 실험 | — | — |

모든 Wave 공통(01 §5 유지): branch + PR · 최소 수정 · RED 재현 → GREEN · 관련 방화벽 테스트 그린(`hook-timeout-budget` · `v5-config-firewall` · `report-verify-gate`) · 반대 검증 · rollback 명시 · 기존 상태 파일 보존. Stop 조건: 비밀 노출 · 무허가 실행 · 거짓 완료 신호 상승 · 프로필 오염 · 데이터 유실 · 호스트 정책 위반.

## 6. 이 설계가 못 보는 것 · 미확인

- 호스트가 서브에이전트 payload 에 주는 `session_id`(D-01 격리의 실효).
- PostToolUse `additionalContext` 를 설치본 호스트가 모델에 전달하는지, 모델이 따르는지(D-02 2단계).
- `resolveScopedStatePath` 와 `tool-tracker.js#loopStateFile` 의 리졸버가 같은 홈 검사를 공유하는지(D-01 ③, 기존 테스트가 핀).
- `tool-learner.js` 의 unknown 컨텍스트 처리(D-03).
- 리포터 스냅샷의 `git_sha` 를 설치본 세션이 영구히 못 보는 한계의 수용 여부(D-04, §7 #6).
- `usage-cost-table.mjs --projects-dir` 의 B 군 적용(D-07, Wave 5 첫 항목).
- 사용자 PC(Windows) 에서의 재현과 `claude --help` 의 플래그 집합.
- 라이브 분모 전부(Wave 0 의 일).

## 7. 오너 결정 필요 (가치 결정만 — 사실은 조사로 해소됐다)

1. **루프 제어의 최종 형태**: 권고(D-02 2단계)에서 멈출지, 오탐 데이터 뒤 PreToolUse deny(3단계)를 열지 — 후자는 `.artibot/project.md` Non-goals 개정이다.
2. **REPORT 게이트 `evidenceMode` 의 목표값**과 테스트가 없는 작업의 예외 정책: `UNMEASURED` + 사유를 통과로 볼지, 사람 승인(pause 1회)으로 볼지.
3. **config invalid 의 정책**: 기존 결정 #4 일정 유지(이 설계의 기본) 또는 재론.
4. **비교 실험 예산(USD)** 과 B 군 정의 승인 — 프로젝트 `CLAUDE.md` 의 Artibot 절 제거를 기본으로 한다.
5. **IMP/D 항목의 거처**: 이 폴더 유지 vs [V5-BACKLOG](../V5-BACKLOG.md) §3 부채 트랙 행 등재(진행률 불산입 트랙이라 README 의 원칙과 양립).
6. (선택) D-04 의 `git_sha` 가 설치본 세션에서 항상 MISSING 인 한계를 수용할지 — `deterministic-source.js` R1 결정과 같은 선.
