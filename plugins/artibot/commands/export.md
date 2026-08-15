---
description: (Artibot) Cross-platform export — convert agents to Cursor, Codex, OpenCode, or Antigravity format
argument-hint: '[tool] e.g. "codex", "antigravity --dry-run"'
allowed-tools: [Read, Write, Bash, Glob, Grep]
toolset: code
lifecycle: ship
---

# /export

Export Artibot agents to other AI coding tool formats. Converts the 28 source-of-truth agent definitions under `plugins/artibot/agents/` into platform-specific instruction files.

## Arguments

Parse $ARGUMENTS:
- `tool`: Target platform (required). One of: `cursor`, `codex`, `opencode`, `antigravity`, `all`
- `--agents [names]`: Comma-separated subset of agents to export. Default: all
- `--out [path]`: Output directory. Default: `./{tool}-export/`
- `--dry-run`: Preview conversion without writing files
- `--help`: Show usage

## Supported Platforms

| Tool | Output Format | Target Path | Notes |
|------|--------------|-------------|-------|
| `cursor` | `.mdc` | `.cursor/rules/` | Cursor Rules-for-AI format |
| `codex` | `.md` | `.codex/agents/` | OpenAI Codex CLI agent spec |
| `opencode` | `.md` | `.opencode/agents/` | OpenCode agent markdown |
| `antigravity` | `.md` | `.antigravity/agents/` | Google Antigravity Agent Manager |
| `all` | mixed | `./cross-platform-export/` | All platforms in subdirectories |

## Execution Flow

1. **Validate**: Check `tool` argument is a supported platform name
2. **Run export script**: Execute `node plugins/artibot/scripts/export-to-tool.mjs` with the parsed arguments
3. **Handle `all`**: If tool is `all`, run the script for each of the 4 platforms with `--out <base>/<tool>/`
4. **Report**: Display summary — agent count, files written, output location
5. **Post-install hint**: Show the platform-specific activation command

## Post-Export Activation

After export, the user needs to activate the files in their target tool:

```
# Cursor
cp cursor-export/*.mdc .cursor/rules/

# Codex CLI
cp codex-export/*.md .codex/agents/

# OpenCode
cp opencode-export/*.md .opencode/agents/

# Antigravity
cp antigravity-export/*.md .antigravity/agents/
```

## What Gets Converted

- Agent frontmatter (name, description, model, tools)
- Agent body instructions
- Team Collaboration sections are stripped with platform-specific fallback notes
- **Antigravity only** — Claude Teams API calls in the body (`Agent(...)`, `SendMessage(...)`,
  `TaskCreate(...)`, …) are rewritten into Agent Manager equivalents

Two honesty notes on the last point, both measured 2026-08-15:

- **Cursor / Codex / OpenCode get no call-level rewrite.** Those converters strip the
  Team Collaboration section and attach a "not supported on this platform" note, then
  pass the body through verbatim. Claude-only calls elsewhere in the body survive as-is.
  (The `lib/adapters/*` adapters — a separate stack — do redact them to labels such as
  `(agent delegation)`.)
- **The source `tools:` declaration is carried through verbatim on every platform** — as a
  YAML `tools:` list for Codex/OpenCode/Antigravity, and as an
  `<!-- Artibot source tools: … -->` comment for Cursor. Either way the rewriters never see
  it (they only receive the body), so an orchestrator exports with `Agent(architect)`,
  `SendMessage`, and `TaskCreate` still named. 24 occurrences in the current agent set.
  Nothing is lost, but the exported file names tools the target platform does not have.


## What Does NOT Export

- Skills (111 SKILL.md files) — use `lib/core/skill-exporter.js` for full export
- Commands (67 commands) — platform-specific routing not portable
- Hooks — event-driven, Claude Code-specific
- Memory stores — runtime state, not exportable

## Error Handling

- Invalid tool name: show supported list and exit
- Missing agents directory: abort with path hint
- Write failure: report per-file errors, continue with remaining files
