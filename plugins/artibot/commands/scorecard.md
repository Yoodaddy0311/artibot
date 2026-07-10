---
description: (Artibot) 기능 완성도 스코어카드 — 기능 영역을 도출해 file:line 증거와 함께 0~100 채점하고 스냅샷 저장, 작업 전후를 "작업 전·작업 후·상승폭·남은 갭" 표로 비교. 트리거 "기능 완성도", "얼마나 남았", "진행률 스코어카드", "작업 전후 비교", "기능별 점수", "완성도 평가", "feature scorecard"
argument-hint: '[--baseline|--diff|--areas <n>]'
allowed-tools: [Read, Bash, Grep, Glob]
---

# /scorecard

기능/프로젝트를 **영역별로 file:line 증거와 함께 0~100 채점**하고 스냅샷으로 남긴다. 작업 후 다시 채점하면 **작업 전 → 작업 후 → 상승폭 → 남은 갭**을 표로 보여준다. 핵심 원칙: **증거 없는 점수 금지** — 근거(구현 위치·테스트 수·통과 여부)가 없으면 그 영역은 `unverified`로 정직하게 표기된다(점수를 숨기지 않되 미검증임을 드러냄).

엔진: `lib/planning/scorecard.js` (순수/불변, 단일 `.artibot/scorecard.json`에 스냅샷 append). 외부 전송 없음 — 로컬 파일만.

## Arguments

`$ARGUMENTS` 파싱:
- (없음) 또는 `--baseline` → 기능 영역 채점 후 새 스냅샷 저장(첫 실행은 baseline).
- `--diff` → 최신 두 스냅샷을 작업 전후 표로 비교.
- `--areas <n>` → 도출할 영역 개수 힌트(기본 3~8 자동).

## 워크플로우 (커맨드가 수행)

### 채점 (기본 / `--baseline`)
1. **영역 도출** — PRD/docs/라우트/모듈 구조에서 기능 영역을 3~8개 추출한다(예: 자막 추출·프레임 캡처·요약·에러 처리). 코드 대상이면 Grep/Glob/Read로 실제 구조를 먼저 파악한다. (분해 철학은 `/blindspot`과 동일 — 큰 덩어리를 쪼개 빠뜨림을 줄인다.)
2. **증거 채점** — 각 영역마다 **file:line 하드 증거를 수집**해 0~100 부여:
   - 구현 존재 여부(모듈/함수 위치), 테스트 수·통과 여부, TODO 밀도, 실제 검증 여부.
   - 예: `자막 추출 = 90 (watch-ingest.js:120 vtt 파싱 + 테스트 6개 통과)`.
   - **증거를 못 찾으면 evidence를 빈 배열로 두라** — 엔진이 `unverified`로 표기한다(거짓 점수보다 정직 표기).
3. **스냅샷 저장** — `{label, areas}` JSON을 **stdin으로** 엔진 CLI `add`에 넘긴다:
```
Bash: ENGINE="$HOME/.claude/artibot/lib/planning/scorecard.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/lib/planning/scorecard.js"; if [ -f "$ENGINE" ]; then echo '<payload-json>' | node "$ENGINE" add; else echo "scorecard engine not found — run the full install (bash install.sh)"; fi
```
   `<payload-json>` = `{"label":"작업 전","areas":[{"name":"자막 추출","score":90,"evidence":[{"file":"watch-ingest.js:120","note":"vtt 파싱"}]},{"name":"프레임","score":0,"evidence":[]}]}` (한 줄 JSON). 엔진이 표를 렌더한다(첫 실행=baseline, 이후=직전 스냅샷과 diff).
4. 렌더된 표를 사용자에게 보여주고, "작업 후 다시 `/scorecard`로 채점하면 상승폭을 볼 수 있어요" 안내.

### 전후 비교 (`--diff`)
엔진 CLI `diff`가 **최신 2개** 스냅샷을 `diffSnapshots`→`renderScorecard`로 표 렌더한다. 특정 두 스냅샷을 지정하려면 `--from <label> --to <label>`. 스냅샷이 2개 미만이면 안내 메시지("비교하려면 스냅샷 2개가 필요합니다 — 현재 N개.").
```
Bash: ENGINE="$HOME/.claude/artibot/lib/planning/scorecard.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/lib/planning/scorecard.js"; if [ -f "$ENGINE" ]; then node "$ENGINE" diff; else echo "scorecard engine not found — run the full install (bash install.sh)"; fi
```
특정 쌍 비교: `node "$ENGINE" diff --from "작업 전" --to "작업 후"`.
출력 표: `| 평가 항목 | 작업 전 | 작업 후 | 상승폭 | 남은 갭 |` — 남은 갭 열은 `▰▱` 게이지(작업 후 점수 기준 채움) + 남은 점수. 신규 영역은 작업 전 `—`, `unverified` 영역은 항목명에 `*` + 각주.

### 목록 (`list`)
```
Bash: ENGINE="$HOME/.claude/artibot/lib/planning/scorecard.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/lib/planning/scorecard.js"; if [ -f "$ENGINE" ]; then node "$ENGINE" list; else echo "scorecard engine not found — run the full install (bash install.sh)"; fi
```

## 출력

- **터미널(TTY)**: 활성 테마 팔레트로 NEON THEMED 렌더 — 고정폭 정렬 + primary→accent truecolor 그라데이션 게이지 + ▲그린/▼레드 델타 + `평균` 요약. 테마는 `current-theme.json`(부재 시 neon-city).
- **파이프/리다이렉트(비-TTY)**: Claude가 파싱하는 GFM 파이프 표를 그대로 유지 — 자동 감지(`process.stdout.isTTY`).

## 제약 / 안전

- **증거 우선**: evidence 배열이 비면 그 영역은 `unverified`로 표기된다(점수는 저장하되 근거 없음을 드러냄 — claim-honesty).
- 점수는 0~100으로 clamp. 스냅샷은 단일 `.artibot/scorecard.json`에 **append**(비파괴 — 기존 스냅샷 보존).
- 모든 산출물은 로컬 `.artibot/`에만 저장. 외부 API·업로드 없음.
- 동적 import 시 Korean-path 주의(`plan.md`의 toFileUrl/pluginRoot 패턴 참조) — 위 스니펫은 `node <path>` 직접 실행이라 해당 없음.

## Next Steps

| # | 액션 | 설명 |
|---|------|------|
| 1 | `/scorecard --diff` | 이전 스냅샷과 상승폭 비교 |
| 2 | `/scorecard` | 개선 작업 후 재채점 |
