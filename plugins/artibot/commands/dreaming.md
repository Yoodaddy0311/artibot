---
description: (Artibot) Non-destructive memory consolidation — dedup/merge, stale-replace, insight-surface with a human review gate
argument-hint: '[--dry-run|--review|--auto] e.g. "메모리 정리 dry-run"'
allowed-tools: [Read, Bash, Glob, Grep]
toolset: meta
---

# /dreaming

Non-destructive memory **consolidation loop** over the user-visible auto-memory
(`memory/*.md` + `MEMORY.md`). Replicates the Anthropic Dreaming algorithm
(dedup-merge / stale-replace / insight-surface) **locally** with a human review
gate. Built on the validated promoter gating (occurrences / distinctSessions /
confidence floor / rejection ledger).

**Absolute safety line (never violated):**
- Input `memory/*.md` is **never modified**. All output lands in
  `memory/.dream-staging/`.
- Adopted changes archive the replaced originals to `memory/.dream-archive/`
  (hard-delete count is always 0).
- Default mode is `--dry-run`. `autoAccept` is OFF by default and is
  insert-only when enabled.
- rules/CLAUDE.md changes are **proposed only**, never auto-applied.
- All processing is local — zero external network IO (DATA POLICY).

## Arguments

Parse $ARGUMENTS:
- `--dry-run` (DEFAULT): run Phase-1 + Phase-2, write `proposals.json` +
  `report.md` to staging. **Zero live MD writes.**
- `--review`: present the `report.md` diff and collect accept/reject per
  proposal (human-in-loop). Accepted proposals are applied (archive-then-write);
  rejected ones are recorded in the rejection ledger.
- `--auto`: temporarily enable autoAccept (insert-only, confidence ≥ 0.95,
  external-signal-backed). merge/replace still require `--review`.
- `--memory-dir <path>`: override the memory dir (tests / non-default project).

## Two-Phase Distill (ADR-3)

This command runs the **session** half of the pipeline. The nightly hook only
ever produces `candidates.json` (LLM-free); this command turns candidates into
proposals using the current session's reasoning.

1. **Phase-1 code-Distill** (deterministic, LLM-free):
   `lib/learning/memory/dream/collector.js` + `distiller.js` read the memory
   dir read-only and emit `candidates.json` (dedup / contradiction / archive
   candidates by cosine similarity).
2. **Phase-2 LLM-Distill** (this session): for each candidate **only**, you
   (the session Claude) author a proposal body. **Every proposal MUST cite
   evidence** — original file path + quoted passage in `evidence[]`. Proposals
   without evidence are discarded by the promoter.

## Execution Flow

1. **Resolve dirs**: default memory dir is the current project's
   `~/.claude/projects/<proj>/memory`. Honour `--memory-dir`.
2. **Collect + Phase-1** (run the engine):
   ```bash
   node -e "import('./lib/learning/memory/dream/collector.js').then(async (m) => { \
     const c = m.createCollector({ memoryDir: process.argv[1] }); \
     const { memories } = await c.collect(); \
     const d = await import('./lib/learning/memory/dream/distiller.js'); \
     const cand = d.distillCandidates(memories); \
     await d.writeCandidates(process.argv[1] + '/.dream-staging', cand); \
     console.log(JSON.stringify({ merge: cand.mergeCandidates.length, contradict: cand.contradictCandidates.length, archive: cand.archiveCandidates.length })); \
   })" "<memory-dir>"
   ```
3. **Phase-2 (you)**: read `candidates.json`. For each candidate, read the cited
   source `.md` files and draft a proposal:
   `{op, name, type, scope, confidence, body, targets[], evidence[{source, originSessionId, quote}]}`.
   - dedup-merge → `op: 'merge'`, both targets, merged body, scope.
   - contradiction → keep BOTH; emit `op: 'insert'` hypotheses with
     `contradicts` cross-links and a `scope`/`counterexample` note. Never delete.
   - stale → `op: 'archive'` only when the candidate is genuinely low-utility.
   - new insight → `op: 'insert'`.
4. **Promote (gate)**: feed proposals through
   `lib/learning/memory/dream/promote-md.js#createPromoteMd`. Passing proposals
   are written to `<staging>/<slug>.proposed.md`.
5. **Report / Apply** (`lib/learning/memory/dream/apply.js`):
   - `--dry-run` (default): `dryRun(proposals)` writes `report.md` only.
   - `--review`: show `report.md`, ask the user per proposal (use AskUserQuestion;
     label the conservative choice "(권장)"). Apply accepted; `registerRejection`
     for declined. Archive replaced originals; regenerate `MEMORY.md`.
   - `--auto`: auto-apply only proposals where `canAutoAccept` is true; the rest
     fall back to `--review`.

## Output

- `memory/.dream-staging/candidates.json` — Phase-1 candidates.
- `memory/.dream-staging/proposals.json` — Phase-2 proposals (with evidence).
- `memory/.dream-staging/<slug>.proposed.md` — gated proposed memories.
- `memory/.dream-staging/report.md` — human review summary.
- On apply only: updated `memory/*.md`, regenerated `MEMORY.md`, replaced
  originals moved to `memory/.dream-archive/<date>/`,
  `runtime/dream-transitions.log` appended.

## Guardrails (PRD §6)

- consolidation drift → input never edited; merge/replace need human approval.
- error propagation → only gated proposals; corrections used as counter-signals.
- bloat → utility-based archive + dedup-merge (archive, never delete).
- contradiction → keep both as hypotheses + `contradicts` link.
- over-generalisation → explicit `scope`/`condition` + bidirectional evidence.
- self-reinforcement → external-signal gate; rules/CLAUDE.md proposal-only;
  kill-switch (`lib/learning/kill-switch.js`) disables the whole loop.
