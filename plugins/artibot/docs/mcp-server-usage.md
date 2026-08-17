# Artibot MCP Server — Usage Guide

`artibot-mcp` exposes Artibot's read-only tools to any
[Model Context Protocol](https://modelcontextprotocol.io) host
(Claude Desktop, Claude Code, IDE plugins) over the stdio transport.

This document covers installation, host configuration, exposed tools,
transport details, and security guarantees.

---

## At a glance

| Property | Value |
|---|---|
| Binary | `artibot-mcp` (from `plugins/artibot/bin/artibot-mcp.mjs`) |
| Transport | stdio JSON-RPC 2.0 (NDJSON) |
| Network | None (local stdio only) |
| Auth | None (trust boundary = your local machine) |
| Dependencies | Zero (Node built-ins) |
| Node | >= 20 |
| Scope | Read-only bridges (git status/log/diff, skill/agent registry, runtime hints) |

---

## Install

The binary is wired into `package.json`:

```json
{
  "bin": {
    "artibot": "./bin/artibot.js",
    "artibot-dashboard": "./bin/artibot-dashboard.mjs",
    "artibot-mcp": "./bin/artibot-mcp.mjs"
  }
}
```

From the plugin root:

```bash
node bin/artibot-mcp.mjs --version    # sanity check
node bin/artibot-mcp.mjs --help
```

If the plugin is installed globally via `npm link` or published to a
registry, `artibot-mcp` is available on PATH directly.

---

## Run standalone (debug)

```bash
artibot-mcp
```

The process reads JSON-RPC 2.0 messages on stdin (one JSON object per
line) and writes responses on stdout. Human-readable logs go to stderr.

Example handshake (pipe into the running process):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

Ctrl+C (SIGINT) or SIGTERM cleanly shut the server down.

---

## MCP host configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "artibot": {
      "command": "artibot-mcp"
    }
  }
}
```

If the binary is not on PATH, use an absolute path:

```json
{
  "mcpServers": {
    "artibot": {
      "command": "node",
      "args": [
        "C:/Users/you/artibot/plugins/artibot/bin/artibot-mcp.mjs"
      ]
    }
  }
}
```

### Claude Code

Register via the Claude Code settings UI (Settings > MCP Servers) or
drop the same JSON into the user-level `mcpServers` block. Claude Code
spawns the command as a child process and speaks stdio.

### Generic MCP host

Any host that supports the stdio transport and MCP protocol version
`2024-11-05` (or later) will work. The server advertises
`capabilities.tools = {}` during `initialize`.

---

## Exposed tools (planned)

> Delivered by MS2 bridges. Until MS2 lands, the fallback loop answers
> `tools/list` with an empty array.

| Tool | Purpose | Side-effect |
|---|---|---|
| `git_status` | `git status --porcelain=v2` parsed into structured output | Read-only |
| `git_log` | Recent commit metadata (hash, author, subject) | Read-only |
| `git_diff` | Diff for a ref or working tree | Read-only |
| `git_show` | Show a commit or blob | Read-only |
| `skill_list` | Enumerate installed skills with metadata | Read-only |
| `skill_get` | Fetch a skill's README + frontmatter | Read-only |
| `agent_list` | Enumerate registered agents | Read-only |
| `runtime_hint` | Suggest an Artibot route/agent for a prompt | Read-only |

All tool schemas and examples are published via `tools/list`. Use an
MCP inspector to browse them interactively.

---

## Transport details

- **Encoding**: newline-delimited JSON (NDJSON), UTF-8.
- **Framing**: one JSON-RPC message per line on stdin / stdout.
- **Errors**: standard JSON-RPC codes
  (`-32700` parse error, `-32601` method not found, `-32602` invalid
  params, `-32603` internal error).
- **stderr**: reserved for human-readable logs. Never mix with protocol.

The server does NOT use the HTTP / Streamable transport. Use
`artibot-mcp` purely as a child process of an MCP host.

---

## Security

| Concern | Mitigation |
|---|---|
| Network exposure | None — no listen socket; the process only reads stdin / writes stdout |
| Authn/authz | Implicit: only a process that spawned `artibot-mcp` can talk to it |
| Write access | Tools are read-only by policy; no file writes, no git mutations, no network egress |
| Secret leakage | `.env` and credential files are never enumerated; skill/agent bridges filter dotfiles |
| Data exfiltration | No outbound HTTP; bridges never send data off the machine |
| Cross-host attacks | N/A — stdio only, no port binding |

Do NOT expose `artibot-mcp` via a tunnel, SSH forward, or wrapper that
accepts remote stdin/stdout. It is designed as a local subprocess.

---

## Troubleshooting

| Symptom | Diagnosis |
|---|---|
| Host says "server exited" immediately | Run `artibot-mcp --version` to verify installation; check `node --version` >= 20 |
| `tools/list` returns `[]` | MS2 bridges not wired — upgrade to the build where `lib/mcp/bridge/` is populated |
| Protocol log garbage on stdout | Something wrote to stdout outside the JSON-RPC loop. File an issue with the offending stderr excerpt |
| Unicode path issues on Windows | Artibot handles Korean/space paths via `new URL('../lib/...', import.meta.url)` — see MEMORY note |
| Host shows `-32700 parse error` | The host sent invalid JSON. Inspect its raw output via an MCP inspector |

---

## Development

```bash
npm run validate:bin    # ensures artibot-mcp is registered and on disk
npm test -- tests/bin/artibot-mcp-smoke.test.js
```

The smoke suite covers:
- `--version` / `--help` / unknown flag handling
- Real subprocess stdio handshake (initialize → response)
- Malformed JSON → `-32700` parse error
- `main(argv, deps)` with an injected mock server (MS1 contract)
- `parseArgs` unit behavior

---

## References

- MCP spec: https://spec.modelcontextprotocol.io
- MS1 server factory: `plugins/artibot/lib/mcp/server.js`
- MS2 bridge registry: `plugins/artibot/lib/mcp/bridge/index.js`
