# `execution-profile.schema.json` — allowed values and where each one comes from

Annotation document for the schema in this directory. It is not a design
document and it decides nothing: it records which design file attests each
allowed value, so a later reader can tell an evidenced value from an invented
one without re-reading five specs.

Produced by investigation **I2** (`ARTIBOT-5.0-DESIGN.md §7.6 I2`), which decision
**F2** (`:414`) made a precondition for this schema. Line numbers are as of
2026-09-02; paths under `.artibot/guides/v5-design/`.

## Source documents read

| Tag | Path |
|---|---|
| **HARD** | `ADDENDUM-HARDENING.md` (section 2 at `:94`, profile block `:117-143`; section 20 at `:704-715`; section 29 at `:923-931`) |
| **DESIGN** | `ARTIBOT-5.0-DESIGN.md` |
| **V11-04** | `package-v1.1/04_INTENT_MD_SPEC.md` |
| **V11-06** | `package-v1.1/06_STATE_YAML_SPEC.md` |
| **V11-15** | `package-v1.1/15_POLICY_EXAMPLE.yaml` |
| **POLICY** | `package/config/artibot-v5-policy.example.yaml` (the v1.0 policy YAML) |
| **MC** | `package/schemas/mission-contract.schema.yaml` |
| **RL** | `package/schemas/run-ledger.schema.yaml` |
| **P02** | `package/02_PRODUCT_UX_NATURAL_LANGUAGE_RUNTIME.md` |
| **P03** | `package/03_INTENT_MISSION_COMPILER.md` |

## What each document actually contains

`execution_profile` as a literal key appears in exactly two places in the
repository: **HARD**`:117` (the eight-key block) and **HARD**`:709` (the version
block). Everything else contributes vocabulary under different key names.

| Document | Carries `execution_profile`? | What it contributes |
|---|---|---|
| **HARD** | yes, both blocks | The eight keys and one example value each; `version`, `derived_from.intent_revision` |
| **V11-04** | no — intent frontmatter spells it `execution_profile` with three keys at `:33-36` | `planning: ultraplan`, `performance: maximum`, `topology: split` |
| **V11-06** | no | `topology.mode: split`, `topology.performance_profile: maximum` (`:41-43`); `review.model: fable-5.1` (`:59-62`) |
| **V11-15** | no | `review.independent: true`, `review.model: "fable-5.1"` (`:46-49`). No performance or topology vocabulary at all |
| **POLICY** | no | `planning.default/modes`, `topology.default/normal/autopilot_fast/split`, `context.strategy`, `review.*` |
| **MC** | no | The only real **enums** in the corpus: `autonomy.mode`, `performance.priority`, `planning.mode` |
| **RL** | no | `topology.mode` six-value enum, fixed by **DESIGN**`:194` as the canonical router-output vocabulary |
| **P02** | no | Prose axis lists (`:53-63`), hyphenated |
| **P03** | no | Mission-contract skeleton values, and `command_activation` |

## Allowed-value table

Each row is a value the schema accepts and the line that attests it. No row is
inferred. Values that only one document uses are marked; where documents
disagree the union is taken, per the F2 instruction to merge rather than choose.

### `reasoning.depth`

| Value | Source |
|---|---|
| `direct`, `plan`, `deep-plan`, `ultraplan` | **P02**`:56` — "depth: direct/plan/deep-plan/ultraplan" |
| `deep` | **HARD**`:119` (the section-2 example) |

`deep-plan` keeps its hyphen because that is how **P02** writes it. `deep` and
`deep-plan` are not reconciled anywhere.

### `autonomy.level` (alias key `autonomy.mode`)

| Value | Source |
|---|---|
| `guided`, `agent_led`, `autonomous` | **MC**`:32` — `mode: {enum: [guided, agent_led, autonomous]}`. **DESIGN**`:276` (item A6, merged into F2) recommends exactly these three |
| `full` | **HARD**`:122` |
| `auto` | **P03**`:30` (mission-contract skeleton default) |

Two key spellings exist: **HARD** writes `level`, **MC** and **P03** write
`mode`. Both are accepted with the same value set; `human_gates` comes from
**MC**`:33` and is named in **DESIGN**`:84` as `autonomy{mode,human_gates}`.

### `performance.priority`

The widest disagreement in the corpus — four vocabularies, no document
superseding another.

| Value | Source |
|---|---|
| `balanced`, `maximum`, `split` | **DESIGN**`:129` — the three performance weights the design itself defines |
| `economy`, `balanced`, `quality`, `fast`, `maximum_performance` | **MC**`:37` |
| `speed_accuracy` | **HARD**`:125` |
| `maximum` (again) | **V11-04**`:35`; **V11-06**`:43` spells the same idea `performance_profile: maximum` |
| `balanced` (again) | **P03**`:33` |

**Not accepted:** `high-quality` and `maximum-performance` from **P02**`:58`.
That line is a prose axis list, not YAML, and its hyphenated spellings collide
with the underscore forms in **MC**. Consumers that need to read **P02** prose
must map it, not feed it in raw.

### `performance.budget`

| Value | Source |
|---|---|
| `generous` | **HARD**`:126`; **POLICY**`:68` and `:75` spell the same value `token_policy: generous` for `autopilot_fast` and `split` |

Closed at one value on purpose. No document names a non-generous budget token.
**DESIGN**`:129` mentions a numeric ceiling (`split.dispatch.budget`, 600k) but
attaches it to split dispatch config, not to this key, so no numeric form was
added here.

### `parallelism.strategy`

| Value | Source |
|---|---|
| `aggressive` | **HARD**`:129`; **POLICY**`:76` (`split.parallelism`) and `:72` (`autopilot_fast.parallel_exploration`) |
| `auto` | **POLICY**`:64` (`topology.default: auto`) |
| `net_gain` | **POLICY**`:66`, where the key is `parallelism_objective`, **not** `strategy` |

`net_gain` is the weakest row in this document. It is the only attested
non-aggressive parallelism value, so leaving it out would make the normal
execution mode inexpressible, but promoting it from a sibling key to this enum
is a judgment call, not a citation. Flagged rather than hidden.

### `topology` (root-level alias of `parallelism.strategy`)

| Value | Source |
|---|---|
| `solo`, `subagent`, `team`, `autopilot`, `autopilot_fast`, `split` | **RL**`:17`; **DESIGN**`:194` fixes this six-value enum as the canonical router-output vocabulary |
| `auto` | **POLICY**`:64` |

**DESIGN**`:363` accepts the v1.1 three keys as a subset with
"topology ~ parallelism.strategy". The two vocabularies are kept in separate
enums rather than merged into one, because execution modes (`split`) and
strategy words (`aggressive`) are not interchangeable. The mapping between them
is a consumer concern; this schema only agrees to accept both spellings.

### `planning.mode`

| Value | Source |
|---|---|
| `auto`, `direct`, `plan`, `ultraplan` | **MC**`:41`; **POLICY**`:19-28` (`default: auto`, modes `direct`/`plan`/`ultraplan`) |
| `ultraplan` (again) | **HARD**`:132`; **V11-04**`:34` |

### `context.strategy`

| Value | Source |
|---|---|
| `sufficient` | **HARD**`:135` |
| `minimal_sufficient` | **POLICY**`:58` |

Near-synonyms in prose. No document declares them distinct, and none declares
them equal, so both are kept.

### `review.independent`, `review.strictness`, `review.model`

| Field | Value | Source |
|---|---|---|
| `independent` | `true` | **HARD**`:138`; **V11-15**`:47`; **POLICY**`:53`; **V11-04**`:39` |
| `strictness` | `high` | **HARD**`:139` — the only occurrence in the corpus |
| `model` | free string | **HARD**`:140`, **V11-15**`:48`, **POLICY**`:54` (key spelled `default_model`), **V11-04**`:40`, **V11-06**`:61` all write `fable-5.1` |

**V11-06**`:60` is deliberately absent from the `independent` row. That line
reads `review.required: true`, a different field with a different meaning
(whether a review happens at all, not whether it is independent). Counting it as
evidence for `independent` would have been a mis-citation — see gap G-6.

`strictness` is closed at one value. **P02**`:61` names a "review strictness"
axis but lists no values, and `:75` says only "strict Fable review", so a second
tier would have to be invented.

`model` is deliberately **not** an enum. Every document writes `fable-5.1`, but
that token is not the catalog id (`claude-fable-5-1`), and the agent-coordination
rules make `lib/core/model-catalog.js` the single source for model ids and forbid
hardcoding them elsewhere. Pinning `fable-5.1` here would create a second source
of truth. Resolution belongs to the consumer.

### `completion.verified_outcome_required`

| Value | Source |
|---|---|
| `true` / `false` (boolean) | **HARD**`:143` |

### Version fields

| Field | Source | Type |
|---|---|---|
| `version: 1` | **HARD**`:710` | integer, minimum 1 |
| `derived_from.intent_revision: 3` | **HARD**`:711-712` | integer, minimum 1 |
| `schema_version: 1` | **HARD**`:930` (section 29, generic to every v5 schema) | integer, minimum 1 |

All three are integer counters starting at 1, not strings and not dates. That
typing is a **cross-schema contract**, not a local style choice: T-16 types every
revision counter the same way (`route-receipt.schema.json:59-61` and `:64-66`,
`context-receipt.schema.json:50-58`) and T-19 does too
(`common-meta.schema.json#/$defs/revision`). A string revision here would make a
receipt and the profile it cites uncomparable. A test pins the types so they
cannot drift back.

Two known divergences from T-19, left as-is and reported rather than silently
reconciled:

- T-19 offers `common-meta.schema.json#/$defs/execution_profile_meta`, built
  specifically for this schema to `$ref`. This schema declares the same two
  members inline instead, staying self-contained and free of cross-file `$ref`
  load-order coupling. The shapes agree today; whether T-18 should `$ref` T-19
  is the leader's call.
- T-19's `derived_from` also admits `plan_revision` and `review_revision`. This
  schema admits `intent_revision` only, matching what **HARD**`:711-712`
  literally shows.

## `command_activation` — the I2 sub-question

I2 asks whether the v1.0 policy YAML carries a `command_activation` key, because
**DESIGN**`:438` warns that it would overlap the section-3.1 design.

**It does not.** `command_activation` appears in the corpus only at **P03**`:75`,
a mission-contract document, as seven booleans plus a `skills` array
(`plan`, `ultraplan`, `review`, `autopilot`, `autopilot_fast`, `split`, `skills`).

The policy YAML instead carries **POLICY**`:9-17`
`intent_runtime.auto_activate` with seven booleans of its own (`commands`,
`command_flags`, `skills`, `settings`, `models`, `topology`, `verification`).
Same shape, different name, different member list — a near-twin concept rather
than the same key. The overlap **DESIGN**`:438` anticipated is therefore between
`intent_runtime.auto_activate` and `command_activation`, not a literal duplicate.

Either way `command_activation` is **not** a profile key here.
**DESIGN**`:362` demotes it to "a derived projection of the profile"; a test in
`tests/schemas/execution-profile.test.js` keeps it out.

## Two conformance levels

The root schema requires nothing, so the v1.1 three-key intent frontmatter still
validates. `definitions.versionedProfile` additionally requires `version` and
`derived_from`, which is what **HARD**`:704-715` demands of a profile whose
staleness against `intent.md` must be detectable. Consumers that need staleness
detection validate against that definition.

## Open gaps (not resolved by any document)

- **G-1 `performance.priority` has four vocabularies — RESOLVED (owner
  2026-09-04), with one residue.** The schema still accepts the union of eight
  values and this enum is unchanged. The router now absorbs the five
  non-design values into the three design values through
  `lib/routing/execution-profile.js#PRIORITY_ALIASES`, each row graded by its
  evidence (`attested` / `inferred` / `judgment`; the argument per row is
  `.artibot/guides/v5-design/DESIGN-G-1-performance-priority-mapping.md` §2):

  | Schema value | → design value | Grade |
  |---|---|---|
  | `fast` | `maximum` | attested |
  | `speed_accuracy` | `maximum` | inferred |
  | `maximum_performance` | `maximum` | inferred |
  | `quality` | `balanced` | judgment |
  | `economy` | `balanced` | judgment, **lossy** |

  The author's value is preserved at `profile.performance.priority`; only the
  routing behaviour is merged. A ninth enum value without an alias row still
  normalizes to `null` (`'G-1 unresolved'`) — fail-closed is kept.

  **`economy` is a lossy mapping. If this table reads as "all five resolved",
  that is an illusion.** No design priority is cheaper than `balanced`
  (`costWeight` tops out at 1 across all three, and `balanced` itself carries
  no `budgetCeilingRef` — only `split` has one), so "spend less"
  reaches the router as "spend normally". The `reason` string the router emits
  carries the word `lossy` for exactly this row.
- **G-1b (OPEN) — does `economy` get a directive of its own?** Candidates are
  `costWeight > 1` or a `budgetCeilingRef` (e.g. `routing.economy.budget`).
  Either one makes the design vocabulary four values, which the owner's
  2026-09-04 decision ("absorb into three") did not choose. Not decided; the
  interpreter's `PERFORMANCE_PRECEDENCE` placing `economy` above `fast`
  (grounded on an economy budget ceiling the design does not have) is the
  same open item seen from the other side.
- **G-2 `autonomy` has two key spellings and two value families.** Accepted as
  aliases here; which is canonical is an owner decision.
- **G-3 `reasoning.depth` and `planning.mode` overlap.** Both admit `direct`,
  `plan`, `ultraplan`. **P02**`:56` calls that axis "depth" while **MC**`:41`
  calls it `planning.mode`. They may be one axis recorded twice.
- **G-4 `review.strictness` has one value.** Unusable as a dial until a second
  tier is decided.
- **G-5 `parallelism.strategy` vs `topology`.** Both are accepted; no document
  gives the projection rule between `aggressive` and `split`.
- **G-6 `review` has three field spellings.** **HARD**, **V11-15**, **POLICY**
  and **V11-04** write `independent`; **V11-06**`:60` writes `required`;
  **POLICY**`:54` writes `default_model` where the others write `model`. Only
  `independent` and `model` are accepted here. Whether `required` is a third
  profile field or a state-projection artifact is undecided.

## Deliberate omissions

- `performance.fast_mode` (**P03**`:34`) is a v1.0 mission-contract field, not
  promoted to the profile: **DESIGN**`:129` explicitly resolves fast/split
  "generous" through `execution_profile.performance` rather than a separate key.
- The hyphenated **P02**`:58` prose forms, per the `performance.priority` note.
- Numeric budget ceilings, per the `performance.budget` note.

## Drift gate

`tests/schemas/execution-profile.test.js` asserts every enum above against a
transcribed copy. Changing an enum in the schema without changing that file and
this document turns the test red. What the gate does **not** check: whether the
cited line numbers still point at the cited text. Re-run investigation I2 if the
design documents are edited.
