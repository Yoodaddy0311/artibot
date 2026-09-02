# Artibot 5.0 Runtime Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                         USER / NATURAL LANGUAGE                  │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 1. NATURAL LANGUAGE INTENT RUNTIME                              │
│ intent · completion expectation · performance preference        │
│ command/flag/skill/setting activation                           │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. MISSION COMPILER                                            │
│ goal · success · constraints · scope · autonomy · evidence       │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. SYSTEMIC DIAGNOSIS / BLINDSPOT SCAN                         │
│ direct · upstream · downstream · bounded blindspots              │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. PLAN / ULTRAPLAN / ADR                                      │
│ questionUserAnswer only for genuinely necessary ADR choices     │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. CONTEXT COMPILER                                            │
│ minimal sufficient context · evidence pointers · cache affinity  │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. ADAPTIVE INTELLIGENCE ROUTER                                │
│ model · effort · budget · cache · hysteresis                    │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. TOPOLOGY ROUTER                                             │
│ solo · subagent · team · autopilot · autopilot--fast · split    │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 8. EXECUTION HANDS                                             │
│ shell · git · browser · MCP · files · APIs · CI · worktrees     │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 9. INDEPENDENT REVIEW                                          │
│ Fable 5.1 default substantive reviewer                          │
└──────────────────────────────┬──────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────┐
│ 10. UNIFIED VERIFIER                                           │
│ deterministic · behavioral · operational                        │
└───────────────┬───────────────────────────────────┬─────────────┘
                │ PASS                              │ FAIL
                ↓                                   ↓
          COMPLETE                           RECOVERY CONTROLLER
                                                   ↓
                                       Review → Plan Repair
                                                   ↓
                                        rare → Ultraplan
```

All stages emit Evidence + Usage + Cost + Decisions + Outcome to the Run Ledger.

## Runtime invariant

The user sees one coherent Artibot. The user should not need to think in terms of dozens of agents, providers, cache semantics, tool compression or topology. Those are implementation details.
