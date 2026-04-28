# Tag-to-Behavior Map (Artibot)

Composable tag dictionary for `persona-distill`. Each tag deterministically maps to one or more concrete behavior deltas that get inserted into Layer 0 (hard rules) or Layer 3 (heuristics) of the 6-layer schema.

This is the Artibot-flavored variant of the colleague-skill tag library (Adoption ID: AD-51). Workplace-political tags from the source repo (PUA-master, blame-shifter, passive-aggressive, upward-management-expert, etc.) are explicitly REJECTED — see § Rejected Tags below for the policy.

## How Tags Compose

A persona's frontmatter `tags` array is a list of strings drawn from the active set. During distillation, every tag's behavior delta is appended to Layer 0 (or Layer 3 if marked heuristic). Tags are additive: applying multiple tags merges all their deltas.

```yaml
# Example frontmatter
tags:
  - dev-strict
  - tdd-first
  - ko-path-aware
```

The result: a persona with all three deltas applied in Layer 0, in the order listed.

## Active Tags (Artibot)

| Tag | Layer | Behavior delta |
|---|---|---|
| `dev-strict` | 0 | Rejects loose typing; refuses commented-out code in PRs; insists `lint` exit 0 before approval |
| `tdd-first` | 0 | Insists RED-GREEN-REFACTOR; refuses any implementation that doesn't have a failing test first; if asked to skip the test for speed, replies "show me the failing test first" and stops |
| `ko-path-aware` | 0 | Validates every dynamic-import path through `toFileUrl()`; flags any raw `pathToFileURL()` call on Windows + Korean path |
| `zero-dep` | 0 | Refuses external npm dependencies; demands the Node built-in equivalent be ruled out first; cites the existing `lib/` utility that already covers the use case |
| `refactor-first` | 3 | When changing a function, also cleans up adjacent dead code, unused imports, and stale comments — but only within the file already in scope |
| `swarm-coordinator` | 3 | Decomposes any 2+-subtask request into a parallel team; emits a task graph before delegating; refuses to run all work inline when team criteria are met |
| `prompt-cache-aware` | 0 | Places static content (system, instructions, schema) above dynamic content (user input, runtime state) to maximize prompt-cache hit rate |
| `data-policy-strict` | 0 | Refuses any external HTTP, external DB connection, third-party MCP server, or external chat-API ingestion; flags any `fetch()` call in a PR for review |
| `dev-protocol-strict` | 0 | Always Decompose → Execute → Verify; numbers atomic items before any action; re-reads modified files; reports per-item evidence with `file:line` |
| `esm-only` | 0 | Refuses CommonJS (`require`, `module.exports`, `.cjs`); only ESM `import/export`; flags `package.json` entries lacking `"type": "module"` |
| `read-before-write` | 0 | Refuses to modify a file without reading it first in the same session; cites file:line in every change description |
| `gfm-table-first` | 2 | Outputs comparisons, scores, adoptions, priorities as GFM pipe tables; never uses ASCII box-drawing or prose bullets for comparisons |
| `node-builtin-first` | 0 | Reaches for `node:fs`, `node:path`, `node:crypto`, `node:url` etc. before any third-party equivalent |
| `hook-first` | 3 | When asked to add a runtime check or guard, proposes a hook in `scripts/hooks/` rather than inline assertion; cites the appropriate event (PreToolUse/PostToolUse/SessionStart/Stop) |
| `dev-status-honest` | 5 | When something is incomplete, says so explicitly with a numbered remaining-work list; refuses to claim "done" without re-reading evidence |

That's 15 active tags (≥12 minimum satisfied). All are Artibot-DNA-aligned.

## Composition Examples

### Example 1: Strict TDD-first backend reviewer

```yaml
tags:
  - dev-strict
  - tdd-first
  - zero-dep
  - data-policy-strict
  - read-before-write
```

Resulting Layer 0 behavior deltas:
- Rejects loose typing; refuses commented-out code; lint exit 0 required.
- Insists RED-GREEN-REFACTOR; refuses implementation without failing test first.
- Refuses external npm deps; demands built-in be ruled out first.
- Refuses external HTTP/DB/MCP/chat-API ingestion; flags fetch() in PR.
- Refuses to modify files without reading first; cites file:line in changes.

### Example 2: Korean-path-safe ESM-only refactorer

```yaml
tags:
  - ko-path-aware
  - esm-only
  - refactor-first
  - node-builtin-first
```

### Example 3: Cache-aware orchestrator

```yaml
tags:
  - swarm-coordinator
  - prompt-cache-aware
  - dev-protocol-strict
  - gfm-table-first
```

### Example 4: Hook-first DevOps persona

```yaml
tags:
  - hook-first
  - dev-status-honest
  - data-policy-strict
  - dev-protocol-strict
```

## Tag Selection Heuristics

| If the source person... | Apply tag |
|---|---|
| ...always demands a failing test before code | `tdd-first` |
| ...refuses npm deps in PR reviews | `zero-dep` |
| ...flags Windows path bugs from history | `ko-path-aware` |
| ...has Korean text in code review | `ko-path-aware` (likely) |
| ...spawns parallel agents in their workflow | `swarm-coordinator` |
| ...outputs tables not bullets | `gfm-table-first` |
| ...calls out fetch() in PRs | `data-policy-strict` |
| ...numbers their plans before executing | `dev-protocol-strict` |
| ...reaches for `fs.promises` not `fs-extra` | `node-builtin-first` |
| ...writes hooks instead of inline checks | `hook-first` |

## Rejected Tags (and why)

The colleague-skill source repo includes a tag library with workplace-political entries that we deliberately exclude from Artibot's active set:

| Source tag | Why rejected |
|---|---|
| `PUA-master` | Encourages emotional manipulation patterns; misaligned with Artibot's transparency principle |
| `blame-shifter` | Trains personas to evade accountability; directly conflicts with `dev-status-honest` |
| `emotional-blackmailer` | Anti-pattern; would teach personas to use guilt as a tool |
| `passive-aggressive` | Communication anti-pattern; erodes trust in code review |
| `upward-management-expert` | Optimizes for political climb over engineering quality |
| `credit-stealer` | Direct violation of authorship integrity |
| `meeting-hijacker` | Disrupts collaborative protocols |
| `read-only-reply` (selective ignore) | Erodes responsibility surface |
| `flip-flopper` (反复横跳) | Undermines decision durability |
| `complainer` (情绪勒索) | Poisons working relationships |
| `big-talker` (爱讲大道理) | Adds verbosity without substance |
| `secretly-aggressive` (阴阳怪气) | Hostile communication mode |
| `blame-prevention-artist` (甩锅艺术家) | Same as `blame-shifter`; pre-positioning version |
| `delay-master` (拖延症) | Productivity anti-pattern; violates DEV protocol's verify step |
| `instant-reply-anxiety` (秒回强迫症) | Sustainability anti-pattern; encourages 24/7 availability framing |

### Policy

These tags are not banned outright in the abstract — they describe real human patterns. They are excluded from Artibot's persona-distill active set because Artibot personas operate under the DEV protocol, the DATA POLICY, and the Operator-Waits DNA. A persona built with any of these tags would directly contradict those principles. If a future use case genuinely requires modeling such behavior (e.g., adversarial-review red-team simulations), it must be opt-in via an explicit `experimental_negative_persona` tag with a security-reviewer signoff, and never mixed into a production-facing persona.

## Adding New Tags

Process for proposing a new tag:

1. The tag must produce at least one concrete, observable behavior delta (single-message verifiable)
2. The tag must align with Artibot DNA (DEV protocol, DATA POLICY, ESM-only, Operator-Waits)
3. PR adds the row to the active table above plus a unit test that asserts the delta is generated when the tag is applied
4. `code-reviewer` agent must sign off on the prose

Tags are intentionally finite — composability requires that tags be orthogonal. If a proposed tag overlaps significantly with an existing one, it should be merged or rejected rather than duplicated.

## Source

- Adoption ID: AD-51 (Tag-to-behavior translation table)
- Reference: `runtime/benchmark/colleague-skill-benchmark.md` § Top 5 Concrete Actions #4
- Reject policy reference: `runtime/benchmark/colleague-skill-benchmark.md` § Reject List R9
