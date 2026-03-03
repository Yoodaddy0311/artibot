---
description: (Artibot) Claude Code 권한(permission) 설정 관리 — auto-yes 토글, 허용 도구 관리, 현재 상태 조회
argument-hint: '[action] e.g. "auto-yes", "status", "reset"'
allowed-tools: [Read, Write, Edit, Bash, Glob]
---

# /permissions

Claude Code의 도구 실행 권한(permission)을 관리합니다. 매번 승인 프롬프트를 받을지, 자동 승인할지 설정합니다.

## Arguments

Parse $ARGUMENTS:
- `action`: 수행할 작업 (아래 Actions 참조)
- `--scope [global|project]`: 설정 범위 (기본: global)
- `--save-memory`: 설정 변경 후 자동 메모리 저장 (기본: true)

## Actions

### `status` (기본)
현재 권한 설정을 표시합니다.

```
/permissions status
```

1. `~/.claude/settings.json` 읽기
2. `allowedTools` 목록 표시
3. 현재 모드 판별 (manual / auto-yes / selective)

출력:
```
📋 Claude Code 권한 설정

모드: manual (매번 승인 필요)
허용된 도구: 없음

사용 가능한 설정:
- /permissions auto-yes    → 모든 도구 자동 승인
- /permissions selective   → 안전한 도구만 자동 승인
- /permissions manual      → 매번 수동 승인 (기본)
```

### `auto-yes`
모든 도구 실행을 자동 승인합니다.

```
/permissions auto-yes
```

1. `~/.claude/settings.json` 읽기
2. `allowedTools` 배열에 모든 도구 추가:
   ```json
   {
     "allowedTools": [
       "Read", "Write", "Edit", "Bash", "Glob", "Grep",
       "WebFetch", "WebSearch", "Agent", "NotebookEdit"
     ]
   }
   ```
3. 메모리에 설정 저장
4. 확인 메시지 출력

### `selective`
안전한 읽기 전용 도구만 자동 승인합니다.

```
/permissions selective
```

허용 도구:
```json
{
  "allowedTools": ["Read", "Glob", "Grep", "WebSearch"]
}
```

### `manual`
모든 자동 승인을 제거합니다 (기본 상태로 복원).

```
/permissions manual
```

1. `allowedTools` 배열을 빈 배열로 설정
2. 메모리에 설정 저장

### `add [tool]`
특정 도구만 자동 승인에 추가합니다.

```
/permissions add Bash
/permissions add "Bash,Write,Edit"
```

### `remove [tool]`
특정 도구를 자동 승인에서 제거합니다.

```
/permissions remove Bash
```

## Execution Flow

### Step 1: 현재 설정 읽기
```
settings_path = ~/.claude/settings.json
Read(settings_path) → current settings
```

### Step 2: 설정 변경
```
action에 따라 allowedTools 배열 수정
Edit(settings_path) → updated settings
```

### Step 3: 메모리 저장 (--save-memory)
설정 변경 후 자동으로 Artibot 메모리에 저장:
```
memory_path = ~/.claude/projects/{project-hash}/memory/MEMORY.md
```

메모리에 기록할 내용:
```markdown
## User Preferences
- Permission mode: auto-yes / selective / manual
- Allowed tools: [list]
- Changed at: {timestamp}
```

### Step 4: 확인 출력
```
✅ 권한 설정 변경 완료

모드: auto-yes
허용된 도구: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Agent, NotebookEdit

💾 메모리에 저장됨
```

## Available Tools

| 도구 | 위험도 | 설명 |
|------|:------:|------|
| Read | LOW | 파일 읽기 |
| Glob | LOW | 파일 검색 |
| Grep | LOW | 텍스트 검색 |
| WebSearch | LOW | 웹 검색 |
| WebFetch | LOW | URL 내용 가져오기 |
| Write | MEDIUM | 파일 생성/덮어쓰기 |
| Edit | MEDIUM | 파일 수정 |
| NotebookEdit | MEDIUM | Jupyter 노트북 수정 |
| Agent | MEDIUM | 서브에이전트 실행 |
| Bash | HIGH | 셸 명령 실행 |

## Wildcard Permission Patterns

Claude Code는 도구별 와일드카드 패턴을 지원합니다. `allowedTools` 배열에 `Tool:pattern` 형식으로 세밀한 권한 제어가 가능합니다.

### 형식

```
"Tool:glob-pattern"
```

- `Tool` — 도구 이름 (Edit, Bash, Write 등)
- `glob-pattern` — 파일 경로 또는 명령어 매칭 패턴

### 파일 경로 와일드카드 (Edit, Write, Read)

```json
{
  "allowedTools": [
    "Edit:src/**",
    "Edit:tests/**",
    "Write:src/**/*.ts",
    "Read:*"
  ]
}
```

| 패턴 | 의미 |
|------|------|
| `Edit:src/**` | src/ 하위 모든 파일 편집 허용 |
| `Edit:tests/**` | tests/ 하위 모든 파일 편집 허용 |
| `Write:src/**/*.ts` | src/ 하위 .ts 파일만 생성 허용 |
| `Read:*` | 모든 파일 읽기 허용 |
| `Edit:!node_modules/**` | node_modules 제외 |

### 명령어 와일드카드 (Bash)

```json
{
  "allowedTools": [
    "Bash:npm *",
    "Bash:node *",
    "Bash:git *",
    "Bash:npx vitest*"
  ]
}
```

| 패턴 | 의미 |
|------|------|
| `Bash:npm *` | npm 명령만 허용 |
| `Bash:node *` | node 실행만 허용 |
| `Bash:git *` | git 명령만 허용 |
| `Bash:npx vitest*` | vitest 실행만 허용 |

### 일반적인 조합 예시

**개발 환경 (권장)**:
```json
{
  "allowedTools": [
    "Read:*",
    "Edit:src/**",
    "Edit:tests/**",
    "Write:src/**",
    "Bash:npm *",
    "Bash:node *",
    "Bash:git status",
    "Bash:git diff*",
    "Glob",
    "Grep"
  ]
}
```

**읽기 전용 분석**:
```json
{
  "allowedTools": [
    "Read:*",
    "Glob",
    "Grep",
    "Bash:git log*",
    "Bash:git diff*"
  ]
}
```

**CI/CD 환경**:
```json
{
  "allowedTools": [
    "Read:*",
    "Bash:npm test",
    "Bash:npm run lint",
    "Bash:npm run build",
    "Glob",
    "Grep"
  ]
}
```

> **참고**: 와일드카드 패턴은 Claude Code가 네이티브로 처리합니다. Artibot은 패턴을 설정 파일에 기록할 뿐, 실제 매칭은 Claude Code 런타임이 수행합니다.

## Safety Notes

- `auto-yes`는 **Bash 포함** — 신뢰할 수 있는 환경에서만 사용
- `selective`는 읽기 전용 도구만 승인 — 안전한 기본 선택
- 프로덕션 환경에서는 `manual` 또는 `selective` 권장
- 설정은 `~/.claude/settings.json`에 저장되어 모든 세션에 적용
- 와일드카드 패턴으로 최소 권한 원칙(Principle of Least Privilege) 적용 권장
