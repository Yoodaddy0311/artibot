# Smoke Tests — `artibot-cowork` Writing Pack

Manual smoke tests for the 6 writing skills and the `ai-slop-reviewer` quality gate shipped in v0.4.0.

These tests exist to catch the most common regressions before a release: wrong-skill triggering, silent structural drift, fabricated sources, and slop-gate bypass. They do **not** replace unit or integration tests for hook/runner code — those live under `plugins/artibot/tests/`.

---

## Samples vs Fixtures

`skills/*/samples/*.md` files are **independent reference implementations** demonstrating skill-level spec compliance with self-contained fictional scenarios. They are NOT derived from `tests/smoke/fixtures/*.md` briefs. Do not use samples as fixture-pass baseline; samples serve as skill grammar references.

When a scenario's pass criteria (word count, structural expectations) diverge from the underlying skill's native spec, the scenario grades against the **fixture** target, not the sample. This is intentional — fixtures exist to exercise a specific reader/stakes context, while samples demonstrate the skill's default recipe.

---

## Purpose

| Goal | How these tests meet it |
|------|-------------------------|
| Regression prevention | Fixture-driven runs expose skill-level regressions between releases |
| Skill-trigger verification | Confirms trigger keywords activate the correct skill, not a collision |
| Rubric gate enforcement | End-to-end validation that `long-form-quality-rubric.md` thresholds are actually applied |
| Slop-gate realism | Proves `ai-slop-reviewer` catches the slop patterns its dictionaries describe |
| Fixture-grounded QA | Every scenario uses a concrete, versioned brief — not free-form prompts |

---

## File Layout

```
tests/smoke/
├── README.md                         (this file)
├── writing-pack.test.md              (scenarios 1-7)
└── fixtures/
    ├── brief-b2b-saas-blog.md        (long-form input)
    ├── brief-case-study.md           (case-study input)
    └── brief-expert-column.md        (column-editorial + thought-leadership input)
```

The same fixture is reused across multiple scenarios on purpose — it isolates skill behavior from input variability.

---

## How to Run (v0.4.0 — manual)

Smoke tests in v0.4.0 are executed by a human operator inside Claude Code (or any supported CLI: Gemini CLI, Codex CLI, Cursor). There is no script.

### Per scenario

| Step | Action |
|------|--------|
| 1 | Open the fixture file listed in the scenario (read contents) |
| 2 | Paste the fixture contents into a prompt with the trigger phrasing defined in the scenario |
| 3 | Observe which skill activates; record the skill name |
| 4 | Capture the full output to a scratch file |
| 5 | Walk the scenario's Pass/Fail checklist in `writing-pack.test.md` row by row |
| 6 | Run `ai-slop-reviewer` on the captured output (Scenario 7 is always the tail of 1-6) |
| 7 | Log results into `results-YYYY-MM-DD.md` using the template at the end of `writing-pack.test.md` |

### Full suite

Run all 7 scenarios back to back. Budget: ~60-90 minutes per full run in v0.4.0. A complete run produces:

- One results log file
- Up to six captured draft artifacts (one per writing scenario)
- Six slop-review reports (one per draft, plus the gate scenario itself)

### Environment constraints

| Constraint | Reason |
|-----------|--------|
| No network calls outside the CLI's normal operation | Data policy: external plugin/DB connections are forbidden per project rules |
| Fixtures are fictional | Never attempt to verify invented companies or metrics against real sources |
| Real source URLs required for non-fixture statistics | Scenario 1 requires 8 verifiable real-world citations; only the fixture's proprietary data is exempt |

---

## Scoring Model (shared across scenarios)

Each scenario in `writing-pack.test.md` is graded on three dimensions. Overall pass requires all three to clear.

| Dimension | Source | Pass threshold |
|-----------|--------|----------------|
| Structural | Scenario's "Required Structural Features" table | 100% of rows check |
| Long-form rubric | `copywriting/references/long-form-quality-rubric.md` | Total ≥ 80 AND each category ≥ floor |
| Slop gate | `ai-slop-reviewer` skill severity scoring | Score ≥ 75, zero Critical auto-flags |

A **single Critical auto-flag** (per `long-form-quality-rubric.md` Auto-Flag Rules table) drops the scenario to Fail regardless of totals.

---

## v0.5.0 Automation Roadmap

Smoke tests will remain manual in v0.4.0. The v0.5.0 direction:

| Capability | v0.4.0 | v0.5.0 target |
|-----------|--------|---------------|
| Scenario execution | Manual prompt entry | Node runner under `tests/smoke/run.js` |
| Result capture | Hand-copied logs | Runner writes to `results/<timestamp>/` |
| Structural check | Human walkthrough of checklist | Automated rule checks (H2 ratio count, word-count bounds, bio-sentence count) for deterministic rows |
| Rubric score | Human-run rubric pass | Semi-automated: rubric auto-flag rows scripted; judgment rows still human |
| Slop gate | Manual skill invocation | Runner chains slop reviewer onto every output automatically |
| CI integration | None | Optional nightly job producing a results artifact; no release-blocking until runner is stable |

The runner stays within Artibot: no external testing service, no third-party evaluation API. All scoring logic stays in-repo per project data policy.

### Candidate structure for v0.5.0 runner

```
tests/smoke/
├── run.js                            (entry point — reads scenario manifest)
├── scenarios.json                    (scenario metadata: trigger, fixture, checks)
├── checks/                           (rule modules: h2-ratio, word-count, bio-sentence-count, …)
└── results/
    └── 2026-05-XX/                   (one subdirectory per run)
        ├── results.md                (human-readable summary)
        └── drafts/                   (captured output per scenario)
```

None of the above files exist yet. This is the v0.5.0 sketch, not a contract.

---

## Results Log Format

Every run writes one file: `results-YYYY-MM-DD.md`, next to this README (or under `results/` once v0.5.0 lands). Minimum content:

| Field | Purpose |
|-------|---------|
| Run timestamp | When the suite started |
| Runner | "manual (operator name)" in v0.4.0 |
| Skill plugin version | From `artibot-cowork/.claude-plugin/plugin.json` |
| Per-scenario row | Use the Results Log Template in `writing-pack.test.md` |
| Critical flags section | Any Critical severity hit, with scenario + location |
| Regressions noted | Bugs rediscovered since prior runs (link to Regression Watchlist) |
| Artifacts directory | Path to captured drafts and slop reports |

A `Pass` row means: structural ✅, rubric ≥ 80 with floors, slop ≥ 75, zero Critical.

---

## When to Run

| Trigger | Scope |
|---------|-------|
| Before tagging a release (any skill change in `artibot-cowork/skills/*/SKILL.md`) | Full suite |
| After modifying `long-form-quality-rubric.md` | Scenarios 1, 2, 3, 4, 5 + gate (6 is scaffold-only) |
| After modifying `ai-slop-reviewer` dictionaries | All scenarios (gate behavior changed) |
| After adding or removing a trigger keyword | Run only the affected scenario plus any whose triggers collide |
| Ad-hoc quality audit | Choose the 2-3 scenarios most at-risk |

---

## Known Limitations

| Limitation | Workaround |
|-----------|-----------|
| Manual runs are slow and subject to operator fatigue | Cap a single session at 3 scenarios, split the rest to a second session |
| LLM non-determinism can produce a passing draft and a failing draft for the same prompt | Re-run failing scenarios once; only mark fail if it fails twice |
| Some rubric rows (originality, thesis clarity) resist automation | These will remain human-graded even in v0.5.0 |
| No CI gate in v0.4.0 | Release checklist must reference smoke results manually until v0.5.0 |

---

## See Also

- `./writing-pack.test.md` — full scenario definitions and Pass/Fail checklists
- `../../skills/copywriting/references/long-form-quality-rubric.md` — the 100-point rubric
- `../../skills/ai-slop-reviewer/SKILL.md` — slop score definitions and auto-flag rules
- `../../skills/copywriting/references/anti-ai-writing.md` — Korean/English slop pattern dictionaries
