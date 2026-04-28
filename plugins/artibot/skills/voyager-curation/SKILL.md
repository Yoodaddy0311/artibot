---
context: fork
user-invocable: true
name: voyager-curation
description: |
  Voyager-style skill auto-curation loop (LOCAL ONLY). Mines Episodic memory
  for recurring task patterns and proposes SKILL.md drafts to the staging
  directory for explicit user approval. No automatic promotion, no external
  data flow, no LLM calls during drafting.
  Triggers: voyager, skill curation, auto-skill, curate skills, 스킬 자동화, voyager-curation
platforms: [claude-code]
level: 3
triggers:
  - "voyager"
  - "skill curation"
  - "auto-skill"
  - "curate skills"
  - "스킬 자동화"
  - "voyager-curation"
agents:
  - "orchestrator"
  - "llm-architect"
tokens: "~2K"
category: "learning"
---

# Voyager Skill Curation (MVP)

Local-only, user-approval-gated auto-curation. Inspired by the Voyager paper
(MineDojo/NVIDIA 2023) but ported under three HARD constraints:

| Constraint | What it means here |
|---|---|
| No external data egress | All curation runs inside Artibot (`~/.claude/artibot/`, project runtime/) — nothing leaves the device. |
| No automatic promotion | Every candidate draft requires explicit `approveProposal(hash)` to move into `skills/`. |
| No LLM during drafting | Drafts are deterministic scaffolds; LLM refinement happens only if you kick off `/team` manually. |

## When This Skill Applies

- You keep re-running the same multi-step intent and want it codified as a skill.
- The macro-learner surfaced a candidate but you want a fuller SKILL.md (not a single-line macro).
- You want to audit `runtime/voyager-curriculum.jsonl` for proposal/approval history.
- Review is due on the staging directory — pending drafts are blocking signal.

## Relationship to Existing Systems

| System | What it does | Why Voyager differs |
|---|---|---|
| `macro-learner` | Detects repeated **2-keyword** action chains, registers tiny macros. | Voyager captures **full task frames** (intent + tool set + outcome) and emits complete SKILL.md drafts. |
| `skill-lifecycle-autopilot` | Deprecates unused skills, promotes frequent ones. | Complementary: Voyager creates new skills; lifecycle manages their fate after registration. |
| `continuous-learning` | Persists confirmed patterns into memory. | Voyager reads the **episodic** layer instead of session memory and specifically targets skill creation. |

If a candidate looks like a macro (≤2 steps, same keywords), prefer `macro-learner`. If it is a reusable procedure with its own triggers and anti-patterns, it belongs here.

## Process

1. **Analyze** — `analyzeEpisodes({ sinceDays: 14 })` pulls frames from `episodicStore`.
2. **Cluster** — `groupByPattern(frames)` Jaccard-clusters by (intent tokens ∪ tool set).
3. **Score** — `scoreCandidates(clusters)` ranks by `occurrence × distinctSessions × successRate × recencyBoost`.
4. **Self-Verify (v3.4.0+)** — shadow-dry-run cosine overlap check. Obvious drift is auto-discarded before staging. See below.
5. **Propose** — surviving clusters render into `runtime/voyager-staging/voyager-proposal-<hash>.md`.
6. **Review** — user opens each draft, edits the procedure, replaces scaffolded sections.
7. **Approve / Reject** — `approveProposal(hash)` moves the file into `skills/<name>/SKILL.md`; `rejectProposal(hash, reason)` deletes it and writes a 30-day cooldown entry into `runtime/voyager-staging/voyager-rejections.json`.

## Self-Verification (v3.4.0+)

Voyager's original paper includes a self-verification pass where the agent tests a freshly written skill against the environment before adding it to the library. Artibot cannot execute skills in a sandbox, so we approximate with a **shadow-dry-run**: a pure, local, LLM-free textual overlap check between the proposal's trigger/process and the very episodes that inspired it.

### Concept

For each past episode clustered into the proposal, the verifier computes a token-based cosine similarity against the proposal text (`trigger ∪ process`). Aggregated results produce a 3-tier verdict:

| Verdict | Condition | Effect |
|---|---|---|
| `accept` | ≥ 70% of episodes at or above the similarity threshold (default 0.8) | Normal staging flow. Draft written, ready for user review. |
| `review` | between the accept and reject bands | Draft is still written, but `metadata.preflightVerdict: "review"` is embedded so you can see why the curator flagged it. |
| `reject` | ≥ 50% of episodes below threshold | Draft is **NOT** staged. An `auto-reject` entry goes into the curriculum log with reason `self-verify-fail`. |

No LLM calls, no network I/O. Deterministic — same inputs always produce the same verdict.

### Opt-out

Set in `artibot.config.json`:

```json
{
  "learning": {
    "voyager": { "selfVerify": false }
  }
}
```

When disabled, every proposal is treated as `accept` and the old v3.3 staging path is preserved byte-for-byte.

## Example Usage (Node, in-process)

```js
import { createCurator } from './lib/learning/voyager/curator.js';
import { createEpisodicStore } from './lib/learning/memory/episodic.js';

const curator = createCurator({
  episodicStore: createEpisodicStore(),
  skillRegistryPath: '<pluginRoot>/skills',
  stagingDir: '<pluginRoot>/runtime/voyager-staging',
});

const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
const clusters = curator.groupByPattern(frames);
const scored = curator.scoreCandidates(clusters);
const proposals = await curator.proposeFromClusters(scored);
console.log(proposals);

// Later, after human review:
await curator.approveProposal('ab12cd34ef56');
// or:
await curator.rejectProposal('ab12cd34ef56', 'duplicate of refactor-cleaner');
```

## Anti-Patterns

- Do NOT auto-approve proposals. The MVP intentionally has no `autoApprove` flag; promotion is always explicit.
- Do NOT use external data for proposal generation. Only the local Episodic store. If you need semantic enrichment, run it as a local-only post-review step.
- Do NOT copy Voyager source prompts or code verbatim. This is a **pattern-level** port.
- Do NOT bypass the 30-day rejection cooldown. It exists so the curator does not thrash against a signature the user already declined.
- Do NOT propose a draft that obviously duplicates an existing skill — the draft contains a "Similar Existing Skills" section so the reviewer can spot this.

## Output Format (Proposal Report)

Return a GFM table when multiple proposals exist:

| Signature | Score | Occ | Sessions | Skill Name | File |
|---|---|---|---|---|---|
| ab12cd34ef56 | 4.2 | 9 | 3 | refactor-module-split | runtime/voyager-staging/voyager-proposal-ab12cd34ef56.md |

Each row links to the staging file. Summary line at the end:
`Proposals: N created • M in cooldown • pending review: N`.

## Integration Points

- Episodic store: `lib/learning/memory/episodic.js` (already v3.2.0).
- Skill registry: `plugins/artibot/skills/` (existing convention).
- Curriculum log: `runtime/voyager-curriculum.jsonl` (append-only JSONL).

## v3.4 Candidates (out of MVP scope)

- Voyager "self-verification" pass (generated skill is tested against N recent episodes before reaching the user).
- GRPO-style relative scoring across candidate variants for the same cluster.
- Cross-plugin proposal flow (e.g., proposals that span `artibot` + `artibot-cowork` skill sets).
