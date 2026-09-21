# Seeded-defect corpus

Thirty synthetic defects, one per line of `corpus.jsonl`, each expressed as a
unified diff against an **invented** module plus the single finding a reviewer
is expected to produce for it. It exists so that "the reviewer catches real
defects" can become a number with a denominator instead of an impression.

Design origin: `.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md:188` requires a
seeded-defect corpus scored on catch rate **together with** false-positive rate
and location accuracy, and records that an unstated `N` is "not confirmed"
rather than "enough". `N = 30` is stated here for exactly that reason, along
with what 30 rows cannot resolve (see *What this corpus does not prove*).

This directory is **definition only**. Nothing here runs a reviewer.

---

## The seven `class` axes

| `class` | One-line definition |
|---|---|
| `logic` | The code computes something other than what the surrounding code and names say it computes — an inverted guard, a swapped operator, a dropped branch. |
| `boundary` | The computation is right in the interior and wrong at an edge: first/last element, empty input, inclusive vs exclusive limit. |
| `concurrency` | Correct in isolation, wrong when two things interleave or when an async result is never joined — unawaited work, unguarded shared state, check-then-act. |
| `security` | Untrusted input reaches a sink that trusts it: a shell, a filesystem path, a database, a log. |
| `resource` | A handle, connection, or buffer is acquired and never bounded or released on some path. |
| `contract` | The unit still runs but stops honouring what its callers were promised — return shape, error code, optionality, failure semantics. |
| `docs-drift` | The code changed and a comment or document that describes it did not, leaving a statement that is now false. |

Distribution (asserted in `../../seeded-defect-corpus.test.js`, not just
claimed here): `logic` 5, `boundary` 5, `security` 5, `concurrency` 4,
`resource` 4, `contract` 4, `docs-drift` 3 — 30 rows, every class at least 3.
Languages are `javascript`, `typescript`, `python`, `bash`, `markdown`, and no
class is written in a single language or a single `finding_kind`.

## The 23 `finding_kind` values

The scored vocabulary. A reviewer's `kind` is compared to these by **exact
string equality**, so the definitions below are the contract, not commentary.

| `finding_kind` | Means |
|---|---|
| `inverted-condition` | A test evaluates to the opposite of what the branch it guards assumes. |
| `wrong-operator` | The right operands combined by the wrong operator (`%` for `/`, `\|\|` for `??`, `&&` for `\|\|`). |
| `missing-case` | A discriminated input has a value no branch handles, and the fallthrough is not a correct answer for it. |
| `short-circuit-swallow` | A short-circuiting operator discards a legitimate value — classically a falsy-but-valid `0` or `''` replaced by a default. |
| `off-by-one` | An index or count is one too many or one too few. |
| `inclusive-exclusive-mismatch` | A bound is treated as inclusive where the spec says exclusive, or the reverse. |
| `empty-collection-unhandled` | The empty input is not a case the code survives. |
| `missing-await` | An async result is produced and never joined, so ordering or errors are lost. |
| `race-on-shared-state` | Two interleavings of the same code disagree about shared mutable state. |
| `check-then-act` | A condition is observed and acted on non-atomically, so the observation can be stale by the time it is used. |
| `command-injection` | Attacker-controlled text reaches a shell or command string. |
| `path-traversal` | Attacker-controlled text reaches a filesystem path and can escape its intended root. |
| `unvalidated-input` | Input reaches business logic without passing the validation the code intends to apply. |
| `secret-in-log` | A credential, token or key is written to a log or telemetry sink. |
| `resource-leak` | A handle or connection is acquired and not released on some reachable path. |
| `missing-timeout` | An unbounded wait on an external system with no deadline or cancellation. |
| `unbounded-growth` | A collection or buffer grows without a cap. |
| `return-shape-mismatch` | The value returned does not have the shape the signature or the callers require. |
| `silent-fallback` | An error is caught and replaced by a plausible-looking value, so failure becomes invisible. |
| `error-code-mismatch` | The status or error code does not correspond to what happened. |
| `optional-treated-required` | A value that may be absent is used as though it is always present. |
| `stale-doc` | A document states behaviour the code no longer has. |
| `stale-comment` | A comment states behaviour the code it sits on no longer has. |

### Near-synonym boundaries, and `also_accept`

Four pairs above overlap in ordinary usage. The corpus takes a position on each
and then, where both words are genuinely fair, records the alternative in the
row's optional `expected.also_accept`:

| Pair | Where the line is drawn |
|---|---|
| `off-by-one` ↔ `inclusive-exclusive-mismatch` | `off-by-one` when an index/count is wrong by one; `inclusive-exclusive-mismatch` when a documented bound changes inclusivity. A loop bound is usually both. |
| `race-on-shared-state` ↔ `check-then-act` | `check-then-act` when the defect is specifically observe-then-use across a gap; `race-on-shared-state` for read-modify-write without exclusion. Many real cases are both. |
| `short-circuit-swallow` ↔ `silent-fallback` ↔ `wrong-operator` | `short-circuit-swallow` when an operator discards a valid value; `silent-fallback` when a caught error becomes a normal-looking value; `wrong-operator` when the operator choice itself is the mistake. A `\|\|` that should be `??` is arguably all three. |
| `stale-doc` ↔ `stale-comment` | `stale-doc` for a document file, `stale-comment` for a comment in source. |

`also_accept` is an **optional array of other `finding_kind` values that name
the same one defect**. A scorer treats `{finding_kind} ∪ also_accept` as the
caught set and charges nothing in that set as a false positive. Without it, a
reviewer that saw the defect correctly but chose the other word would be scored
a **miss and a false positive at once** — which measures vocabulary agreement,
not review. It is deliberately rare: **6 of 30 rows** carry it, and the count is
pinned in the test. It never widens the number of defects in a row; a kind that
names a *different* problem in the same diff means the row has two defects and
must be split into two rows.

## `class` vs `design_axis`

`class` says *what kind of mistake the code makes*. `design_axis` is an
**optional** cross-tag to the seven real-incident axes of this repository named
at `ARTIBOT-5.0-DESIGN.md:188` — *which historical failure mode it rhymes
with*. They are orthogonal, so the relation is many-to-many and most rows carry
no axis at all.

| `design_axis` | Rows | Which `class` values carry it |
|---|---|---|
| `fail-open` | 2 | `logic`, `contract` |
| `spec-omission` | 2 | `logic`, `contract` |
| `shell-injection` | 1 | `security` |
| `gate-self-destruct` | 1 | `logic` |
| `intent-mismatch` | 1 | `docs-drift` |
| `windows-path-crlf` | 1 | `security` |
| `over-implementation` | **0** | — |

`over-implementation` — code that does more than was asked — has **no row**.
It is not a formality that was skipped: every defect in this corpus is a thing
the code gets *wrong*, whereas over-implementation is code that is locally
correct and unjustified. None of the 23 `finding_kind` values names it, so a
row for it needs a new kind as well as a new diff. That is a real follow-up,
recorded here rather than papered over with a mis-tagged row. **6 of 7 axes
and 8 of 30 rows carry a cross-tag**; see *Known departures* below.

---

## Row schema

Validated against `corpus.schema.json` (draft-07; ajv 6 is what this repository
resolves). Every object is closed — `additionalProperties: false` — so a
typo-ed key is a hard failure rather than a field silently asserting nothing.

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `^SD-[0-9]{3}$`, `SD-001`..`SD-030`, unique and contiguous. An **opaque token**: see the reviewer input contract. |
| `class` | yes | One of the seven above. |
| `language` | yes | One of the five above. |
| `file_hint` | yes | Relative POSIX path of the **invented** file. No absolute paths, no drive letters, no `..`. |
| `injected_diff` | yes | Unified diff, `--- a/…` / `+++ b/…` / one `@@` hunk, ≤ 40 newline-separated lines. Does **not** end with a newline. |
| `expected.finding_kind` | yes | Controlled vocabulary; the enum lists only kinds some row uses. |
| `expected.also_accept` | **no** | Near-synonyms for this row. See above. |
| `expected.location.path` | yes | Equals `file_hint` and the diff's `+++ b/` path. |
| `expected.location.line_range` | yes | `[start, end]`, inclusive, integers ≥ 1. |
| `severity` | yes | `critical` / `high` / `medium` / `low`. Author judgement; no scoring rule reads it today. |
| `source` | yes | `const: "synthetic"`. |
| `design_axis` | **no** | Cross-tag to the design's seven axes. |

### How `line_range` is chosen

`line_range` is numbered in the **post-apply (new) file** and must fall inside
the hunk's new range. Post-apply because that is the only numbering a reviewer
reading the patched file can produce — scoring against pre-apply numbers would
mark a correct reviewer wrong on every hunk that adds lines.

The rule is: **the smallest contiguous interval of new-file lines on which the
defect can justly be pointed out.** Three consequences worth stating, because
they are what make the metric fair rather than lucky:

1. For a defect that is *present* in a line (a flipped condition, a cast, a
   `%` where `/` belongs), that is a single line.
2. For a defect of *absence* (a guard, a `finally`, a cap that is no longer
   there), there is no line to point at, so the interval spans the lines that
   **flank the removal** — the last line before it and the first line after —
   and any line between them at which the consequence surfaces. A single-line
   range here would score a correct reviewer as mislocated.
3. For `docs-drift`, the interval is the **stale sentence**, not the line that
   changed. The diff made the old sentence false; the old sentence is the
   defect, and it is a context line.

---

## Reviewer input contract

Scoring is only meaningful if every reviewer sees the same thing, and that
thing does not contain the answer. A harness that feeds this corpus to a
reviewer **must**:

1. **Show `injected_diff` and nothing else.** `file_hint` needs no separate
   presentation — it is already in the diff's `--- a/` and `+++ b/` headers.
2. **Withhold `expected`, `class`, `severity`, `design_axis`, `language` and
   `source`.** `class` is the taxonomy the reviewer is being measured on;
   `severity` and `design_axis` narrow it further.
3. **Treat `id` as an opaque token and shuffle the presentation order.** Ids
   are already assigned in an order independent of `class` (the file is not
   sorted in class blocks) precisely so that id order leaks nothing — but a
   harness must not restore a grouping by sorting on any withheld field.
4. **Give the reviewer the 23 `finding_kind` values and their definitions.**
   Scoring is exact string equality, so a reviewer that has not been shown the
   vocabulary is being tested on guessing this repository's word choice.
   Consequence to state plainly: this makes the task **closer to 23-way
   multiple choice than to open-ended review**, which is a ceiling on what any
   score here can mean.
5. **Run an agentic reviewer with no repository access and no file tools.** The
   modules are invented, but the *paths* are plausible; a reviewer that can
   grep would search for `file_hint`, find this fixture directory, and read the
   answers.
6. **Add the trailing newline itself if a diff is handed to `git apply` or a
   similar tool.** No `injected_diff` ends with `\n` (30 of 30, asserted), so
   an adapter must append one.

## Scoring rules

Implemented by the runner (`scripts/bench/seeded-defect.mjs`); documented here
so the definition has one home. Input is
`[{ id, findings: [{ kind, path, line }] }]`. Write
`ACCEPTED(row) = {row.expected.finding_kind} ∪ (row.expected.also_accept ?? [])`.

- **`caught(id)`** — true when at least one finding for that `id` has
  `kind ∈ ACCEPTED(row)`.
- **`catch_rate`** — `caught / n`, where `n` is the size of the **whole
  corpus**. An `id` absent from the input is a miss, never an exclusion; a
  reviewer that returns nothing scores 0, not `NaN`.
- **`location_accuracy`** — among **caught** rows, the fraction where at least
  one finding with `kind ∈ ACCEPTED(row)` also has
  `path === expected.location.path` and `start <= line <= end`. Denominator is
  the number of caught rows; `null` when that is 0. Restricted to
  kind-accepted findings on purpose: a finding that lands on the right line for
  the wrong reason is not a located catch.
- **`false_positive_rate`** — count of findings whose `kind ∉ ACCEPTED(row)`,
  over the **total** number of findings. `null` when there are no findings.
- **`per_class`** — per `class`: `{ n, caught, catch_rate, location_accuracy }`.
- **`corpus_sha256`** — SHA-256 of `corpus.jsonl` read as UTF-8 text with CRLF
  normalised to LF *before* hashing. Not the raw bytes: this repository runs
  with `core.autocrlf=true` and `git ls-files --eol` reports `i/lf w/crlf` for
  this file, so a raw-byte hash computed on Windows and on Linux would disagree
  about an identical file and a score report would become unreproducible.

### What these metrics do not charge for

Two consequences of the rules above that a reader will otherwise mistake for
guarantees:

- **Spraying an accepted kind across many lines costs nothing.** A finding
  whose `kind ∈ ACCEPTED(row)` is never counted as a false positive, whatever
  line it names, and `location_accuracy` asks only whether **at least one**
  such finding landed in range. So `location_accuracy = 1.0` means "hit the
  spot at least once", not "pointed only there". A reviewer that reports the
  right kind on ten lines of a hunk scores identically to one that reports it
  on the correct line alone. **Precision within an accepted kind is
  unmeasured** — a follow-up, and a real gap.
- **Rows with `also_accept` are easier to catch by construction.** Because the
  accepted set is wider on those 6 rows, `catch_rate` is only comparable
  between runs carrying the **same `corpus_sha256`**. A rate from one corpus
  version against a rate from another is not a comparison, and a report that
  omits the digest cannot be checked for this.

A note on `false_positive_rate`: with one expected finding per row it measures
"findings that are not the seeded one", which includes a reviewer correctly
noticing something else about a fabricated module. It is a comparison metric
between reviewers on identical input, not an absolute error rate.

---

## Do not write the answer into the row

The defect must be inferable **only** from the code. A regex vocabulary is run
over `injected_diff` and `file_hint` by the corpus test; **the canonical list
is the `LEAK_WORDS` / `LEAK_PHRASES` constant in
`../../seeded-defect-corpus.test.js`**, not this paragraph — words are added
there, and a copy here would drift. It covers the obvious tells (`bug`,
`fixme`, `todo`, `off-by-one`, `race`, `should be`, …) and is applied both to
the raw text and to identifiers split on `snake_case` and `camelCase`, so
`is_broken` and `raceGuard` are caught too.

Beyond the word list, and enforced structurally:

- **Every diff carries defect-unrelated but legitimate changes**, so "flag
  every added line" is not a winning strategy.
- **No diff re-adds a line it just deleted** (0 of 30, asserted). A `-`/`+`
  pair with identical text is an artefact of hand-writing diffs and marks the
  surrounding lines as the interesting ones.
- **The defect is not the first added line** in 26 of 30 rows, so position is
  not a shortcut.
- **Comments are not reserved for the answer — but mostly they do carry it.**
  Measured: the corpus contains **6 code comments. 2** have nothing to do with
  their row's defect, **3** state a spec the defect violates (what "the limit
  is exclusive" means cannot be inferred from the code alone — that is the fair
  kind, and unavoidable for those rows), and **1 is itself the defect** on a
  `stale-comment` row. So "there is a comment" remains a weak signal that the
  interesting line is nearby. Diluting it further would mean adding inert
  comments to more rows; that is a known, unfixed weakness rather than a solved
  one.
- **This README names no individual row's answer.** The tables above are
  aggregates; the per-row expectation lives only in `corpus.jsonl`, which a
  reviewer under evaluation is not given.

## Adding a row

1. Invent a module. Do not copy code from this repository — a reviewer with
   repository context would recognise it and score on memory instead of
   reading.
2. Seed **exactly one** defect. A diff that justifies two independent findings
   is two rows. Check specifically that your "decoy" changes are *defensible*
   code, not a second thing a reviewer should flag.
3. Add defect-unrelated changes to the same hunk, keep the diff ≤ 40 lines, do
   not re-add a deleted line verbatim, and prefer putting a decoy *before* the
   defect.
4. Pick `finding_kind` from the schema enum. A genuinely new kind means editing
   the enum — prefer reusing an existing kind over adding a synonym, which
   splits the vocabulary rather than widening it. If another listed kind names
   the *same* defect just as fairly, add it to `also_accept`.
5. Tag `design_axis` **only** if the row honestly belongs to that axis, and
   update the axis table above, including its zero row.
6. Compute `line_range` against the **post-apply** file by the rule above, and
   check it lies in the hunk's new range.
7. Re-run `npx vitest run tests/evals/seeded-defect-corpus.test.js`. The
   `corpus_sha256` pin will fail; read the new digest from the failure and
   update the constant in that test. Re-pinning is the last step, never the
   first — a pin updated before the rest of the suite is green records whatever
   was on disk at the time.
8. Update the distribution counts in this README and in the test. They are
   asserted, so a stale count is red rather than quietly wrong.

---

## Known departures from the design

Two places where this corpus does not do what
`ARTIBOT-5.0-DESIGN.md:188` literally says. Both are deliberate and neither is
hidden:

1. **"1 defect 1 branch, prove the injected string is globally absent" does not
   apply here.** That text describes seeding defects into *real branches of
   this repository*. This corpus uses synthetic diffs carried as JSONL strings
   — one defect per JSONL row, **Wave 14 leader decision W14-6 (2026-09-21)**,
   which also records that the backlog's "1 defect 1 branch" wording is itself
   due a correction because a branch-per-defect fixture cannot ship — so there
   is no branch to create and no repository-wide string to prove absent — the defect text lives in the fixture by design.
   The corresponding guarantee here is different and weaker: the modules are
   invented, so nothing can be confused with real code.
2. **`design_axis` covers 6 of 7 axes across 8 of 30 rows.** This is an
   acknowledged debt of this wave, not a finished cross-tag. `over-implementation`
   has no row and needs a new `finding_kind` first (see above). A follow-up
   stem, not a formality.

## What this corpus does not prove

- **Nothing here measures a reviewer.** No reviewer is executed by this
  directory or by its test, so **catch rate is unmeasured**. A green run says
  the corpus is well-formed, internally consistent, and free of the leaks
  listed above — not that anything catches anything.
- **Synthetic ≠ representative.** Every module is invented and small. The
  distribution across classes was chosen for balanced coverage, not sampled
  from this repository's incident history, so per-class rates here do not
  estimate per-class rates in production code.
- **N = 30 is a coarse ruler.** One row is 3.3 percentage points. Two reviewers
  separated by less than that are indistinguishable on this corpus, and a
  per-class figure rests on 3–5 rows, where a single row moves the number by
  20–33 points. Per-class results are directional at best.
- **Small diffs are an easy case.** Each defect sits in a ≤ 40-line hunk with
  no cross-file dependency and no build. Real review happens across files, with
  history and call sites; a result here is an upper bound on that setting, not
  a prediction of it.
- **One seeded defect per row is an artificial prior.** A reviewer told, or
  able to infer, that each snippet contains exactly one defect can spend its
  whole budget hunting for one. That is not the review task.
- **A supplied 23-value vocabulary makes this partly a classification task.**
  See the reviewer input contract, item 4.
- **The labels are the author's judgement.** No analysis confirms that a row's
  `finding_kind` is the best name for its diff, or that a decoy is really
  defect-free. Every assertion in the test suite would pass on a mislabelled
  row. Human re-reading is the only control for this, and it is the highest
  value review this corpus can receive.
- **The leak scanner is a denylist** and fails open on the next word nobody
  listed.
- **No comparison group ships here.** The design requires an opus comparison
  arm; this directory contains no run results for any model.
