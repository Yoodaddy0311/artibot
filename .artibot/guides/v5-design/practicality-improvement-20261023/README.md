# ARTIBOT 실용성 검증 및 개선 설계 (2026-10-23)

> **상태: 05 의 코드 Wave 1~4 구현 착지(2026-10-23, 브랜치 `claude/jolly-newton-qmi4eb`) / 실험 Wave 5~6 과 라이브 분모는 NOT MEASURED** — 2026-10-23 검증 보고(04)와 개정 설계안(05) 추가. 01·02 와 05 가 어긋나면 05 가 이긴다(05 §0 정정표). 원문 01~03 은 보존. 구현 기록은 05 §8.
> **대상:** ARTIBOT v4.71.11, 기준 커밋 6149446eb5fc88d0537f07cb04010ba5ce4aa2a1
> **목표:** 순정 Claude Code와 비교하여 독립 검증 성공률, 성공당 비용, 실행시간, 사람 개입을 실제로 개선하는 최소 하네스 확립
> **주의:** 이 폴더는 설계 문서일 뿐이다. 운영 코드, 설정, 배포, 테스트 결과, v5 진행률을 변경하지 않는다.

## 문서 목차

1. [01_IMPLEMENTATION_DESIGN.md](01_IMPLEMENTATION_DESIGN.md) — 확인된 결함, 18개 개선 항목, 최소 구조, 수정 계약 및 단계별 실행
2. [02_BASELINE_ROI_PROTOCOL.md](02_BASELINE_ROI_PROTOCOL.md) — ARTIBOT 미사용 기준선, 4군 A/B/C/D, 공격 실험, 토큰·비용·ROI 산식
3. [03_IMPLEMENTATION_HANDOFF.md](03_IMPLEMENTATION_HANDOFF.md) — Claude Code/Codex/Dot을 위한 읽기·구현·검수 인수인계 명세
4. [04_VALIDATION_REPORT.md](04_VALIDATION_REPORT.md) — 01~03 의 주장을 소스·호스트 문서·격리 재현(EXP-A~D, API 호출 0)으로 대조한 검증 보고. 판정표·D0~D6 연결성 감사표·재현 스크립트·미확인 목록
5. [05_REVISED_DESIGN.md](05_REVISED_DESIGN.md) — 검증을 통과한 것만 기존 부품 위에 다시 설계한 개정판. 정정표·D-01~D-07·P1/P2 처분표·실험 매니페스트·Wave 재편·오너 결정 항목
6. [06_PIPELINE_AUDIT.md](06_PIPELINE_AUDIT.md) — 구현 뒤 파이프라인·토큰 점검(API 호출 0): 매 요청 고정 컨텍스트 세(≈22K 토큰)와 티어별 비용, 도구 호출당 훅 프로세스 수·지연, 스킬 활성화 시 전체 테스트 실행(확정), 10-04 감사의 미착지 NECESSARY 3건, 끊긴 배선 감사의 한계, 오픈소스 비교, 유무 차이 중 지금 말할 수 있는 것
7. [07_PC_HANDOFF.md](07_PC_HANDOFF.md) — 클라우드 세션이 못 한 것의 인수인계: PC 에서 돌릴 것(라이브 분모 3종·호스트 통합 테스트·Windows·훅 지연 실측), 오너 결정 8건, 비교 실험 절차, 다음 클라우드 세션을 위한 환경 설정. 러너 `pc-handoff.mjs`(check · census · tests · host-probe · experiment-plan — 인자 없이 돌리면 점검 + 다음 순서 + 새 세션용 킥오프 프롬프트, 07 §0)

## 이 설계가 기존 문서와 갖는 관계

- 기존 [ARTIBOT-5.0-DESIGN](../ARTIBOT-5.0-DESIGN.md), [V5-BACKLOG](../V5-BACKLOG.md), [MEASUREMENT-RUNBOOK](../MEASUREMENT-RUNBOOK.md)을 **수정하거나 대체하지 않는다**.
- 본 문서의 IMP-01~18은 **독립적인 개선 제안 ID**이며, V5-BACKLOG의 항목 완료 상태에 합산하지 않는다.
- 기존 설계에서 명시한 원칙(한 가지 정본, Evidence First, Observe → Shadow → Canary → GA, 사람 승인 게이트, worktree/세션 상태 격리)을 유지한다.
- 구현자는 설계에 인용된 기준 SHA와 실제 체크아웃을 대조한다. 이미 수정된 문제는 중복 구현하지 않는다.
- 2026-10-23 검증 결과(04): IMP-01~05 는 격리 재현으로 확인된 실제 단절, IMP-06 은 이미 구현(`lib/economics/usage-receipt.js`), IMP-08 은 이미 측정·결정(NEXT-SESSION 2026-10-20), IMP-16·17 은 기존 설계 문서와 중복. 02 §4 의 attempt 레코드는 기존 `usage.receipt` 스키마와 겹쳐 05 §4 의 실험 매니페스트 + 원장 조인으로 대체한다.
- 2026-10-23까지의 코드 점검을 토대로 한 *가설/제안*을 포함한다. 사용자 PC의 실사용 A/B 결과는 아직 없다.

## 최우선 목표

**ARTIBOT을 사용하지 않는 Native Project(B)보다 독립 검증 성공률을 높이거나 유지하면서, 검증 성공 1건당 총 비용·사람 개입·지연을 줄인다.** 비교 데이터가 없으면 우월·절감이라고 판정하지 않는다.

## 변경 전 필수 승인

별도 PR에서만 소스 수정. 차단 규칙 시행, 안전정책 변경, 기능 삭제, 기본 모델 라우팅 변경, 전역 사용자 설정 변경, 실제 배포/병합은 별도 검증 및 승인 대상. 실험은 비밀·운영 서비스 접근이 없는 격리 환경에서 수행한다.
