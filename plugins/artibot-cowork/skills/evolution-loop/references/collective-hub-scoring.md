# Collective Hub Scoring Algorithm

Reference document for the pattern scoring system used in Artibot's evolution loop and swarm intelligence pipeline.

---

## Overview

Before a pattern is included in GRPO training or uploaded to the swarm, it must pass through the Collective Hub Scorer. The scorer computes a weighted quality score (0.0–1.0) from four dimensions. Only patterns scoring ≥ 0.75 proceed.

---

## Scoring Formula

```
score = (frequency × 0.30)
      + (successRate × 0.40)
      + (novelty × 0.15)
      + (confidence × 0.15)
```

### Dimension Definitions

| Dimension | Weight | Range | Definition |
|-----------|--------|-------|------------|
| `frequency` | 30% | 0.0–1.0 | Normalized occurrence rate. `min(occurrences / 100, 1.0)` |
| `successRate` | 40% | 0.0–1.0 | Fraction of uses with positive outcome signals |
| `novelty` | 15% | 0.0–1.0 | Distance from nearest existing pattern. Cosine similarity inverted |
| `confidence` | 15% | 0.0–1.0 | Statistical confidence. `min(sqrt(n) / 10, 1.0)` where n = sample size |

---

## Threshold Gates

| Gate | Threshold | Action on Fail |
|------|-----------|----------------|
| Minimum score | ≥ 0.75 | Discard — not promoted to GRPO or swarm |
| Minimum samples | n ≥ 5 | Discard — insufficient statistical basis |
| Rejection window | 30 days | Skip if pattern was rejected in the last 30 days |
| Duplicate check | similarity < 0.85 | Merge with existing pattern instead of creating new |

---

## Outcome Signal Sources

The `successRate` dimension is computed from outcome signals collected during sessions:

| Signal Type | Source | Positive Indicator |
|-------------|--------|-------------------|
| Task completion | User acceptance without correction | No edit or rejection follow-up |
| Tool effectiveness | Tool result used vs. discarded | Claude proceeded with result |
| Team success | Orchestration outcome | All tasks completed, no retry |
| User satisfaction | Explicit feedback | Thumbs up, "perfect", "exactly" |
| Error absence | No error signals | No "that's wrong", no retry within 2 turns |

---

## Novelty Computation

Novelty prevents the promotion of redundant patterns that already exist in the knowledge base.

```
novelty = 1.0 - max_similarity

where max_similarity = max(cosine_similarity(candidate, existing_pattern))
      for all existing_patterns in knowledge_base
```

A pattern with high similarity (> 0.85) to an existing pattern is merged rather than added as a new entry.

---

## Confidence Computation

Confidence reflects statistical reliability of the success rate estimate:

```
confidence = min(sqrt(n) / 10, 1.0)
```

| Sample Size (n) | Confidence |
|-----------------|------------|
| 1 | 0.10 |
| 4 | 0.20 |
| 25 | 0.50 |
| 100 | 1.00 |

This ensures that high success rates from only 2-3 observations don't pass threshold prematurely.

---

## Example Calculation

**Pattern**: "Use `/mkt` + `marketing-strategist` for GTM strategy requests"

| Dimension | Raw Value | Score |
|-----------|-----------|-------|
| frequency | 47 occurrences | 0.47 |
| successRate | 91% success | 0.91 |
| novelty | 0.72 (cosine distance) | 0.72 |
| confidence | n=47, sqrt(47)/10 | 0.69 |

```
score = (0.47 × 0.30) + (0.91 × 0.40) + (0.72 × 0.15) + (0.69 × 0.15)
      = 0.141 + 0.364 + 0.108 + 0.104
      = 0.717
```

**Result**: 0.717 < 0.75 threshold → **not promoted** (needs more samples or higher success rate).

---

## Swarm Upload Eligibility

For patterns to be included in swarm uploads (in addition to the score threshold):

1. Score ≥ 0.75 ✓
2. Samples n ≥ 5 ✓
3. PII check passes (no user/path/hostname references) ✓
4. Not in 30-day rejection window ✓
5. Upload bundle size ≤ 5MB total ✓

Patterns passing all five gates are packaged, anonymized, and included in the next sync cycle.

---

## Implementation Reference

Full implementation in the CLI plugin:
- `lib/learning/pattern-extractor.js` — extracts candidates from session data
- `lib/swarm/pattern-packager.js` — applies scoring, packages for upload
- `lib/learning/knowledge-transfer.js` — promotes scored patterns to knowledge base
