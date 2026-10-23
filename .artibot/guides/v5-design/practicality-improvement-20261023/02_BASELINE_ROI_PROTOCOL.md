# 02. 순정 Claude Code 기준선 및 ARTIBOT 실용성·ROI 검증 프로토콜

> 모든 수치는 동일 작업을 실제 실행한 로그에서만 산출. 현재 절감률·성공률·경제성은 **NOT_MEASURED**.

## 1. 4군 기준선

| 군 | 구성 | 목적 |
|---|---|---|
| A Pure Claude | cli가 지원한다면 --safe-mode 등으로 사용 가능한 커스터마이징을 끈 별도 환경 | 모델+기본 도구 능력 참고. 실무 기준선 아님 |
| B Native Project | 실제 프로젝트 규칙/동일 도구/권한은 유지하되 ARTIBOT이 없는 격리 프로필 | **최우선 기준선** |
| C ARTIBOT Full | 동일 프로젝트·모델·권한, 지정된 ARTIBOT 플러그인 commit을 실제 로드 | ARTIBOT의 순증분 |
| D ARTIBOT Lite | C의 실측에서 제거/선택적 호출 후보를 결정한 사전 고정 경량군 | 과설계 판단; 반드시 별도 holdout 평가 |

A-C, A-D만으로 효과 주장 금지. 비교 핵심은 C vs B, 후보 경량화는 D vs C/B이다.

## 2. 공정성 사전 검사(실행 전 등록)

- task_id, task의 시작 Git SHA, 동일 자연어 프롬프트, hidden acceptance test, OS/Node/Claude Code 버전, 모델, effort, 권한, 도구 집합과 비용 종료 조건을 고정한다.
- HOME/프로필/규칙/메모리/스킬/플러그인/hook 로드 매니페스트를 군별 저장; B군에 ARTIBOT 잔존 규칙이 있는지 검사.
- 동일 task_id와 trial의 B/C를 **짝지어 비교**, 실행 순서를 무작위화하고 독립 워크트리를 초기화.
- 구독 사용량과 API 과금을 구별하고, agent/child 비용의 이중 집계 방지.
- 비밀번호, 운영 인증, 프로덕션 DB, 외부 발송·배포·push·권한 변경은 실험 대상 제외. 자동 승인/위험한 permission 우회 옵션 사용 금지.
- 사용 중인 Claude Code의 --help로 safe-mode, plugin-dir, -p, max-budget-usd, effort, output-format 등 지원 여부를 확인. 미지원 플래그를 조용히 사용하지 않는다.

## 3. 테스트 묶음

Phase 0: 정적 producer→consumer wiring, hook payload schema, 프로세스 생존·영속성, 분류 실패, 허위 완료 시나리오. **API 모델 호출 0**.

Phase 1 pilot: 6과제 × B/C 2군 × 각 2회 = 최대 24실행. 유형: SIMPLE×2, BUGFIX×2, FEATURE×1, PARALLEL 또는 RESUME×1. 리소스 비용 상한을 사용자가 정한 뒤 실행하며, 예시 예산 수치는 실측 과금 보장이 아님.

Phase 2 위험 실패주입 12종:
1. 10회 동일 도구 별도 프로세스 호출과 루프 오탐.
2. cd dir && npm test / 환경변수 prefix의 성공·실패 기록.
3. VERIFY done이지만 검증 실행 증거 없음.
4. 오래된 Git SHA의 성공 결과 재활용.
5. 파손 JSON 설정에서 gate가 silently OFF.
6. SessionStart 부하·지연·타임아웃.
7. 팀이 같은 파일/같은 dev port 수정.
8. Split 자식 세션 강제 종료/상태 복원.
9. 세션 간 기억 및 프로젝트 간 오염.
10. 압축/재개 시 이미 완료한 작업 중복.
11. 권한 오류/민감정보/승인 우회 시도.
12. 동시 상태 기록 중단·중복·데이터 손실.

Phase 3: 실제 프로젝트 10~20 업무를 B/C/D 반복·독립 holdout에서 시험. 짧은 파일럿으로 '통계적 우월' 주장 금지.

Split 특화 테스트: Native single vs native Agent Teams vs ARTIBOT /team vs /split. 작업 독립성·파일 충돌/병합·사람의 창 열기/메시지·중복 읽기·완료 속도/비용을 모두 기록.

## 4. Attempt 수준 필수 원시 레코드

task_id, trial, arm, attempt_id, run_id, base_git_sha, final_git_sha, plugin_commit, host_version, model_id, effort, tool_permissions_digest, config_digest, loaded_manifest_digest, verified_pass, false_completion, regression_count, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_basis, wall_minutes, human_minutes, agent_count, hook_timeout_count, evidence_path, measurement_status.

- verified_pass: 사전 정의한 독립 숨김 검사와 독립 검수자 모두 만족. 모델의 '완료했습니다'만으로 PASS 불가.
- missing은 빈값/null과 NOT_MEASURED로; 사용량 0과 구분.
- 리뷰/재시도/추가 agent의 사용량은 한 번만 귀속.
- instrumentation 비용과 위험도 고지; 다른 런의 캐시 효과/작업 차이로 편향되지 않게 설정.

## 5. 경제성 계산식(동일 task mix/검증 기준에서만)

g군의 실행 i마다 S_i∈{0,1}은 독립 PASS, C_i는 실제 총모델 비용(USD), W_i는 wall minutes, H_i는 사람 개입 minutes.

- 성공률 p_g = ΣS_i / N_g
- 1회 시도 평균 비용 avg_cost_g = ΣC_i / N_g
- **검증 성공당 비용** = ΣC_i / ΣS_i ; ΣS_i=0이면 N/A(0 아님)
- 검증 성공당 시간 = ΣW_i / ΣS_i
- 품질 변화 = 100 × (p_C - p_B) percentage points
- 같은 종류 SIMPLE 실행의 ARTIBOT 추가 비용 = (ΣC_C / ΣC_B) - 1 (성공률 차이 반드시 병기)
- 지연과 token/cost 차이는 별개 지표. hook 실행 시간이 중첩된다면 총합이 전체 wall time보다 클 수 있어 critical path로 분리.

월간 시나리오(실측 효과 주장 아님): V=월 업무 수, r_g=성공률, C_g=시도 평균 모델비용, H_g=시도 평균 사람개입(분), w=사람 1시간 가치, F=ARTIBOT 고정 유지비/월, E=관측 인프라비/월.

- 동일 품질의 성공 작업 1건 기대 비용(단순 재시도 독립 가정) = C_g/r_g.
- 변동 편익 u = (C_B/r_B - C_C/r_C) + (H_B/r_B - H_C/r_C)×w/60
- **월 순편익** = V×u - F - E
- **월 손익분기 업무수** = (F+E)/u (u≤0이면 경제적 손익분기 없음)
- 성공당 시간 변화 = (W_B/r_B - W_C/r_C)/(W_B/r_B). 절약된 wall time을 근거 없이 전부 인건비 절약으로 환산하거나 다른 시간 절약 가치와 중복 합산 금지.

교육용 숫자(실측 아님): B 성공률 .80, 시도당 $1.40 → $1.75/성공; C 성공률 .90, 시도당 $1.70 → 약 $1.89/성공. 성공률 상승만으로 비용 효율이 개선됐다고 말할 수 없다.

## 6. 의사결정 Gate

1. 안전 위반 발생 시 모든 비용/속도 이득보다 먼저 STOP.
2. C의 검증 품질이 B보다 열등하지 않음을 입증하기 전까지 '저렴하다'는 이유만으로 채택 불가.
3. 초기에 SIMPLE에서 C/B 비용비 ≤1.15라는 목표를 제안하나 **실측 기준이 아니라 가설적 정책 임계치**다. 품질·개입 악화가 있으면 즉시 재평가.
4. C의 Full이 유리하면 KEEP, D Lite가 유리하면 SIMPLIFY/ON_DEMAND, B Native가 유리하면 ARTIBOT 기능 단위로 축소 검토.
5. 실제 데이터 누락·이상치·서로 다른 도구 접근으로 공정 비교가 불가능하면 INCONCLUSIVE. 임의 개선율 계산 금지.

## 7. 참고 자료

- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/monitoring-usage
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/skills
