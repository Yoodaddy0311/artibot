# Category Floor — Single-Axis Collapse Defense

A category floor is the minimum score a rubric category must hit before the
final tier is granted. Floors defend against "ceiling gaming" — a piece that
scores 92/100 overall but 6/15 on E-E-A-T is still a broken piece, regardless
of total. Without floors, a reviewer can mask catastrophic weakness in one
dimension by compensating elsewhere.

Last updated: 2026-04-24
Applies to: every rubric across `plugins/artibot` and `plugins/artibot-cowork`
Complements: `./severity-tiers.md`, `./auto-flag-schema.md`

---

## Mechanism

Every rubric category declares two numbers: `max` and `floor`. After scoring,
the final disposition is the **lower** of (a) the tier implied by the total,
and (b) the tier implied by the worst-performing category vs its floor.

### Formula

```
tier_from_total   = tier(total)
tier_from_floors  = min over categories of tier(category_score, category_floor)
final_tier        = min(tier_from_total, tier_from_floors)
```

Where `tier()` maps a score (or a score relative to a floor) to one of the
four dispositions defined below.

### Pseudocode

```js
function finalTier(rubric, scores) {
  const total = sum(scores);
  const totalTier = tierFromTotal(total);

  let floorTier = "proceed";
  for (const cat of rubric.categories) {
    const ratio = scores[cat.name] / cat.max;
    const floorRatio = cat.floor / cat.max;
    if (scores[cat.name] < cat.floor) {
      floorTier = worseOf(floorTier, downgradeForFloorMiss(ratio, floorRatio));
    }
  }

  return worseOf(totalTier, floorTier);
}
```

`worseOf()` picks the more restrictive tier (Reject > Major rewrite > Minor
edits > Proceed). `downgradeForFloorMiss()` is defined in the table below.

---

## Floor Value Guidance

Floors should sit between **40% and 60%** of the category's max points. The
rationale:

| Floor / Max | Effect | Use when |
|-------------|--------|----------|
| < 40% | Floor too loose; effectively decorative | Never — raise the floor or drop the floor entirely |
| 40-50% | Catches egregious weakness without over-blocking | Categories where partial coverage is acceptable (e.g., cosmetic dimensions) |
| 50-60% | Catches both egregious and moderate weakness | Categories where absence of the dimension breaks the piece (e.g., thesis, correctness, trust) |
| > 60% | Over-strict; floor becomes a de-facto second pass threshold | Never — if > 60% is needed, the category is actually a gate, not a rubric dimension |

### Example — Content rubric (cowork plugin)

| Category | Max | Floor | Floor % | Notes |
|----------|-----|-------|---------|-------|
| Content Quality | 30 | 18 | 60% | Thesis + evidence cannot be compensated by SEO polish |
| SEO | 25 | 13 | 52% | Partial SEO coverage is survivable if other dimensions carry |
| E-E-A-T | 15 | 8 | 53% | Trust signals below this line make the piece un-shippable regardless of total |
| Technical | 15 | 8 | 53% | Readability and structure dimension |
| AI Citation | 15 | 7 | 47% | Newer dimension; slightly looser floor during ramp |

### Example — Code rubric (artibot plugin, illustrative)

| Category | Max | Floor | Floor % | Notes |
|----------|-----|-------|---------|-------|
| Correctness | 30 | 18 | 60% | Test coverage + assertion quality; no shipping broken code |
| Readability | 20 | 10 | 50% | Name clarity, comment discipline, structure |
| Safety | 20 | 12 | 60% | Input validation, error handling, secret hygiene |
| Performance | 15 | 6 | 40% | Looser — acceptable to ship correct-but-slow, fix in follow-up |
| Maintainability | 15 | 8 | 53% | Decomposition, dep hygiene, test stability |

---

## Tier Dispositions on Floor Miss

When any category is below its floor, map the miss to one of four dispositions:

| Miss severity | Condition | Disposition | Action |
|---------------|-----------|-------------|--------|
| Critical floor miss | `score < 0.5 * floor` (missed by more than half the floor) | **Reject / Restart** | Do not patch at the draft/PR layer; the brief or design is broken |
| Standard floor miss | `0.5 * floor <= score < floor` | **Major rewrite** | Return to author; fix the weak dimension; re-score entire rubric |
| Near miss | `score == floor - 1` | **Minor edits** | One editing pass targeted at the weak dimension; no re-score needed |
| Clean | `score >= floor` | **Proceed** | Apply the tier implied by total score |

The Disposition column aligns directly with `./severity-tiers.md` — Reject /
Restart corresponds to a Critical-level block, Major rewrite corresponds to a
Major-level block, and Minor edits corresponds to Minor-level follow-up.

---

## Interaction with Total-Score Tiers

Floors **cannot upgrade** a tier — they only downgrade. A piece that scores
82/100 with every floor passed is still "Minor edits" per total tier; it does
not jump to "Publish-ready" just because no floor was missed.

Conversely, a piece that scores 95/100 with one floor missed by 20% of the max
drops to "Major rewrite" regardless of the total.

This asymmetry is intentional. Floors are a safety net, not a reward mechanism.

---

## Governance

| Action | Owner | When |
|--------|-------|------|
| Adjust a floor value within the 40-60% band | Rubric owner | Anytime, via PR |
| Set a floor below 40% or above 60% | Lead reviewer + rubric owner | Requires rationale in PR description |
| Change the four-disposition mapping (Reject/Major/Minor/Proceed) | Plugin owners consensus | Requires MAJOR bump of `_shared/` |
| Change the formula (`final_tier = min(...)`) | Lead reviewer only | Requires MAJOR bump + migration plan |

Floor values should be reviewed whenever a category's rubric itself changes —
if you add a 3-point check to a 15-point category, revisit whether the floor
still reflects the intent.

### Change log

| Date | Change | Version |
|------|--------|---------|
| 2026-04-24 | Initial floor mechanism established | 1.0.0 |

---

## References

- `./severity-tiers.md` — 3-tier severity vocabulary used by the disposition mapping
- `./auto-flag-schema.md` — auto-flag rules can themselves be floor-aware
