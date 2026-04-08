# Micro-Conversion Tracking & Analysis

**Core: Measure user intent signals throughout funnel to diagnose engagement issues before macro-conversion drop**

## Micro-Conversion Tracking Matrix

| Micro-conversion | Funnel Stage | Tracking Method | SaaS Benchmark | Action if Below |
|------------------|--------------|-----------------|-----------------|-----------------|
| Page Scroll ≥50% | Landing | GTM scroll event | 45-60% | Hero too long, low relevance |
| CTA Hover (>2s) | Hero section | GTM element interaction | 25-35% | Low interest, wrong audience |
| Form Field Focus | Lead capture | GTM form engagement | 70-80% | Form placement, visibility issue |
| Field Completion Rate | Form | GTM field abandonment | 85-90% per field | Field count too high, labels unclear |
| Error Interaction | Form submit | GTM error event tracking | <5% should error | Validation too strict, unclear requirements |
| Video Play | Below fold | Wistia/YouTube analytics | 20-30% | Not engaging, auto-play off, positioning |
| Demo CTA Click | Mid-funnel | GTM link tracking | 8-15% | Low trust, message mismatch |

## Implementation Checklist

**Google Tag Manager (GTM) Setup:**
- [ ] Scroll depth tracking: 25%, 50%, 75%, 100% (per page)
- [ ] Element hover tracking: Primary CTA, secondary CTA, logo
- [ ] Form start event: Timestamp + form ID + traffic source
- [ ] Field focus tracking: Track which field causes abandonment
- [ ] Form error events: Error message + field name + attempt count
- [ ] Video engagement: Start, 25%, 50%, 75%, Complete

**Analysis Intervals:**
- [ ] Collect baseline (1 week minimum)
- [ ] Set benchmark against industry standard
- [ ] If micro-conversion <benchmark by >20%, diagnose + fix
- [ ] Retest for 3-5 days post-fix before scaling

## Diagnostic Interpretation Guide

| Micro-conversion Drop | Likely Issue | Diagnostic Check |
|----------------------|--------------|-----------------|
| Scroll <40% | Content irrelevant or page too long | Test shorter hero, mobile design |
| CTA hover <20% | Low trust or unclear value prop | A/B test copy, add social proof |
| Form focus <60% | Form placement or visibility issue | Move form above fold, increase size |
| Field completion <85% | Field too intrusive or unclear label | Reduce field count, add inline help |
| Error rate >8% | Validation too strict or confusing | Implement inline validation, help text |
