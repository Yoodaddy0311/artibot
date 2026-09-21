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

## `class` vs `design_axis`

`class` says *what kind of mistake the code makes*. `design_axis` is an
**optional** cross-tag to the seven real-incident axes of this repository named
at `ARTIBOT-5.0-DESIGN.md:188` — *which historical failure mode it rhymes
with*. They are orthogonal, so the relation is many-to-many and most rows carry
no axis at all.

| `design_axis` | Rows | Which `class` values carry it |
|---|---|---|
| `fail-open` | 2 | `logic`, `contract` |
| `shell-injection` | 2 | `security` |
| `spec-omission` | 2 | `logic`, `contract` |
| `gate-self-destruct` | 1 | `logic` |
| `intent-mismatch` | 1 | `docs-drift` |
| `windows-path-crlf` | **0** | — |
| `over-implementation` | **0** | — |

The last two rows of that table are the point of printing it. The enum lists
all seven axes because the seven are the design's vocabulary, but **no row
currently exercises `windows-path-crlf` or `over-implementation`**, so a green
run says nothing about a reviewer's ability to see either. They were left
uncovered rather than force-fitted: a row tagged with an axis it does not
really belong to would make the coverage table lie in the other direction.
Adding them is a genuine follow-up, not a formality.

---

## Row schema

Validated against `corpus.schema.json` (draft-07; ajv 6 is what this repository
resolves). Every object is closed — `additionalProperties: false` — so a
typo-ed key is a hard failure rather than a field silently asserting nothing.

| Field | Required | Notes |
|---|---|---|
| `id` | yes | `^SD-[0-9]{3}$`, `SD-001`..`SD-030`, unique and contiguous. A runner joins on it, so ids are never reassigned. |
| `class` | yes | One of the seven above. |
| `language` | yes | One of the five above. |
| `file_hint` | yes | Relative POSIX path of the **invented** file. No absolute paths, no drive letters, no `..`. |
| `injected_diff` | yes | Unified diff, `--- a/…` / `+++ b/…` / one `@@` hunk, ≤ 40 newline-separated lines. |
| `expected.finding_kind` | yes | Controlled kebab-case vocabulary; the enum lists only kinds some row uses. |
| `expected.location.path` | yes | Equals `file_hint` and the diff's `+++ b/` path. |
| `expected.location.line_range` | yes | `[start, end]`, inclusive, integers ≥ 1. |
| `severity` | yes | `critical` / `high` / `medium` / `low`. Author judgement; no scoring rule reads it today. |
| `source` | yes | `const: "synthetic"`. |
| `design_axis` | **no** | The only optional field. |

`line_range` is numbered in the **post-apply (new) file** and must fall inside
the hunk's new range. Post-apply because that is the only numbering a reviewer
reading the patched file can produce — scoring against pre-apply numbers would
mark a correct reviewer wrong on every hunk that adds lines. Some ranges point
at a **context** line, not an added one: a `docs-drift` defect is precisely the
sentence the diff did *not* touch and thereby made false.

## Scoring rules

Implemented by the runner (`scripts/bench/seeded-defect.mjs`); documented here
so the definition has one home. Input is
`[{ id, findings: [{ kind, path, line }] }]`.

- **`caught(id)`** — true when at least one finding for that `id` has
  `kind === expected.finding_kind` (exact string equality).
- **`catch_rate`** — `caught / n`, where `n` is the size of the **whole
  corpus**. An `id` absent from the input is a miss, never an exclusion; a
  reviewer that returns nothing scores 0, not `NaN`.
- **`location_accuracy`** — among **caught** rows, the fraction where at least
  one *kind-matching* finding also has `path === expected.location.path` and
  `start <= line <= end`. Denominator is the number of caught rows; `null` when
  that is 0. Restricted to kind-matching findings on purpose: a finding that
  lands on the right line for the wrong reason is not a located catch.
- **`false_positive_rate`** — count of findings whose `kind` does not match the
  row's `expected.finding_kind`, over the **total** number of findings.
  `null` when there are no findings at all.
- **`per_class`** — per `class`: `{ n, caught, catch_rate, location_accuracy }`.
- **`corpus_sha256`** — SHA-256 of `corpus.jsonl` read as UTF-8 text with CRLF
  normalised to LF *before* hashing. Not the raw bytes: this repository runs
  with `core.autocrlf=true` and `git ls-files --eol` reports `i/lf w/crlf` for
  this file, so a raw-byte hash computed on Windows and on Linux would disagree
  about an identical file and a score report would become unreproducible.

A note on `false_positive_rate`: with one expected finding per row it measures
"findings that are not the seeded one", which includes a reviewer correctly
noticing something else about a fabricated module. It is a comparison metric
between reviewers on identical input, not an absolute error rate.

---

## Do not write the answer into the row

The defect must be inferable **only** from the code. Concretely, and enforced
by a regex in the corpus test over `injected_diff` and `file_hint`:

- No `bug`, `fixme`, `todo`, `xxx`, `hack`, `broken`, `wrong`, `incorrect`,
  `unsafe`, `insecure`, `vulnerable`, `exploit`, `leak`, `race`, `deadlock`,
  `off-by-one`, `should be`, `oops`, `careful`, `beware`, `note:` — in any
  comment, identifier, string, or path.
- No file named after its own defect.
- Every diff carries **defect-unrelated but legitimate** changes as well, so
  that "flag every added line" is not a winning strategy. Several rows put the
  defect on a context line for the same reason.
- This README names no individual row's answer either. The tables above are
  aggregates; the per-row expectation lives only in `corpus.jsonl`, which a
  reviewer under evaluation is not given.

## Adding a row

1. Invent a module. Do not copy code from this repository — a reviewer with
   repository context would recognise it and score on memory instead of
   reading.
2. Seed **exactly one** defect. A diff that justifies two independent findings
   is two rows.
3. Add defect-unrelated changes to the same hunk, and keep the diff ≤ 40 lines.
4. Pick `finding_kind` from the schema enum. A genuinely new kind means editing
   the enum — prefer reusing an existing kind over adding a synonym, which
   splits the vocabulary rather than widening it.
5. Tag `design_axis` **only** if the row honestly belongs to that axis, and
   update the axis table above, including its zero rows.
6. Compute `line_range` against the **post-apply** file and check it lies in
   the hunk's new range.
7. Re-run `npx vitest run tests/evals/seeded-defect-corpus.test.js`. The
   `corpus_sha256` pin will fail; read the new digest from the failure and
   update **both** the constant in that test and any digest quoted in a report.
   Re-pinning is the last step, never the first — a pin updated before the rest
   of the suite is green records whatever was on disk at the time.
8. Update the distribution counts in this README and in the test. They are
   asserted, so a stale count is red rather than quietly wrong.

---

## What this corpus does not prove

- **Nothing here measures a reviewer.** No reviewer is executed by this
  directory or by its test, so **catch rate is unmeasured**. A green run says
  the corpus is well-formed, internally consistent, and free of the leaks
  listed above — not that anything catches anything.
- **Synthetic ≠ representative.** Every module is invented and small. The
  distribution across classes was chosen for balanced coverage, not sampled
  from this repository's incident history, so per-class rates here do not
  estimate per-class rates in production code. The `design_axis` cross-tag is
  the only link back to real incidents, and it covers 5 of 7 axes across 8 of
  30 rows.
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
- **No comparison group ships here.** The design requires an opus comparison
  arm; this directory contains no run results for any model.
