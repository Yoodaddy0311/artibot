# Artibot for Cowork

A slim, Cowork-optimized variant of the [Artibot](https://github.com/Yoodaddy0311/artibot) plugin, designed for knowledge workers using **Claude Cowork** (the Claude desktop app) rather than developers using Claude Code.

## What's different from the full Artibot plugin

The full `artibot` plugin is a 119-skill, 28-agent orchestration framework built around developer workflows (TDD, code review, git automation, build pipelines). It depends on Node.js hooks and external scripts that are not designed for the Cowork sandbox.

`artibot-cowork` is a curated subset focused on tasks Cowork users actually do:

- **No hooks, no external scripts.** No `hooks.json`, no `scripts/`, no `lib/`, no `server/`, no `runtime/`. Nothing runs in the background.
- **No developer-only components.** Removed: all `lang-*`, `persona-*`, `git-*`, `ddd-*`, `tdd-*`, `fp-refactor`, `coding-standards`, `testing-standards`, `ci-cd-pipelines`, `production-code-audit`, `compaction-survival`, etc.
- **Marketing, content, data, design, and CRO/SEO only.**
- **One MCP server**: `context7` (library documentation lookup). Playwright MCP removed.

## Contents

### Skills (30)

**Marketing & Content**: `advertising`, `campaign-planning`, `competitive-intelligence`, `content-seo`, `copywriting`, `email-marketing`, `lead-management`, `marketing-analytics`, `marketing-strategy`, `segmentation`, `social-media`

**Data & Reporting**: `ab-testing`, `data-analysis`, `data-visualization`, `report-generation`

**Design, Documents & Presentations**: `brand-guidelines`, `design-system-reference`, `image-generation`, `library-mermaid`, `presentation-design`

**CRO & SEO**: `cro-forms`, `cro-funnel`, `cro-page`, `customer-journey`, `seo-strategy`, `technical-seo`

**General utilities**: `clarify`, `daily`, `delegation`, `principles`

### Agents (10)

`ad-specialist`, `content-marketer`, `cro-specialist`, `data-analyst`, `doc-updater`, `marketing-strategist`, `orchestrator`, `planner`, `presentation-designer`, `seo-specialist`

### Commands (legacy format, 17)

`/ad`, `/analytics`, `/analyze`, `/content`, `/crm`, `/cro`, `/design`, `/document`, `/email`, `/excel`, `/mkt`, `/ppt`, `/seo`, `/social`, `/daily`, `/playbook`, `/explain`

> Note: Cowork's UI presents commands and skills together as a single "Skills" concept.

### MCP servers

- **context7** — on-demand library/framework documentation lookup via `npx`

## Installation

### Option 1: Install the packaged `.plugin` file

In Cowork, drag the `artibot-cowork.plugin` file into the chat and accept the install prompt.

### Option 2: Use the marketplace

Add the parent `artibot` repository as a marketplace, then install `artibot-cowork`:

```
/plugin marketplace add Yoodaddy0311/artibot
/plugin install artibot-cowork@artibot
```

## Compatibility notes

- **Cowork**: ✅ designed for this environment
- **Claude Code**: ✅ also works (it's a strict subset of the upstream plugin)
- **Hooks**: none — safe in any sandbox
- **External binaries**: only `npx` for the `context7` MCP server

## Versioning

This package starts at `0.1.0` and tracks the upstream `artibot` content but with its own release cadence. When upstream skills/agents change, this package will pull updates selectively.

## License

MIT (matches upstream `artibot`).
