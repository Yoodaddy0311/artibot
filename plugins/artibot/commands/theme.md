---
name: theme
description: (Artibot) 터미널 테마 전환 — 사이버펑크/매트릭스/베이퍼웨이브 (statusline + Windows Terminal 색상 + output-style)
---

# /theme

Artibot 터미널 테마를 전환한다. 한 번에 **3개 표면**을 바꾼다:

1. **statusLine** — 하단바를 테마 팔레트의 truecolor 그라데이션 바로 (시안→마젠타 등)
2. **Windows Terminal 색상** — `ARTIBOT <THEME>` 컬러 스킴 주입 + 전 프로필 적용 (모든 터미널 텍스트 색 변경)
3. **output-style** — 응답 포맷을 박스아트/네온글리프로 (`/output-style`로 활성화)

> 모든 변경은 백업되며 `/theme reset`으로 원복된다. truecolor는 최신 터미널(Windows Terminal/iTerm/Konsole)에서만 색이 제대로 나온다.

## Arguments

Parse `$ARGUMENTS`:
- (없음) 또는 `list` → 사용 가능한 테마 목록 표시
- `<name>` → 테마 적용 (`neon-city` | `matrix` | `vaporwave`)
- `reset` → 기본 테마로 원복

## 실행 (엔진 호출)

엔진은 `$HOME/.claude/artibot/scripts/theme-apply.js`다. **`${CLAUDE_PLUGIN_ROOT}`를 쓰지 마라** (Bash 셸에서 빈 값). 항상 `$HOME` 절대경로로 호출한다.

### `/theme` 또는 `/theme list`
```
Bash: node "$HOME/.claude/artibot/scripts/theme-apply.js" list
```
출력을 그대로 사용자에게 보여주고, "적용하려면 `/theme neon-city`" 안내.

### `/theme <name>` (적용)
1. `Bash: node "$HOME/.claude/artibot/scripts/theme-apply.js" <name>` 실행.
2. 엔진 출력(적용된 3표면)을 사용자에게 보여준다.
3. **반드시 사용자에게 다음 3가지를 안내**:
   - statusLine/색상은 **화면 갱신 또는 Claude Code 재시작 시** 완전 반영
   - output-style은 **사용자가 `/output-style` 실행 후 해당 테마 선택**해야 활성화
   - 마음에 안 들면 `/theme reset`

### `/theme reset` (원복)
```
Bash: node "$HOME/.claude/artibot/scripts/theme-apply.js" reset
```
+ "output-style은 `/output-style default`로 별도 복귀" 안내.

## 테마 (registry.js에 데이터로 정의 — 추가 쉬움)

| name | 무드 | statusLine 그라데이션 |
|------|------|----------------------|
| `neon-city` | 사이버펑크 2077 | 시안 → 마젠타 |
| `matrix` | 해커 그린 코드레인 | 그린 모노크롬 |
| `vaporwave` | 레트로 파스텔 석양 | 핑크 → 퍼플 |

## 제약 / 안전

- Windows Terminal 미설치/미발견 시 → 색상 단계는 자동 스킵(나머지는 적용). 다른 터미널은 컬러 스킴 수동 적용 안내.
- WT settings.json은 적용 전 `settings.json.artibot-backup`으로 백업됨.
- statusLine/colorScheme 이전값은 `runtime/theme-backup.json`에 백업 → `reset`이 복원.
- output-style은 정보 가독성을 해치지 않는다(코드블록·표·file:line은 장식 안 함).

## Next Steps

| # | 액션 | 설명 |
|---|------|------|
| 1 | `/output-style` | 테마 output-style 활성화 (포맷 적용) |
| 2 | `/theme reset` | 기본으로 원복 |
