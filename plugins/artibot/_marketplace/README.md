# Artibot — Marketplace Submission Package

This directory bundles all assets required for public marketplace listing
(Anthropic Claude Code plugin marketplace + cross-tool registries).

> Status: **draft** — pending Anthropic plugin marketplace schema finalization.
> Manifest source of truth: `plugins/artibot/marketplace.json`.

## Contents

| File | Purpose |
|---|---|
| `README.md` | This file — submission package overview |
| `elevator-pitch.md` | 100-word value proposition for listing copy |
| `feature-matrix.md` | Side-by-side comparison vs LangGraph / AutoGen / CrewAI |
| `demo-script.md` | 1–2 min demo video shot list and narration |
| `SUBMISSION_CHECKLIST.md` | Pre-flight checklist before hitting Submit |
| `screenshots/` | Placeholder filenames; user fills with real PNG/JPG captures |

## Workflow

1. Fill `screenshots/*.png` with real captures (specs in `screenshots/README.md`).
2. Record demo video per `demo-script.md`, upload to YouTube/Vimeo, paste URL into `marketplace.json` `media.demoVideo` and `media.demoUrl`.
3. Run `node scripts/marketplace-validate.mjs` — must pass with zero failures.
4. Walk through `SUBMISSION_CHECKLIST.md`.
5. Submit via the marketplace's intake (PR to `anthropics/claude-plugins-official` or its successor).

## Constraints (from project DATA POLICY)

- No external DB, no third-party forwarding. Listing copy must reflect this.
- All telemetry / observability features must be presented as opt-in and loopback-preferred.

## Owner

`artience.ads.team.tf@gmail.com`
