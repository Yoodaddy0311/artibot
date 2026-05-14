---
description: (Artibot) Audit CLAUDE.md files in the repo, score 6-criteria, propose approved diffs only
argument-hint: '[path-or-glob] e.g. "CLAUDE.md" or "**/CLAUDE.md"'
allowed-tools: [Read, Glob, Grep, Edit]
toolset: analysis
---

# /audit-claude-md

Run the `claude-md-auditor` skill on the repository's CLAUDE.md files. Produce a graded report (A–F) and propose minimal diffs — Edit only fires after explicit user approval.

## Arguments

Parse $ARGUMENTS:
- `path-or-glob`: optional restriction to a single file or glob (default: all `**/CLAUDE.md` + `~/.claude/CLAUDE.md`)
- `--dry-run`: report only, never propose diffs
- `--apply yes|no|select`: pre-answer the Phase 5 approval prompt (defaults to interactive)

## Execution Flow

Invoke the `claude-md-auditor` skill. It owns the 5-phase pipeline:

1. **Discovery** — `Glob` only, never `find` (Windows pre-bash guard rejects it)
2. **Assessment** — 6 criteria, 100 max, partial credit in 5-pt steps
3. **Report** — table per file + write `~/.claude/artibot/audit-cache.json`
4. **Diff Preview** — `Why:` line + ```diff fence``` per file, no Edit yet
5. **Apply with Approval** — explicit yes / no / select required; default skip

See `skills/claude-md-auditor/SKILL.md` for the full rubric and anti-patterns.

## GRPO Feedback Loop

The cache file written in Phase 3 is read by `scripts/hooks/nightly-session-rollup.mjs` and folded into the GRPO reward as the `claudeMdQuality` dimension (max ±0.05 contribution). Skipping the audit yields a neutral signal — never a penalty.

## Output Format

See the skill — same table + APPROVED / SKIPPED counts.

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 학습 저장 | `/learn` | 감사 결과로 추출한 패턴을 메모리에 저장 |
| 2 | 체크포인트 | `/checkpoint` | 감사 직후 상태 스냅샷 |
| 3 | 학습 진단 | learning-diag | `quality` 버킷이 채워졌는지 확인 |
