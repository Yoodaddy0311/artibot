---
context: fork
disable-model-invocation: true
name: session-worklog
description: "Automatic session work journal maintained in auto-memory. Records tasks, decisions, and pending items at session end or after significant work blocks. Use when logging completed work, recording decisions, or preserving session context for recovery."
lang: [en]
level: 2
triggers:
  - "worklog"
  - "session log"
  - "작업 기록"
  - "세션 로그"
  - "기록"
tokens: "~500"
category: "workflow"
agents: [orchestrator, doc-updater]
platforms: [claude-code, gemini-cli, codex-cli, cursor]
source_hash: 0b7b471e
whenNotToUse: "Mid-task execution where logging would interrupt flow; do not invoke during active problem-solving — reserve for session boundaries and natural breakpoints."
---

# Session Worklog

Lightweight, auto-maintained work journal that persists across sessions.

## When This Skill Applies
- After completing a significant block of work (commit, feature, fix, config change)
- Before a session ends or context compresses
- When the user explicitly asks to log work
- Automatically triggered by commit/push operations

## Worklog Location

```
~/.claude/projects/<project-slug>/memory/worklog.md
```

This file is in the auto-memory directory, so it:
- Persists across sessions
- Is automatically loaded at session start
- Provides immediate context recovery

## Entry Format (STRICT)

Each session entry follows this exact format. Keep entries concise — goal is ~10-15 lines per session.

```markdown
## YYYY-MM-DD | [1-line summary of main work]

### 작업
- [completed task 1]
- [completed task 2]

### 결정
- [decision]: [rationale in 1 phrase]

### 보류
- [pending item or blocker, if any]
- (없음) if nothing pending

---
```

## Rules

### Auto-Append Trigger
Append a worklog entry when ANY of these occur:
1. User requests a commit or push
2. A major feature/fix/change is completed
3. The session is ending (context approaching limit)
4. User explicitly says "기록해" or "log this"

### Size Management
- **Max entries**: 10 sessions
- **Max lines**: 200 lines total
- **Auto-trim**: When appending would exceed 200 lines, remove the OLDEST entry (top of file) first
- **Header preserved**: The `# Session Worklog` header and description line are NEVER deleted

### Content Rules
- **Concise**: Each bullet = 1 line, no paragraphs
- **Factual**: What was done, not how or why in detail
- **Decisions with rationale**: Brief "because" after each decision
- **File counts, not file lists**: "23 agent files updated" not listing all 23
- **Korean preferred**: Match user's communication language

### Token Budget
- **Writing entry**: ~300-500 tokens (reading file + appending)
- **Reading at session start**: ~200 tokens (file is small)
- **Total per session**: ~500-700 tokens maximum

## Example Entries

```markdown
## 2026-02-27 | 모델 정책 opus 중심 재편 + 워크플로우 개선

### 작업
- 모델 정책: haiku 제거, opus 73%(19개) / sonnet 27%(7개)
- DEV 프로토콜 도입 (sc, implement, improve, build)
- vibe-coding 스킬 신규 생성

### 결정
- e2e-runner opus 승격: 테스트 품질 중요
- 문서화 방식: Session Worklog 채택 (자동+경량)

### 보류
- (없음)

---

## 2026-02-26 | Sprint 7 마무리 + 스킬 레퍼런스

### 작업
- 49 professional reference files 추가 (24 marketing skills)
- 깨진 스킬 참조 45개 제거, 23 빈 디렉토리 삭제
- ESLint 0 errors 0 warnings 달성

### 결정
- 레퍼런스 아키텍처: 45-75줄 3티어 구조 (원칙→테이블→체크리스트)

### 보류
- (없음)

---
```

## Output Template

```
## YYYY-MM-DD | [1-line summary of main work]

### 작업
- [completed task 1]
- [completed task 2]

### 결정
- [decision]: [rationale in 1 phrase]

### 보류
- [pending item or blocker]
- (없음) if nothing pending

---
```

## Output Template

```
## YYYY-MM-DD | [1-line summary of main work]

### Tasks
- [completed task 1]
- [completed task 2]
- [completed task 3]

### Decisions
- [decision]: [rationale in 1 phrase]
- [decision]: [rationale]

### Pending
- [pending item or blocker]
- (none) if nothing pending

### Retrospective (optional - on significant sessions)

START (new practices to adopt):
  - [practice to adopt]

STOP (practices to discontinue):
  - [practice to stop]

CONTINUE (practices working well):
  - [practice working well]

### Session Metrics (optional)
- Files changed: [n]
- Tests added: [n]
- Coverage delta: [+/-n%]
- Duration: ~[n]h
```


## Integration with Other Skills

- **checkpoint**: `/checkpoint` creates a detailed snapshot; worklog creates a lightweight summary
- **continuous-learning**: Worklog entries can feed pattern extraction
- **vibe-coding**: After DEV protocol completion, auto-append worklog if significant work done
- **git-unified (workflow)**: Commit/push triggers worklog append (see `references/workflow.md`)

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Detect trigger (commit, feature complete, session end, explicit request)
- [ ] Step 2: Read existing worklog.md
- [ ] Step 3: Compose entry (작업/결정/보류 sections, ~10-15 lines)
- [ ] Step 4: Check size limit (max 200 lines, 10 entries)
- [ ] Step 5: Auto-trim oldest entry if limit exceeded
- [ ] Step 6: Append new entry to worklog.md
```

## Human Checkpoints

### Checkpoint 1: 엔트리 내용 확인 (After Step 3)
**Context**: 세션의 작업·결정·보류 항목이 작성된 시점. 자동 생성된 요약이 실제 세션을 정확히 반영하는지 추가하기 전에 검토가 필요하다.
**Ask**: "작성된 워크로그 엔트리가 **이번 세션 작업을 정확히 담고 있나요**?"
**Options**:
1. Append — 그대로 worklog.md에 추가
2. Edit entry — 내용을 수정한 후 추가
3. Skip this log — 이번 세션은 기록하지 않음
**Default**: 1 (자동 작성된 요약이 대체로 정확한 경우)
**Skippable**: No — 추가·수정·건너뛰기 중 하나를 명시적으로 결정해야 함
**Freedom**: MEDIUM

### Checkpoint 2: 오래된 엔트리 삭제 승인 (After Step 5)
**Context**: 200줄·10엔트리 상한 초과로 가장 오래된 엔트리를 삭제하려는 시점. 삭제 전에 해당 엔트리를 보존해야 할 이유가 없는지 확인이 필요하다.
**Ask**: "가장 오래된 엔트리를 **지금 삭제해도 괜찮나요**?"
**Options**:
1. Trim — 오래된 엔트리를 삭제하고 새 엔트리를 추가
2. Archive to separate file first — 별도 파일에 보관한 후 삭제 진행
**Default**: 1 (오래된 세션 기록은 대부분 삭제해도 무방)
**Skippable**: No — 삭제 또는 보관 후 삭제를 명시적으로 결정해야 함
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Detect trigger | LOW | Trigger conditions are defined (commit, feature, session end) |
| Read worklog | LOW | Fixed file location |
| Compose entry | MEDIUM | Format is strict (작업/결정/보류), but content is judgment call |
| Check size limit | LOW | 200-line / 10-entry limits are non-negotiable |
| Auto-trim | LOW | Remove oldest entry, preserve header |
| Append entry | LOW | Append at end, format exactly as specified |

## Recovery Protocol

When starting a new session:
1. Read `memory/worklog.md` automatically (it's in auto-memory)
2. Check the most recent entry for context
3. Check "보류" section for pending items
4. Resume work with full awareness of previous session

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "the git log is my worklog" | git log shows commits; worklog shows decisions, blockers, and dead-ends |
| "I will write it at the end of the week" | end-of-week you has forgotten Monday context — write as you go |
| "nobody reads worklogs" | future-you reads them; worklogs are the index to past decisions |
| "it is just noise" | noise filtered becomes signal — grepping old worklogs is how teams recover tribal knowledge |
| "auto-generated is lazy" | auto-generated is consistent; embellish with rationale, do not hand-write the whole thing |
