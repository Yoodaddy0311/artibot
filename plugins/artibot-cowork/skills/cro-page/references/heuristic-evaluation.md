# Heuristic Page Evaluation Framework

**Core: Systematically score landing page effectiveness across 5 weighted factors to identify conversion barriers**

## Evaluation Factor Weights

| Factor | Weight | Score (1-5) | Evaluation Question |
|--------|--------|-------------|-------------------|
| Relevance | 25% | _ | Does headline match traffic source? Is value prop immediate? |
| Clarity | 25% | _ | Can visitor understand offer in <5 seconds? No jargon? |
| Motivation | 20% | _ | Is urgency/value communicated? Social proof visible? |
| Friction | 20% | _ | Is CTA prominent? Form simple? Navigation minimal? |
| Distraction | 10% | _ | Are secondary offers absent? No competing CTAs? |

**Total Score** = (Relevance × 0.25) + (Clarity × 0.25) + (Motivation × 0.20) + (Friction × 0.20) + (Distraction × 0.10)

Score Interpretation: 4.5-5.0 = Excellent | 4.0-4.4 = Good | 3.0-3.9 = Fair (optimization needed) | <3.0 = Poor (major barriers)

## Page Speed Impact Table

| Delay | Bounce Rate Lift | Conversion Drop | GTmetrix Grade | Action |
|-------|-----------------|-----------------|---------------|---------
| 0-1s | Baseline | Baseline | A (90+) | Maintain |
| 1-2s | +15-30% | -7% | B (80-89) | Monitor |
| 2-3s | +45-60% | -16% | C (70-79) | Optimize images, cache |
| 3-4s | +75-100% | -25% | D (60-69) | Defer JS, minify CSS |
| 4s+ | +100%+ | -40%+ | F (<60) | CRITICAL: CDN, compression |

## Quick Evaluation Checklist

- [ ] Hero section communicates single promise in <8 words
- [ ] Headline font size ≥32px on mobile
- [ ] Primary CTA visible without scrolling (above fold)
- [ ] CTA button color contrasts with background (WCAG AA)
- [ ] Form has ≤3 fields above fold
- [ ] Security badge/trust signal present (PayPal, SSL, etc.)
- [ ] Page load time <2s on 3G (test via WebPageTest)
- [ ] No autoplay video/sound
- [ ] Mobile viewport properly configured
- [ ] Alternative exit intent offer absent (single CTA focus)
