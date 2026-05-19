---
description: (Artibot) 이전 세션 핸드오프 복원 — 전체 HANDOFF + 첫 프롬프트 후보 표시
argument-hint: '[--run] [--list]'
allowed-tools: [Read, Bash, Grep]
toolset: team
---

# /resume

이전 세션이 `/save` 로 작성한 `.artibot/HANDOFF.md` 를 그대로 stdout 에 출력해 다음 작업을 5초 안에 이어가도록 합니다. 자동 실행은 절대 하지 않으며, `--run` 플래그가 있을 때만 1순위 첫 프롬프트를 확인 프롬프트로 제안합니다 (push/deploy/release/force/delete 키워드는 강제 confirm).

Also routed from: 자연어 "이어가기", "어제 어디까지 했지", "지난 세션 복원", "핸드오프 보여줘"

## Arguments

Parse $ARGUMENTS:
- `--run`: 1순위 첫 프롬프트 후보를 사용자 confirm 후 실행 제안. **자동 실행 없음 — 항상 사용자 승인 필요**
- `--list`: `.artibot/handoffs/` 의 아카이브 목록 (mtime · size · filename) 표시 후 종료
- `--archive <filename>`: 특정 아카이브를 stdout으로 표시 (latest 대신)

## Execution Flow

### `--list` 모드

1. `lib/handoff/handoff-store.js` 의 `listHandoffs(projectRoot)` 호출
2. 반환된 배열을 mtime 내림차순으로 표 출력:
   ```
   | # | 파일명 | mtime | size |
   |---|--------|-------|------|
   ```
3. 종료. 다른 단계 실행 안 함.

### 기본 모드

1. `readLatestHandoff(projectRoot)` 호출
   - 반환 `null` → "핸드오프 없음 — 먼저 `/save` 로 작성하세요." 메시지 + 종료
2. `content` 를 stdout 으로 그대로 출력 (마크다운 원문 보존, ANSI 추가 금지)
3. 마크다운에서 `## 6. 권장 첫 프롬프트` 섹션을 정규식으로 추출:
   - `/^##\s+6\..*권장 첫 프롬프트.*$([\s\S]*?)(?=^##\s|\Z)/m`
   - 1~3 번 항목을 박스로 강조 출력
4. `--run` 플래그가 있을 때만 Step 5 진행. 아니면 안내만 출력 후 종료.

### `--run` 안전 가드

1. 1순위 prompt 텍스트를 추출
2. 다음 sensitive 키워드 검출 (대소문자 무관, regex `\b(push|deploy|release|force|delete|rm|reset)\b`):
   - push, deploy, release, force, delete, rm, reset
3. **검출 시 강제 confirm**: 키워드를 빨간색으로 강조 + "이 액션은 destructive 입니다. 진행할까요? (y/N)" — 기본 N
4. **검출 안 됨**: 일반 confirm — "1번 프롬프트를 실행하시겠습니까? (y/N)" — 기본 N
5. 사용자 응답 `y/Y/yes` 외에는 모두 거부로 처리 → "사용자 거부 — 종료" 출력 후 종료
6. 승인 시: prompt 텍스트를 Claude에게 다음 message 로 전달 — **자동 Bash 실행 절대 없음**

## Output Format

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  HANDOFF RESUMED                                        YYYY-MM-DD HH:MM    │
│  source: .artibot/HANDOFF.md (saved Nh ago)                                 │
└──────────────────────────────────────────────────────────────────────────────┘

[전체 핸드오프 마크다운 원문]

┌─────────────────────────────────────────────────────────────────────────────┐
│  권장 첫 프롬프트                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. [prompt 1] — [rationale]                                                │
│  2. [prompt 2] — [rationale]                                                │
│  3. [prompt 3] — [rationale]                                                │
└─────────────────────────────────────────────────────────────────────────────┘

> 위 후보 중 하나를 메시지로 입력하면 이어집니다. `--run` 으로 1번을 confirm 실행할 수 있습니다.
```

## `--list` 출력

```
| # | 파일명 | mtime | size |
|---|--------|-------|------|
| 1 | HANDOFF-20260519-114433.md | 2026-05-19 11:44 | 8.2 KB |
| 2 | HANDOFF-20260518-220112.md | 2026-05-18 22:01 | 9.1 KB |
| ... |
```

## Anti-Patterns

- Do NOT 첫 프롬프트를 자동 실행하지 말 것 — `--run` 도 사용자 confirm 필수
- Do NOT push/deploy/release/force/delete/rm/reset 키워드가 포함된 프롬프트를 사용자 명시적 승인 없이 진행하지 말 것
- Do NOT 핸드오프 마크다운을 수정하거나 ANSI 색상을 추가하지 말 것 — 원문 보존
- Do NOT 핸드오프 부재 시 빈 출력으로 종료하지 말 것 — 항상 `/save` 권장 메시지 출력
- Do NOT advisor 신호를 `/resume` 에서 마킹하지 말 것 — `/save` 의 책임 (`/resume` 은 read-only)

## Edge Cases

| 시나리오 | 처리 |
|----------|------|
| 핸드오프 파일 없음 | "핸드오프 없음 — `/save` 로 먼저 작성하세요." + 종료 |
| 마크다운 파싱 실패 | 원문만 출력, "권장 첫 프롬프트" 섹션 스킵 + 경고 |
| 권장 프롬프트 섹션 비어있음 | "다음 액션 자유 입력" 박스로 대체 |
| `--archive <filename>` 미존재 | "아카이브 없음 — `--list` 로 확인하세요." + 종료 |
| `--run` 키워드 검출 + 사용자 N | "사용자 거부 — 종료" 출력 후 종료 (실행 안 함) |
| `.artibot/HANDOFF.md` size 0 | 빈 핸드오프 경고 + `/save` 권장 |

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 새 핸드오프 저장 | `/save` | 이번 세션 진행 후 다음 세션용 핸드오프 작성 |
| 2 | 아카이브 목록 | `/resume --list` | 과거 핸드오프 비교 |
| 3 | 작업 상태 | `/task` | TaskList 기반 현재 작업 확인 |
