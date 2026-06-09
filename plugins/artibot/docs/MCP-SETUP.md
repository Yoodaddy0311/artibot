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
      "args": ["-y", "@upstash/context7-mcp@latest"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@executeautomation/playwright-mcp-server@latest"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

> **Note (Claude Code v2.1.69 bug #30989):** do not set `defer_loading` and
> `cache_control` simultaneously on the same server entry — MCP fails to load.

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

## References

- context7: <https://github.com/upstash/context7>
- playwright MCP: <https://github.com/executeautomation/mcp-playwright>
- chrome-devtools MCP: <https://github.com/ChromeDevTools/chrome-devtools-mcp>
