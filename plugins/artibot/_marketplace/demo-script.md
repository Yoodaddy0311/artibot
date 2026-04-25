# Artibot — Demo Video Script (1–2 min)

Total runtime target: **90 seconds**. Resolution: 1920×1080 / 60 fps. Voice:
calm, technical, no marketing fluff.

## Pre-flight

- Clean terminal (no scroll history visible)
- Light or dark theme — pick one and stay consistent
- Screen recorder set to capture editor + terminal in split layout
- Disable system notifications
- Use a fresh `artibot/` clone so paths look clean

## Shot list

| # | Time | Visual | Narration |
|---|---|---|---|
| 1 | 0:00–0:08 | Title card: "Artibot — Autonomous Agent OS for Claude Code" | "Artibot turns Claude Code into an autonomous agent OS." |
| 2 | 0:08–0:18 | Terminal: `git clone … && cd plugins/artibot && npm install` | "Clone, install, you're done. Zero runtime dependencies." |
| 3 | 0:18–0:30 | Editor showing `marketplace.json`, then `agents/` directory tree | "28 specialist agents, 100 skills, 56 commands — all first-class." |
| 4 | 0:30–0:45 | Claude Code session: user types a multi-domain request, orchestrator auto-delegates to parallel teammates | "You don't type slash commands. The orchestrator decomposes the work, spins up parallel teammates, and cross-verifies their results." |
| 5 | 0:45–1:00 | Multi-session dashboard at `runtime/dashboard/multi-session.html` | "Every action is observable — token usage, tool aggregates, error trends. Local-first. Opt-in OTEL when you need it." |
| 6 | 1:00–1:15 | Terminal: `npm test` showing 4,918 passing tests | "Five thousand tests. Ninety percent statement coverage. Zero lint errors." |
| 7 | 1:15–1:25 | Slide: "Data Sovereignty — local-only, no external DB" | "Your data never leaves your machine. That's a CRITICAL rule, enforced in the runtime." |
| 8 | 1:25–1:30 | Final card: GitHub URL + "MIT — install today" | "Open source. MIT. Install today." |

## Narration script (clean, copy/paste-ready)

```
Artibot turns Claude Code into an autonomous agent OS.

Clone, install, you're done. Zero runtime dependencies.

Twenty-eight specialist agents, one hundred skills, fifty-six commands —
all first-class.

You don't type slash commands. The orchestrator decomposes the work,
spins up parallel teammates, and cross-verifies their results.

Every action is observable — token usage, tool aggregates, error trends.
Local-first. Opt-in OTEL when you need it.

Five thousand tests. Ninety percent statement coverage. Zero lint errors.

Your data never leaves your machine. That's a CRITICAL rule, enforced
in the runtime.

Open source. MIT. Install today.
```

## Captions

Burn captions in. Use `assets/demo-captions.srt` (user creates) for accessibility.

## Output

- `_marketplace/demo-final.mp4` (not committed — host on YouTube / Vimeo)
- Paste public URL into `marketplace.json` → `media.demoUrl` and `media.demoVideo`.
