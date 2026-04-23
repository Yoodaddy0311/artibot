# Auto-Flag Schema — Declarative Rule Format

A shared YAML schema for declaring deterministic rubric flags. Every rubric
(`plugins/artibot`, `plugins/artibot-cowork`) expresses its automatable checks
in this format so a single runner can evaluate them and so tools / IDEs /
CI jobs can consume them without bespoke parsers.

Last updated: 2026-04-24
Applies to: every rubric across both plugins
Complements: `./severity-tiers.md`, `./category-floor.md`

---

## Why declarative

Auto-flag rules have two properties: they are (1) deterministic — no judgment
call at runtime, and (2) cheap — a regex, a count, or a ratio. Expressing them
as YAML records rather than scattered prose means:

| Benefit | Consequence |
|---------|-------------|
| A single runner evaluates all rules | No per-plugin duplicate logic |
| Rules can be linted, version-diffed, audited | New tier assignment is a one-line change |
| Consumers (IDE, CI, review bot) share the same flag output | Uniform reviewer UX across plugins |
| Severity is authored in the rule, not inferred | No drift between rule text and rubric prose |

---

## Schema

### Top-level structure

Each auto-flag file declares a list of rules under a single `rules:` key:

```yaml
schemaVersion: "1.0.0"
rubric: "long-form-quality"
rules:
  - id: "ai-slop-phrase-hit"
    category: "ai-citation"
    severity: "major"
    escalate:
      when: "count >= 5"
      to: "critical"
    pattern:
      type: "regex"
      value: "(?i)certainly|delve into|comprehensive"
      scope: "body"
    action: "flag"
    message: "AI-slop phrase detected — replace with specific language"
```

### Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string (kebab-case) | yes | Stable unique identifier within the rubric. Used in reports and diffs. |
| `category` | string | yes | Maps to a rubric category name (e.g., `content-quality`, `correctness`). |
| `severity` | enum: `critical` \| `major` \| `minor` | yes | Base severity per `severity-tiers.md`. |
| `escalate` | object | no | Optional conditional escalation to a higher tier. |
| `escalate.when` | expression string | required if `escalate` present | Boolean expression against rule-local variables (`count`, `ratio`, `length`). |
| `escalate.to` | enum: `critical` \| `major` | required if `escalate` present | Target tier on escalation. Must be stricter than `severity`. |
| `pattern` | object | yes | Detection rule. One of three `type` values. |
| `pattern.type` | enum: `regex` \| `count` \| `ratio` | yes | See "Pattern types" below. |
| `pattern.value` | varies | yes | Regex source, count expression, or ratio expression. |
| `pattern.scope` | enum: `body` \| `title` \| `headings` \| `meta` \| `code` \| `comments` | yes | Where to apply the pattern. |
| `action` | enum: `flag` \| `block` \| `note` | yes | `flag` records the hit, `block` refuses to continue, `note` logs without scoring. |
| `message` | string (<= 200 chars) | yes | Human-readable reviewer message. Should state the fix direction, not just the problem. |
| `appliesTo` | list of strings | no | Content-type filter (e.g., `["long-form", "case-study"]`). Empty = all. |
| `minVersion` | semver string | no | Minimum `_shared/VERSION` required. Runner skips if shared version is older. |

### Pattern types

| Type | `value` shape | Evaluated as |
|------|--------------|--------------|
| `regex` | A regex source string (JavaScript flavor by default) | Match count against the scoped text |
| `count` | An expression returning an integer (e.g., `headings.h2.count`) | Compared against a threshold in `escalate.when` |
| `ratio` | An expression returning a number in `[0, 1]` (e.g., `headings.h2.questionRatio`) | Compared against a threshold in `escalate.when` |

---

## Examples

### 1) Regex-based rule

```yaml
- id: "passive-voice-overuse"
  category: "readability"
  severity: "minor"
  escalate:
    when: "ratio > 0.35"
    to: "major"
  pattern:
    type: "regex"
    value: "\\b(is|was|were|been|being)\\s+\\w+ed\\b"
    scope: "body"
  action: "flag"
  message: "Passive constructions over 35%; rewrite the majority in active voice"
```

### 2) Count-based rule

```yaml
- id: "statistic-density-too-low"
  category: "ai-citation"
  severity: "minor"
  pattern:
    type: "count"
    value: "body.statistics.withSource.count"
    scope: "body"
  action: "flag"
  message: "Fewer than 5 cited statistics; AEO citability degrades under this threshold"
```

### 3) Ratio-based rule

```yaml
- id: "q-style-h2-ratio"
  category: "ai-citation"
  severity: "major"
  escalate:
    when: "ratio < 0.3"
    to: "critical"
  pattern:
    type: "ratio"
    value: "headings.h2.questionRatio"
    scope: "headings"
  action: "flag"
  message: "Q-style H2 ratio below 50%; convert declarative headings to questions"
```

---

## Validation Rules

A runner must validate every loaded file against these constraints before
scoring begins. Any validation failure is a hard error — the rubric cannot run.

| Check | Constraint |
|-------|-----------|
| Schema version | `schemaVersion` must match a version this runner supports |
| Rule id uniqueness | Every `id` within a file must be unique |
| Severity enum | `severity` and `escalate.to` must be one of the 3 tiers |
| Escalation strictness | `escalate.to` must be stricter than `severity` (minor → major → critical) |
| Pattern type vs value | `regex` requires a string, `count` / `ratio` require an expression |
| Scope enum | `scope` must be one of the declared enum values |
| Action enum | `action` must be one of `flag` / `block` / `note` |
| Message length | `message` must be 1-200 characters |
| Category existence | `category` must match a category declared by the referenced rubric |
| Version compatibility | If `minVersion` is present, runner aborts when `_shared/VERSION < minVersion` |

Regex validation additionally requires the regex to compile in the runner's
regex engine. Invalid regex is a hard error at load time, not a runtime
fallback.

---

## Relationship to severity-tiers & category-floor

The auto-flag schema is the **mechanical half** of a rubric; `severity-tiers.md`
and `category-floor.md` are the **interpretive half**. They compose as follows:

| Concern | Owned by |
|---------|----------|
| "What does 'Critical' mean?" | `severity-tiers.md` |
| "How do I detect a paragraph over 150 words?" | `auto-flag-schema.md` |
| "Is this piece shippable given the flags?" | `category-floor.md` + total-score tier |
| "Which color does the IDE render this in?" | `severity-tiers.md` |
| "Does a hit at count >= 5 escalate to Critical?" | `auto-flag-schema.md` (`escalate`) |

A rule authored with `severity: major, escalate: {when: "count >= 5", to: "critical"}`
is saying: "each hit is a Major issue per the shared tier definitions, but five
or more hits cross the threshold that makes this dimension a Critical failure,
potentially tripping the category floor."

---

## Governance

| Action | Owner | When |
|--------|-------|------|
| Add a new rule to a plugin's rubric | Rubric owner | Anytime, via PR |
| Add a new `pattern.type` (e.g., `ast-query`) | Lead reviewer | Requires MINOR bump of `_shared/` |
| Change a required field or enum value | Plugin owners consensus | Requires MAJOR bump of `_shared/` |
| Retire a rule | Rubric owner + lead reviewer | Mark as deprecated for one MINOR cycle before removal |

### Change log

| Date | Change | Version |
|------|--------|---------|
| 2026-04-24 | Initial schema established (regex / count / ratio, 3-tier severity) | 1.0.0 |

---

## References

- `./severity-tiers.md` — severity vocabulary used by `severity` and `escalate.to`
- `./category-floor.md` — how auto-flag hits roll up through category floors
