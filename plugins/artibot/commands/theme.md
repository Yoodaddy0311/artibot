---
description: (Artibot) 터미널 테마 전환 — 사이버펑크/매트릭스/베이퍼웨이브 (statusline + Windows Terminal + VS Code 터미널 색 + output-style)
argument-hint: '[neon-city|matrix|vaporwave|list|reset]'
allowed-tools: [Read, Bash]
---

# /theme

Artibot 터미널 테마를 전환한다. 한 번에 **4개 표면**을 바꾼다:

1. **statusLine** — 하단바를 테마 팔레트의 truecolor 그라데이션 바로 (시안→마젠타 등)
2. **Windows Terminal 색상** — `ARTIBOT <THEME>` 컬러 스킴 주입 + 전 프로필 적용 (WT 터미널 텍스트 색 변경)
3. **VS Code 통합 터미널 색** — `workbench.colorCustomizations`의 터미널 전경/배경/16 ANSI 색 적용 (VS Code 통합 터미널 텍스트 색 변경, 저장 시 자동 반영)
4. **output-style** — 응답 포맷을 박스아트/네온글리프로 + `settings.outputStyle` 자동 활성화 (적용: `/clear` 또는 새 세션)

> 모든 변경은 백업되며 `/theme reset`으로 4표면 전부 원복된다. truecolor는 최신 터미널(Windows Terminal/iTerm/Konsole)에서만 색이 제대로 나온다. WT/VS Code는 각자 쓰는 환경에만 적용(미발견 시 자동 스킵).

## Arguments

Parse `$ARGUMENTS`:
- (없음) 또는 `list` → 사용 가능한 테마 목록 표시
- `<name>` → 테마 적용 (`neon-city` | `matrix` | `vaporwave`)
- `reset` → 기본 테마로 원복

## 실행 (엔진 호출)

엔진은 `theme-apply.js`이며 **설치 방식에 따라 위치가 다르다**:
- **flat / full install (install.sh)**: `$HOME/.claude/artibot/scripts/theme-apply.js` — 안정 경로(업데이트에도 불변)
- **네이티브 마켓플레이스 install**: 플러그인 캐시 안에만 존재 → `$CLAUDE_PLUGIN_ROOT/scripts/theme-apply.js`

아래 각 Bash 스니펫은 `$HOME` 경로를 우선하고(대부분의 install.sh 사용자), 없으면 `$CLAUDE_PLUGIN_ROOT`로 폴백한다. **주의: `CLAUDE_PLUGIN_ROOT`는 Bash 도구 컨텍스트에서 빈 값일 수 있다**(현 세션에서도 unset 확인됨) — 그래서 각 스니펫은 폴백 뒤 `[ -f ]`로 **한 번 더 가드**하고, 두 경로 모두 없으면 raw 에러 대신 안내 문구를 출력한다. 즉 네이티브 폴백은 셸에 `CLAUDE_PLUGIN_ROOT`가 노출되는 환경에서만 성공하며, 실패하면 `/theme`를 쓰기 위해 **full install(`bash install.sh`)**이 필요하다. (네이티브 전용 설치는 major 업데이트 후 `/theme` 재실행이 필요할 수 있다.)

### `/theme` 또는 `/theme list`
```
Bash: ENGINE="$HOME/.claude/artibot/scripts/theme-apply.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/scripts/theme-apply.js"; if [ -f "$ENGINE" ]; then node "$ENGINE" list; else echo "theme engine not found — run the full install (bash install.sh) to use /theme"; fi
```
출력을 그대로 사용자에게 보여주고, "적용하려면 `/theme neon-city`" 안내. (엔진 미발견 안내가 나오면 그대로 사용자에게 전달.)

### `/theme <name>` (적용)
1. 다음 실행: `Bash: ENGINE="$HOME/.claude/artibot/scripts/theme-apply.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/scripts/theme-apply.js"; if [ -f "$ENGINE" ]; then node "$ENGINE" <name>; else echo "theme engine not found — run the full install (bash install.sh) to use /theme"; fi`
2. 엔진 출력(적용된 표면)을 사용자에게 보여준다. (엔진 미발견 안내가 나오면 그대로 전달.)
3. **반드시 사용자에게 다음 3가지를 안내**:
   - statusLine/색상은 **화면 갱신 또는 Claude Code 재시작 시** 완전 반영
   - output-style은 엔진이 `settings.outputStyle`에 **자동 설정**하므로 별도 수동 선택 불필요 — `/clear` 또는 새 세션부터 즉시 적용
   - 마음에 안 들면 `/theme reset`

### `/theme reset` (원복)
```
Bash: ENGINE="$HOME/.claude/artibot/scripts/theme-apply.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/scripts/theme-apply.js"; if [ -f "$ENGINE" ]; then node "$ENGINE" reset; else echo "theme engine not found — run the full install (bash install.sh) to use /theme"; fi
```
+ "output-style은 엔진이 이전 값(또는 기본)으로 **자동 복원**한다 — 별도 명령 불필요" 안내.

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
