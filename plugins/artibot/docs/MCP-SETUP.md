# MCP Setup Guide

Artibot ships three MCP servers via `plugins/artibot/.mcp.json`. All three run
locally over stdio through `npx`, require **no authentication**, and work out of
the box — Claude Code installs each package on first use.

| Server | Transport | Auth | Purpose |
|---|---|---|---|
| `context7` | stdio (npx) | none | Library / framework documentation lookup |
| `playwright` | stdio (npx) | none | Browser automation for E2E and UI checks |
| `chrome-devtools` | stdio (npx) | none | Chrome DevTools protocol — DOM, network, performance traces |

---

## Configuration

The servers are declared in `plugins/artibot/.mcp.json`:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@4.1.1"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@executeautomation/playwright-mcp-server@1.0.12"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.10.1"]
    }
  }
}
```

> **Note (Claude Code v2.1.69 bug #30989):** do not set `defer_loading` and
> `cache_control` simultaneously on the same server entry — MCP fails to load.

---

## Pinned versions

Each server is pinned to an exact release instead of the moving `latest` dist-tag. Every machine and session therefore starts the same code, and a new upstream release reaches users only after someone bumps the pin. The pins were measured on 2026-10-06T16:16:21Z (KST 2026-10-07 01:16) with `npm view <package> version`: `@upstash/context7-mcp` 4.1.1, `@executeautomation/playwright-mcp-server` 1.0.12, `chrome-devtools-mcp` 1.10.1. To bump one, re-run that command and update the three places that name the version together: the `args` in `plugins/artibot/.mcp.json`, the expected string in the `points the expected package at each server` test in `plugins/artibot/tests/mcp/mcp-config.test.js`, and the snippet and measurement date here. The test fails if a server floats back to a tag or a range, or if `.mcp.json` and the expected string differ. No test compares this page's versions with `.mcp.json`, and `docs:check` only validates its links and rendering, so keep its snippet and date in step by hand.

---

## Verify

Restart Claude Code so it re-reads `.mcp.json`, then run:

```bash
claude mcp list
```

All three entries (`context7`, `playwright`, `chrome-devtools`) should appear
without error. On first invocation `npx` downloads each package; subsequent runs
use the npm cache.

---

## Usage

- **context7** — fetch up-to-date docs for a library before implementing against it.
- **playwright** — drive a headless browser for end-to-end flows and screenshots.
- **chrome-devtools** — inspect DOM, capture network requests, and profile pages.

No environment variables or tokens are required for any server.

---

## Disabling

To disable a server temporarily, remove (or comment out) its block from
`plugins/artibot/.mcp.json` and restart Claude Code. The remaining servers are
unaffected.

---

## REA (optional, user-level, not in `.mcp.json`)

`/rea` drives [REA](https://github.com/morluto/rea), a third-party reverse-engineering
MCP server (npm package `rea-agents`, MIT). It is deliberately **not** one of the
three servers above and is not declared in `plugins/artibot/.mcp.json`: declaring it
there would attach its tools and a server start-up to every session of every user.

Instead `/rea` follows the upstream procedure: `doctor`, then `setup --dry-run`, then
(only after you approve the plan) `setup --yes`, then a restart. Setup adds a `rea`
entry to your **user-level** Claude Code config and installs upstream's skill in your
personal skills folder; the dry-run plan lists both before anything is written. The
registered command is pinned to the same `rea-agents` version as the skill text
vendored in `plugins/artibot/vendor/rea`.

Verify with `claude mcp list` after the restart (expect `rea` to show as connected).
To undo, run `claude mcp remove --scope user rea` and delete the
`.claude/skills/reverse-engineer-anything` folder in your home directory.

The first run installs the package and its dependencies through `npx`: it takes a
while and uses hundreds of MB of disk, and the optional dependency `frida` downloads
a native binary from GitHub in an install script. The supply-chain notes are in
`commands/rea.md`.

---

## References

- context7: <https://github.com/upstash/context7>
- playwright MCP: <https://github.com/executeautomation/mcp-playwright>
- chrome-devtools MCP: <https://github.com/ChromeDevTools/chrome-devtools-mcp>
