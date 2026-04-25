# Marketplace — Next Actions

Generated: 2026-04-25
Last updated: 2026-04-25 (post-recovery, v3.9.1 patch)
Status: v3.9.1 stable; one PR live, one needs re-submission via Anthropic form.

---

## Done (autonomous)

| # | Action | Result | Link |
|---|---|---|---|
| 1 | GitHub repo metadata (description, homepage, 12 topics) | ✅ Done | [Yoodaddy0311/artibot](https://github.com/Yoodaddy0311/artibot) |
| 2 | GitHub Releases v3.5–v3.9.0 + v3.9-stable annotated tag | ✅ Done | [Releases](https://github.com/Yoodaddy0311/artibot/releases) |
| 3 | ~~Anthropic official marketplace PR~~ | ❌ **Auto-rejected** (9s after open) — repo accepts Anthropic-internal contribs only | [anthropics/claude-plugins-official#1584 (closed)](https://github.com/anthropics/claude-plugins-official/pull/1584) |
| 4 | ComposioHQ/awesome-claude-plugins PR | 🟡 **OPEN, awaiting review** | [ComposioHQ/awesome-claude-plugins#196](https://github.com/ComposioHQ/awesome-claude-plugins/pull/196) |
| 5 | v3.9.1 stabilization patch (5 lint errors, recovery commit, .gitignore hardening) | ✅ Done | local commit |

---

## Deferred — User Action Needed (대단히 나중에)

These require human action that the agent system cannot perform autonomously.
Per user instruction, scheduled for **much later** — no current target date.

### A. Visual / Media Assets

| # | Action | Why deferred | When ready |
|---|---|---|---|
| A1 | **Demo video** (60–90s screen capture) | Requires real screen recording of auto-team workflow + dashboard | Before any major launch push |
| A2 | **Screenshots (7 files)** per `_marketplace/screenshots/README.md` specs | Requires running plugin and capturing UI states | Before marketplace listing review feedback |
| A3 | **Social preview image** (1280×640 PNG for GitHub repo card) | Branding asset | When social outreach starts |
| A4 | **Logo / icon** (favicon, square logo for plugin card) | Branding asset | Same as A3 |

### B. Social / Outreach

| # | Action | Why deferred | Notes |
|---|---|---|---|
| B1 | **Twitter/X announcement** | No account / strategy yet | Pair with launch push |
| B2 | **LinkedIn post** | Same | Pair with launch push |
| B3 | **HackerNews / Reddit / Lobsters** submission | Earned-media play; needs case study first | After A + at least 1 case study |
| B4 | **Anthropic Discord / forum mention** | Community channel | When v4.0 ships or when first external user lands |

### C. Submission Follow-up

> 🟢 **Major correction (2026-04-25)** — `anthropics/claude-code` repo's `.claude-plugin/marketplace.json` reveals: **plugin distribution is NOT via PR** to a central repo. Each project hosts its own `marketplace.json` and users add it via `claude plugin marketplace add owner/repo`. Artibot already has this at repo root and v3.9.1 sync is done — **users can install today**.

| # | Action | Notes |
|---|---|---|
| **C0** | **✅ Self-hosted marketplace LIVE** — `Yoodaddy0311/artibot` repo root has `.claude-plugin/marketplace.json` (synced to v3.9.1). Users install via:<br>`claude plugin marketplace add Yoodaddy0311/artibot`<br>`/plugin install artibot@artibot` | Fully autonomous; no Anthropic gatekeeping |
| C1 | (optional) Submit to [clau.de/plugin-directory-submission](https://clau.de/plugin-directory-submission) for **Anthropic-Verified** badge | Form requires user login; only needed for the verified badge, not for distribution itself |
| C2 | Monitor [PR #196](https://github.com/ComposioHQ/awesome-claude-plugins/pull/196) for merge | Active list, usually merged quickly |
| C3 | Verify end-to-end: `claude plugin marketplace add Yoodaddy0311/artibot` works on a fresh machine | One-time smoke test |
| ~~C4~~ | ~~PR #1584 to anthropics/claude-plugins-official~~ | ❌ Auto-rejected — that repo is Anthropic-internal only. Closed. |

### D. Additional Awesome Lists (parallel exposure)

| # | Repository | Reason to defer | When |
|---|---|---|---|
| D1 | [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills) | CONTRIBUTING.md notes "stars to be considered" — wait for some traction | After 50+ stars |
| D2 | [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | Different curation tone; review their contribution policy first | After A1+A2 ready |
| D3 | [karanb192/awesome-claude-skills](https://github.com/karanb192/awesome-claude-skills) | "Verified" curation | Same as D2 |
| D4 | [rohitg00/awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit) | Toolkit-style; might fit | Same as D2 |

### E. Anthropic Console Submission Form

| # | Action | Notes |
|---|---|---|
| E1 | Submit via [platform.claude.com/plugins/submit](https://platform.claude.com/plugins/submit) | **Requires user login** — agent cannot do this |
| E2 | Apply for **Anthropic Verified** badge | Needs A1 + A2 + case study + clean review history |

### F. Case Study / Demo Material

| # | Action | Why critical | Notes |
|---|---|---|---|
| F1 | Write 1–2 case studies — real workflow end-to-end | Single biggest community lever per `horizon-2-3-roadmap §5` | Pick a vertical: writing pack (cowork), security review (core agents), full-stack build, etc. |
| F2 | Publish as `_reports/case-study-*.md` + cross-post | Distribution | After F1 written |

### G. Cross-Tool Distribution (v5.5 prep)

| # | Action | Notes |
|---|---|---|
| G1 | Run `node scripts/export-to-tool.mjs --tool cursor --out ...` and publish as separate Cursor extension | Already has working converter |
| G2 | Same for codex / opencode | Bonus distribution channels |

### H. Observability — OTEL UI Integration (deferred per user)

| # | Action | Status / Why deferred | When |
|---|---|---|---|
| H1 | Local OTEL collector (Jaeger or otel-collector-contrib) for trace ingest validation | Docker Desktop daemon must be started by user (GUI). Backend code (`lib/observability/otel-exporter.js`, `lib/runtime/middleware/otel-middleware.js`) ready. | When user starts Docker Desktop |
| H2 | End-to-end smoke: set `ARTIBOT_OTEL_ENDPOINT=http://localhost:4318/v1/traces` → run pipeline → verify trace in Jaeger UI ([http://localhost:16686](http://localhost:16686)) | Needs H1 first | Same session as H1 |
| H3 | **Multi-session dashboard OTEL panel** — extend `lib/runtime/dashboard/server.mjs` + `multi-session.html` with: (a) live trace stream, (b) span waterfall, (c) cache-ROI / token-usage gauges from OTEL metrics | New feature; ~1–2 days work; requires H1+H2 baseline | After H2 validates trace pipeline works |
| H4 | OTEL config UI on dashboard (toggle enabled/endpoint/headers without editing JSON) | UX polish | After H3 |

---

## How to Pick Up From Here

When user is ready to push acquisition (per current note: "much later"):

1. **Start with F1** (case study) — single highest-value asset, drives everything else.
2. **Then A1 (demo video)** alongside F1 — they reinforce each other.
3. **Then capture A2 screenshots** during the demo recording.
4. **Then E1 console submission** + B1/B2 (social) on the same day.
5. **D1–D4 awesome list expansion** as natural follow-up.

Until F1 exists, additional submissions return diminishing value.

---

## Dependencies Already Met (no blockers)

- v3.9-stable tag pushed
- 3-file version sync at 3.9.0
- README polished (3 READMEs)
- marketplace.json self-validator passing 17/17
- SUBMISSION_CHECKLIST 78 items at PASS
- 4 design docs published (synergy, hierarchical-memory, GRPO-RLVR, horizon-2-3-roadmap)
- Anthropic + ComposioHQ PRs in flight

When the deferred items above land, the launch is a matter of timing, not engineering.
