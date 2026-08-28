# /split 실오퍼레이터 런 리포트 — split-8f83d7

**런 1호.** `/split` 의 첫 실오퍼레이터(사람이 창을 연) 완주 기록이다. n=1 — 이 문서는
존재 증명이지 성능 주장이 아니다. `/split` vs `/autopilot --fast` 속도 비교는 이 데이터로
주장할 수 없다.

| 항목 | 값 |
|---|---|
| runId | `split-8f83d7` |
| 실행일 | 2026-08-27 (10:16–13:23 UTC) |
| 줄기 | 2건 — `plan-state`(artifacts.js 분리 + 직접 import 테스트), `sid-anchor`(판별자 게이트 `*` 앵커링) |
| 랜딩 | 배치 커밋 `41f7f7e9` (fold: `5ce6ca39` [1/2] plan-state, `41f7f7e9` [2/2] sid-anchor), rebuilds=0 |
| 이슈 | #112 닫힘(2026-08-27T13:27:08Z, sid-anchor 줄기가 해소) · #113 은 본 리포트 랜딩 직전 커밋에서 처방 (b)(죽은 `lib/context` 모듈 삭제 + session-start `getStatePath` 정본화)로 처리 — 런 시점(2026-08-27)에는 OPEN 이었다 |
| 후속 랜딩 | `2e6c123f` — 런이 발굴한 라이브 결함 수정(아래) |
| 증거 원본 | `reports/SPLIT/split-8f83d7.events.ndjson` (15이벤트, 캐시 `~/.claude/plugins/cache/artibot/artibot/4.50.0/runtime/split/` 에서 복사) |

## 실측 수치 (ndjson 재계산, 2026-08-28 판독)

이벤트 15건, wall-clock 세그먼트 3쌍·phase 4쌍 전부 닫힘 — **미쌍 0건**.
마지막 이벤트 ts `2026-08-27T13:23:39.372Z`.

| 세그먼트 | 시작 → 끝 (UTC) | 소요 |
|---|---|---|
| `run` (전체) | 10:16:16.663 → 13:23:39.372 | **11,242,709ms** (3h07m23s) |
| `open-windows` (humanWait) | 10:16:46.726 → 10:40:35.950 | 1,429,224ms (23m49s) |
| `confirm-integrate` (humanWait) | 11:11:46.951 → 13:17:16.143 | **7,529,192ms (2h05m29s)** |

- humanWait 합계 = 8,958,416ms / run 11,242,709ms = **79.68% ≈ 79.7%**
- phase: PLAN(0.1s, plannedParallelism 2, fallbackReason null) → OPEN(23m49s) →
  DISPATCH(32s, **refused**) → INTEGRATE(6m23s, `landed 41f7f7e9 rebuilds=0`)

## humanWait 79.7% — 재평가 임계 초과이나 해석 주의

`config.split.humanWaitReevalPct` = 50 대비 **초과**(79.7%). 그러나 humanWait 의 84%
(7,529,192 / 8,958,416ms)가 `confirm-integrate` 한 구간이고, 그 2h05m 은 통합 확인
프롬프트가 뜬 채 **사용자가 자리에 없던** 시간이 지배한다 — 절차가 사람 손을 그만큼
요구했다는 뜻이 아니다. C단계(headless 창) 재평가의 근거로 쓰려면 사용자 재석 상태의
런이 더 필요하다. 판정은 사람 몫이다(플러그인은 기록만 한다 — record-only 게이트).

## 런이 발굴한 라이브 결함 — 세션 매칭 대소문자

DISPATCH phase 가 `refused: session-name case mismatch (split-Artibot-* vs split-artibot-*)
— fail-closed, 0 sent` 로 종료(10:42:06). worktree 이름은 리포 원문 케이스를 보존하는데
하네스가 세션 이름을 소문자화해 `matchingSessions` 민감 대조가 열린 창을 전부 "미개설"로
판정했다. fail-closed 설계 덕에 오배달 없이 거부로 표면화 → `2e6c123f` 로 수정(`i` 플래그
+ 회귀 3건). 이 런에서 dispatch 는 끝까지 성공하지 않았고(성공 DISPATCH 이벤트 없음),
줄기 창은 브리프 파일 경로로 진행했다 — "브리프가 정본, 메시지는 최적화" 설계의 실증.

## 한계 (이 리포트가 증명하지 않는 것)

- `/split` vs `-fast` 속도 우열 — n=1, 대조군 0.
- humanWait 79.7% 의 일반성 — 사용자 부재가 지배한 단일 표본.
- dispatch 성공 경로 — 이 런에서는 refused 만 관측됐다(수정 2e6c123f 의 라이브 검증은 다음 런).
