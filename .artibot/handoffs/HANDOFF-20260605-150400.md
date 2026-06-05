# Handoff: Artibot @ 2026-06-05 15:04 (v4.19.5 릴리즈 완료 — 깃 clean · CI green)

## 1. 지금 상태

| 항목 | 값 |
|------|-----|
| 브랜치 | `master`, **origin 0/0 동기화** |
| HEAD | `0b15dcd` (docs(readme): 112→113 잔여 stale sync) |
| 태그 | **`v4.19.5` 푸시·gh release 생성·CI green** (Release SUCCESS) |
| 작업트리 | clean (`.artibot/SESSION-NOTES.md` 자동본만) |
| 테스트(캐시) | **9,623 pass / 4 skip / 7 known-flaky** (full-suite race, 문서화됨·회귀 아님; 변경영역 격리 시 57/57 green) |
| 릴리즈 | artibot **v4.19.5** + cowork v3.1.0 / 113 skills · 71 commands · 28 agents |

## 2. 최근 커밋 (top 10)

- `0b15dcd` docs(readme): 잔여 112→113 sync
- `a52e421` **chore(release): v4.19.5**
- `e688ffa` fix(hooks): git-autopilot 비파괴 체크포인트 (stash create+store) — 데이터유실 fix
- `ff71a48` docs(orchestration): 용어정합 ultracode/Dynamic Workflows
- `ecb1bc2` feat(security+hooks): ai-security-standards + STRIDE + Stop훅 토글 + marketplace 메타
- `dee6013` chore(session): session notes
- `f54d579` refactor: N4 rate-sentinel 삭제 (-492 LOC)
- `e874c7e` docs(audit): N3 tool-guardrails → dormant-by-documented-design
- `4d4bba0` docs(audit): dead-code 백로그 N1~N6
- `0fa2655` feat(hooks): workflow-status 진행률 배선 + 오케스트레이션 문서

## 3. 진행 중 작업

(없음 — 이번 세션 모든 작업 커밋·푸시 완료. 팀원 9명 idle 대기, 미해체)

## 4. 다음 P0

> **설치본 드리프트 정리** — install.sh가 `lib/`를 복사 안 해 `lib/core/dev-verify-output.js`를 수동 동기화함. 깨끗한 적용은 재설치(`/plugin marketplace add Yoodaddy0311/artibot` — 공식 마켓플레이스 이제 가능) 또는 install.sh에 lib/ 복사 추가.

## 5. 미해결 결정/질문

- **팀 해체 대기** — `team-orch-progress` 9 팀원 idle. 다음 세션 재활용 or "해체".
- **advisory 전역 전환 영향 관측** — Stop훅 DEV-verify 기본을 `advisory`(비차단)로 바꿈(`artibot.config.json#/devProtocol/verifyMode`). 차단 강제가 그리우면 `"enforce"`로 되돌림.
- **install.sh lib/ 미복사 갭** — 런타임이 lib/ 의존하는 훅(dev-verify-output) 추가 시 설치본 누락 위험. install.sh에 `lib/` 복사 스텝 추가 검토.
- **sync-readme-claims 정규식 갭** — "auto-activating domain skills" 표현 미커버로 stale 빠져나감(이번에 수동 fix). 정규식/검증기에 패턴 추가하면 재발 방지.
- **dead-code 백로그 N1/N2/N5/N6** — `.artibot/DEADCODE-BACKLOG-2026-06-05.md`. N1(event-bus dormant seam)·N2(metrics-collector)는 product 결정 사안.
- **진행률 런타임 실관측** — workflow-status `Phase X/6`이 실제 Claude Code 페이로드 task 키로 채워지는지 다음 /team 때 눈으로 확인 필요.

## 6. 권장 첫 프롬프트

1. `install.sh에 lib/ 복사 스텝 추가 + 설치본 전체 재동기화 검증 (dev-verify-output 등 lib 의존 훅이 ~/.claude/artibot/에 반영되는지)` — **P0, 설치본 드리프트 해소**
2. `sync-readme-claims.js + validate-readme-claims.js 정규식에 "auto-activating domain skills" 패턴 추가해 stale 자가치유 강화` — 하드닝, 저위험
3. `dead-code 백로그 N5(handoff-filter) skill/allowlist 재확인 후 안전삭제 or dormant 확정 (.artibot/DEADCODE-BACKLOG-2026-06-05.md)` — 정리

> 다음 세션: `/resume` 로 전체 HANDOFF 복원 + 첫 프롬프트 확인. 단일 진실원: 이 파일 + `.artibot/DEADCODE-BACKLOG-2026-06-05.md` + `.artibot/WIRE-BACKLOG-TRIAGE.md`.
