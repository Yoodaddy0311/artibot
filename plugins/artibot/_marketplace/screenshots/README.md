# Marketplace Screenshots — Placeholder Specs

Real PNG / JPG files are **not committed** here. Capture them locally and drop
them in this directory using the exact filenames below before submitting.

## Required files

| Filename | Spec | Subject |
|---|---|---|
| `icon-256.png` | 256×256, transparent PNG, ≤ 100 KB | Artibot logo |
| `banner-1280x640.png` | 1280×640, JPG or PNG, ≤ 500 KB | Hero banner with tagline |
| `01-orchestrator-overview.png` | 1920×1080, ≤ 1 MB | Orchestrator delegating to parallel teammates |
| `02-agent-team-parallel.png` | 1920×1080, ≤ 1 MB | Three teammates running in parallel + cross-verification |
| `03-multi-session-dashboard.png` | 1920×1080, ≤ 1 MB | `runtime/dashboard/multi-session.html` rendered |
| `04-skill-marketplace-view.png` | 1920×1080, ≤ 1 MB | Skills directory with frontmatter / triggers visible |
| `05-tdd-flow.png` | 1920×1080, ≤ 1 MB | tdd-guide agent walking RED → GREEN → IMPROVE |

## Capture tips

- Use a clean Claude Code workspace (no leftover panels)
- Hide personal info (usernames, paths with `바탕 화면`, API keys)
- Light or dark theme — pick one and use it for all 5 shots
- Annotate with arrows / callouts only if it improves comprehension
- Re-export at fixed DPI (96) so every screenshot has the same density

## Filename rule

Do **not** rename files. The filenames are referenced in `marketplace.json`
under `screenshots[].path` and the marketplace validator script.
