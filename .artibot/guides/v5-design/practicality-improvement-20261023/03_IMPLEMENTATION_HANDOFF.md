# 03. 실행 담당 AI에게 전달할 설계 인수인계

**현재 상태:** 설계안만 Git 추적. 원본 소스 수정이나 A/B 실제 실행은 미승인·미실시.
**기준 소스:** master@6149446eb5fc88d0537f07cb04010ba5ce4aa2a1. 시작 전에 최신 SHA와 diff를 재확인.

## 임무

ARTIBOT이 Native Project Claude Code보다 **검증된 업무 품질과 성공당 비용**에서 의미 있는 이득을 주는지 밝히고, 증명된 기능만 기본 실행하도록 개선한다. 다른 프레임워크를 더 설치하거나 대규모 재설계하는 것이 목적이 아니다.

## Step 0 — 아무 코드도 바꾸지 말고 관측

1. ../ARTIBOT-5.0-DESIGN.md, ../V5-BACKLOG.md, ../MEASUREMENT-RUNBOOK.md 및 본 폴더 01/02 문서를 읽는다.
2. 사용자의 실제 checkout SHA, 설치 방식, CLI 버전, hooks.json, dispatch-table, rules/CLAUDE.md 로드상태를 증거로 기록한다.
3. 설계 근거 파일별 함수의 호출처와 실제 producer → serializer → consumer → 호스트 적용 흐름을 추적한다.
4. 코드 단위 테스트와 별도 프로세스·host 통합 실험을 구분하고, 재현하지 못한 우려는 UNCONFIRMED로 남긴다.
5. baseline 입력/출력 집계와 테스트 목표를 작업 전 확정한다. 사용자 실제 홈 디렉터리와 인증 프로필을 테스트에 재사용하지 않는다.

## Step 1 — 최소 수정 제안(별도 PR)

- P0 순서: IMP-03 raw receipt → IMP-01 scoped durable loop → IMP-02 host-visible warning/deny → IMP-04 verification evidence → IMP-05 config read state → IMP-06 usage truth → IMP-07 fair isolation.
- 선행 테스트를 RED로 만들고 1개 파일/모듈씩 수정·GREEN/회귀를 증명한다.
- OBSERVE ONLY를 기본값으로 유지한다. enforce/auto routing/human gate/permission 변경은 문서상 확인과 사용자 승인 전 기본 ON 금지.
- native API/호스트 기능이 이미 있으면 중복 구현하지 않는다.
- 분기 종료 때 source diff, evidence_uri, 반례 시험, rollback, 독립 검수 결과를 제시한다.
- 모든 결과가 없으면 DONE 대신 BLOCKED/PARTIAL을 표시한다.

## Step 2 — 실용성 테스트

- 02_BASELINE_ROI_PROTOCOL.md 4군 기준선으로 동일 업무를 시험한다.
- 테스트 코드·과제·숨겨진 acceptance 기준을 모델 실행 전에 고정한다.
- 실제 usage/hook/agent 로그의 수집·중복 배제 provenance를 제공한다.
- 누락된 비용/토큰/기간을 임의 0으로 채우지 않는다.
- 자체 평가자의 PASS만으로 성공을 확정하지 않고 독립 검수자와 고정 테스트를 사용한다.

## Step 3 — 릴리스·범위 통제

- 기존 V5-BACKLOG 상태·진행률을 이 설계의 IMP 항목으로 덮지 않는다. 관련된 기존 항목과 매핑만 제안한다.
- 한 번에 모든 기본 설정을 바꾸지 않는다. Observe → Shadow → Canary → GA, kill-switch, 단계별 증거를 유지한다.
- 사용자 허가 없이 실제 운영 프로필, 인증, 배포, 원격 푸시, 보호 브랜치 병합, 데이터 삭제 작업을 수행하지 않는다.
- 사람 의사결정이 필요한 고위험 동작은 PAUSE + 근거 기록.
- 격리 상태에서도 위험 신호(권한 우회, 비밀 유출, 거짓 검증 완료)가 나면 실험 중단.

## 최종 산출물 계약

1. 소스 경로/함수/실제 관측 증거가 연결된 연결성 감사표(D0 Code → D1 Registered → D2 Triggered → D3 Output → D4 Consumed → D5 Behavior → D6 Verified Value).
2. IMP-01~18의 KEEP/FIX/MERGE/ON_DEMAND/EXPERIMENTAL/REMOVE 판정. 반증 전 REMOVE 금지.
3. 업무별 B/C/D 비교: 성공/분모, cost per verified pass, 월 ROI 시나리오, 사람 개입, 지연, 오류, 표본 수.
4. 변경 PR(필요한 경우), 실호스트/CI 증거, 비수정 영역, rollback 방법.
5. '실제로 완료된 것'과 '설계/미측정/재현 못한 것' 명확한 분리.
