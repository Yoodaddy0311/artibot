# Optional: Background Learning Schedules

Artibot's nightly trainers and session rollup are **opt-in**. The plugin works without them — they sharpen memory consolidation and the session-rollup pipeline over time. Skip this doc if you do not want background processes.

## When To Enable

- You run Artibot daily and want session data consolidated automatically
- You audit CLAUDE.md with `/audit-claude-md` and want the score fed into the session rollup
- You participate in the swarm and want your `quality` bucket populated

## Trainers

| Job | Cron (UTC) | Purpose |
|---|---|---|
| `nightly-session-rollup` | `30 4 * * *` | Roll up sessions, archive originals > 30d, feed `claudeMdQuality` |
| `nightly-dream-consolidate` | `0 5 * * *` | Phase-1 memory consolidation candidates + wakeup marker (no LLM, no MD writes) |

## Setup

Run the helper script — it prints (does not execute) the commands you need to copy:

```bash
node plugins/artibot/scripts/setup-nightly-trainers.js
```

Add `--cron`, `--schtasks`, or `--schedule` to scope the output. Use `--dry-run` to preview only.

### POSIX (Linux / macOS)

Open your crontab with `crontab -e` and paste the lines printed by `--cron`. Logs are appended to `~/.claude/artibot/<job>.log`.

To disable a single job: delete its row from `crontab -e`.
To disable all: comment out the whole block.

### Windows

Open an elevated PowerShell (Run as administrator) and paste the lines printed by `--schtasks`.

To disable a single job: `schtasks /Delete /TN "Artibot-<job>"`.
To list registered tasks: `schtasks /Query | Select-String Artibot`.

### claude schedule

Persistent across sessions. Requires the Claude CLI with the `schedule` subcommand. Paste the lines printed by `--schedule` into your shell.

To disable: `claude schedule delete <id>` (find the id with `claude schedule list`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `EACCES` on `~/.claude/artibot/*.log` | Directory not yet created | `mkdir -p ~/.claude/artibot` |
| Trainer logs `no episodes yet` every night | No Artibot sessions happened in the previous UTC day | Normal until you use the plugin regularly |
| `claudeMdQuality=n/a` in session-rollup log | `claude-md-auditor` never ran | Run `/audit-claude-md` once; the cache will be picked up next rollup |
| Windows: schtasks "Access denied" | Not running PowerShell as admin | Re-run elevated |
| Swarm `quality` bucket empty in `learning-diag` | Audit cache missing OR sample size < 3 | Run audit on 3+ projects, then trigger a swarm sync |

## Data Policy Reminder

All trainer state stays on disk under `~/.claude/artibot/` and `runtime/observability/` inside the plugin. Nothing is uploaded unless you opt into the swarm explicitly (`artibot.config.json` → `swarm.enabled: true`).
