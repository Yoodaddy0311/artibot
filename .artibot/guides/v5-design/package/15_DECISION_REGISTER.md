# Decision Register — Current Session

## D01 — Long-term autonomy
**Decision:** Fully Autonomous (C) is the long-term target, after robust Intent, Plan/Ultraplan, Context, Execution, Review and Verification foundations.

## D02 — Planning philosophy
**Decision:** Prefer deep pre-execution planning for important tasks rather than trial-and-error as the main strategy.

## D03 — Direct vs systemic problem solving
**Decision:** Do both. Inspect the explicitly requested target and causal upstream/systemic contributors.

## D04 — Blindspot behavior
**Decision:** Bounded C. Fix nearby unrequested blindspots when small, causal, reversible and verifiable.

## D05 — Failure recovery
**Decision:** Review first. Implementation issue → repair Plan; Plan issue → revise Plan; framing/architecture issue → Ultraplan.

## D06 — Completion
**Decision:** Recommended C. Completion requires intent/success criteria, execution evidence, verification and review.

## D07 — Review
**Decision:** **B rather than prior C.** Use an independent reviewer. Fable 5.1 is the canonical substantive reviewer. Self-check may still happen but is not sufficient final review.

## D08 — Uncertainty
**Decision:** Recommended C. Investigate autonomously first; ask only if a human decision remains.

## D09 — Human Gate
**Decision:** C with ADR refinement. At the start of ADR work, `questionUserAnswer` may be used only for genuinely necessary decision elements.

## D10 — Memory
**Decision:** Recommended C. Use past experience strongly, but current evidence has priority.

## D11 — Learning
**Decision:** Recommended C. Learn routing/context/planning/recovery strategies from actual outcomes.

## D12 — Model routing
**Decision:** Recommended C. Optimize accepted-outcome economics, not cheapest token.

## D13 — Parallelism
**Decision:** C for ordinary execution, with deliberate exceptions: `autopilot --fast` and `split` may use large token/compute envelopes to maximize speed and accuracy.

## D14 — Context
**Decision:** Recommended C. Sufficient, high-quality context; eliminate noise and duplication.

## D15 — Agent structure
**Decision:** Recommended C. Capability-based composition while preserving compatibility with named agents.

## D16 — UX
**Decision:** Highest perceived importance. Artibot is for non-developers. Natural-language requests must automatically trigger commands, options, skills, settings, models, topology, review and verification. Manual commands are advanced overrides.

## D17 — Transparency
**Decision:** Recommended C. Concise by default; inspectable via `/why`, `/cost`, `/status`, review/evidence views.

## D18 — Evolution
**Decision:** Recommended B. Remove orchestration when newer models make it unnecessary, after evaluation.

## D19 — Optimization objective
**Decision:** Recommended D. Jointly optimize quality, success, autonomy, human attention, cost, latency and regression.
