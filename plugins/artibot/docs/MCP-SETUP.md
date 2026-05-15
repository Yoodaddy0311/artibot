# MCP Setup Guide

Artibot ships three MCP servers via `plugins/artibot/.mcp.json`:

| Server | Transport | Auth | Purpose |
|---|---|---|---|
| `context7` | stdio (npx) | none | Library/framework documentation lookup |
| `playwright` | stdio (npx) | none | Browser automation for E2E |
| `github` | http (remote) | PAT | Read GitHub repos / issues / PRs / code-scanning alerts |

`context7` and `playwright` work out of the box. `github` requires one-time PAT setup.

---

## GitHub MCP — One-Time PAT Setup

The official GitHub MCP server (`github/github-mcp-server`) is hosted by GitHub at `https://api.githubcopilot.com/mcp/`. Artibot configures it via the `http` transport and authenticates with your Personal Access Token, read from the `GITHUB_TOKEN` environment variable.

**Read-only by design.** Allow-list (`mcp__github__*`) and recommended PAT scopes are scoped to read operations. Do not grant write scopes unless you explicitly need them.

### 1. Create a Fine-grained PAT (recommended)

1. Open <https://github.com/settings/personal-access-tokens/new>
2. Token name: `artibot-mcp-readonly`
3. Expiration: 90 days (rotate regularly)
4. Repository access: select the repos Artibot agents should see
5. Repository permissions (Read only):
   - **Contents**: Read
   - **Issues**: Read
   - **Pull requests**: Read
   - **Metadata**: Read (auto-enabled)
   - **Code scanning alerts**: Read (optional, for `security-reviewer`)
   - **Dependabot alerts**: Read (optional, for `security-reviewer`)
6. Click **Generate token** and copy the value (`github_pat_...`).

### 2. Set the `GITHUB_TOKEN` environment variable

**Windows (PowerShell — persistent for current user):**
```powershell
[System.Environment]::SetEnvironmentVariable("GITHUB_TOKEN", "github_pat_xxxxx", "User")
```
Open a new shell after running. Verify with `$env:GITHUB_TOKEN`.

**macOS / Linux (zsh):**
```bash
echo 'export GITHUB_TOKEN=github_pat_xxxxx' >> ~/.zshrc
source ~/.zshrc
```

**macOS / Linux (bash):**
```bash
echo 'export GITHUB_TOKEN=github_pat_xxxxx' >> ~/.bashrc
source ~/.bashrc
```

**Per-project `.env` (alternative — keep out of git):**
```
GITHUB_TOKEN=github_pat_xxxxx
```
Confirm `.env` is in `.gitignore` before saving.

### 3. Verify

Restart Claude Code so it re-reads `.mcp.json`, then run:
```bash
claude mcp list
```
The `github` entry should appear without error. If it shows missing-auth, the env var did not propagate — open a fresh shell and retry.

---

## Security Notes

- **Never commit a PAT.** Treat it like a password. If leaked, revoke immediately at <https://github.com/settings/tokens>.
- **Prefer fine-grained PATs** over classic tokens — they scope to specific repos and individual permissions.
- **Rotate every 60–90 days.** Generate a new PAT, update `GITHUB_TOKEN`, then revoke the old one.
- **Read-only is the default.** Artibot's `autopilot.mcp.allowList` permits `mcp__github__*` reads; write tools (create issue/PR, push) are blocked at the MCP layer regardless of PAT scope.

---

## Which Agents Use the GitHub MCP

Only agents with `availableMcps: [github]` in their frontmatter can call GitHub tools:

- `orchestrator` — delegation context (which PRs/issues are open)
- `code-reviewer` — fetch PR diffs, files, review threads
- `security-reviewer` — read code-scanning / Dependabot alerts
- `frontend-developer`, `backend-developer` — fetch issue/PR context for the work they implement

Other agents (data-analyst, content-marketer, presentation-designer, …) cannot access GitHub MCP tools. To extend access, add `availableMcps: [github]` to that agent's frontmatter and re-load.

---

## Disabling

To disable the GitHub MCP entirely without removing the entry, simply unset `GITHUB_TOKEN`:
```powershell
[System.Environment]::SetEnvironmentVariable("GITHUB_TOKEN", $null, "User")
```
The `.mcp.json` entry will still be parsed but the server will fail authentication and Claude Code will skip it. Other MCPs (context7, playwright) are unaffected.

To remove permanently, delete the `"github"` block from `plugins/artibot/.mcp.json`.

---

## References

- Official server source: <https://github.com/github/github-mcp-server>
- Claude Code install guide: <https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-claude.md>
- Fine-grained PAT docs: <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token>
