# Severity Tiers — Shared Vocabulary

A 3-tier severity model shared across Artibot plugins. Every rubric, auto-flag
rule, and reviewer report uses this vocabulary so a "Critical" issue in a
content review means the same thing as a "Critical" issue in a code review.

Last updated: 2026-04-24
Applies to: `plugins/artibot`, `plugins/artibot-cowork`
Authoritative source: this file. All per-plugin rubrics cite it instead of
redefining tiers.

---

## Tier Definitions

| Tier | Meaning | Expected frequency | Blocking effect |
|------|---------|--------------------|------------------|
| **Critical** | Correctness or trust is broken. Shipping degrades the user, the brand, or the codebase. | Rare — should be < 5% of flagged issues on a healthy project | **Publish block / merge block.** Must be fixed before release. |
| **Major** | Shippable only after an explicit fix pass. Quality gap is visible, measurable, or likely to cause follow-up pain. | Common — typically 20-40% of flagged issues | **Release-before-fix.** Ship only if the fix is scheduled in the same release window. |
| **Minor** | Cosmetic, stylistic, or low-impact gap. Does not block release; should be logged for a later pass. | Majority — the long tail | **Follow-up.** Batch into the next scheduled refresh or cleanup. |

### Decision table

When assigning a severity to a newly-discovered issue, answer these three
questions in order and take the first match:

| Question | If yes, tier |
|----------|-------------|
| Would a user, customer, auditor, or runtime system be directly harmed by shipping this? | **Critical** |
| Is the issue measurably visible in the finished output (readability, performance, quality score)? | **Major** |
| Is the issue only noticeable on close inspection or by a specialist reviewer? | **Minor** |

If all three answer "no", the issue should not have been flagged — remove it
from the report rather than assigning a tier below Minor.

---

## Mapping Examples

### Content rubric (cowork plugin)

| Issue | Tier | Rationale |
|-------|------|-----------|
| Factual error in a cited statistic | Critical | Readers trust the piece; one wrong number damages source authority |
| No thesis in the first 150 words | Critical | Piece fails its primary job; rewrite rather than edit |
| Q-style H2 ratio below 40% | Major | AEO citation likelihood measurably lower; fix in one pass |
| Paragraph exceeds 150 words | Major | Readability grade drops; visible to any reader |
| Meta description 10 characters over 160 | Minor | Search engines truncate gracefully; cosmetic |

### Code rubric (artibot plugin)

| Issue | Tier | Rationale |
|-------|------|-----------|
| Secret or API key committed to repo | Critical | Security breach; requires rotation + git history rewrite |
| Test suite failure after change | Critical | Correctness broken; shipping degrades the product |
| Function over 100 lines without decomposition | Major | Maintainability debt; reviewable but should be refactored same PR |
| Untyped function signature in a typed file | Major | Regression of a type invariant; must be fixed before release |
| Import ordering deviates from style guide | Minor | Tool-fixable; bundle with next format pass |

---

## IDE & Tooling Integration

Consumers that render severity visually should use the following color mapping
for consistency. The palette is chosen for color-blind safety and dark-mode
legibility — do not substitute brand colors.

| Tier | Foreground color | Hex | Typical glyph |
|------|------------------|------|--------------|
| Critical | Red | `#D92D20` | Filled circle / exclamation |
| Major | Yellow | `#EAAA08` | Filled triangle |
| Minor | Blue | `#2E90FA` | Filled square / info |

**Rules:**

- Color alone must never convey severity. Always pair with text label or glyph
  (WCAG 2.1 SC 1.4.1 — "Use of Color").
- Do not introduce additional tiers by creating "warning" shades between
  Critical and Major. If a reviewer feels a 4th tier is needed, propose a
  governance change instead of inventing one locally.
- In terminal output, prefer plain text labels (`[CRITICAL]`, `[MAJOR]`,
  `[MINOR]`) over ANSI color when the output may be piped or logged.

---

## Governance

| Action | Owner | When |
|--------|-------|------|
| Change a tier's **definition** (meaning / threshold prose) | Plugin owners consensus | Quarterly review, or post-incident |
| Change a tier's **expected frequency** band | Plugin owners consensus | Quarterly review |
| Change a tier's **blocking effect** | Lead reviewer + plugin owners | Requires MAJOR bump of `_shared/` |
| Add an example row to a mapping table | Any plugin owner | Anytime, via PR |
| Add a 4th tier (below Minor or between existing tiers) | Lead reviewer only | Requires MAJOR bump + migration plan |

Re-calibration happens quarterly or immediately after an incident where a
miscategorized issue caused a release problem. Incident-driven re-calibrations
must be paired with a new example row under the relevant mapping section so the
lesson carries forward.

### Change log

| Date | Change | Version |
|------|--------|---------|
| 2026-04-24 | Initial 3-tier model established | 1.0.0 |

---

## References

- `./category-floor.md` — how category floors interact with tier rollups
- `./auto-flag-schema.md` — how auto-flag rules declare their severity
