# host-payloads — frozen host hook-payload key sets

Frozen fixtures of **key names only** captured from a live Claude Code host,
one file per hook event (`<Event>.<ToolName>.json` when the event is
tool-scoped). They exist so that hook code and its tests are written against
measured host facts, not guessed ones (INCIDENT-2026-09-03 §6.1 ①,
ROUTE-RECEIPT-PRETOOLUSE design §1.2).

Rules:

- **No values.** No prompts, paths, ids, `cwd`, `session_id`,
  `transcript_path`. If a value is needed for a test, synthesize it in the
  test — never paste it here. Quick check: grep the file for your OS username,
  your home-directory path, and any session or tool-use id you saw during the
  probe; every count must be 0.
- **Frozen.** A fixture states what the host looked like at `host_version`.
  Do not edit it to make a test pass. When a newer host changes the key set,
  re-probe and commit a new capture; the diff is the record that the host
  contract changed.
- **Live probe, not CI.** Regenerating requires a real host session. It never
  runs in CI.

## Regenerating `PreToolUse.Agent.json`

1. Write a temporary settings file outside the repo (the session scratchpad):

   ```json
   {
     "hooks": {
       "PreToolUse":   [{ "matcher": "Agent", "hooks": [{ "type": "command", "command": "node <repo>/plugins/artibot/scripts/dev/probe-hook-keys.js", "timeout": 10 }] }],
       "SubagentStart": [{ "matcher": "*",     "hooks": [{ "type": "command", "command": "node <repo>/plugins/artibot/scripts/dev/probe-hook-keys.js", "timeout": 10 }] }]
     }
   }
   ```

   Do not put this in `~/.claude/settings.json` or `hooks/hooks.json`.
   `--settings` merges with existing hooks (measured 2026-09-04, host 2.1.260).

2. Run the three scenarios headless from the repo root, one session each:

   ```bash
   claude -p --settings <scratch>/probe-settings.json --output-format json --max-turns 8 < scenario-a.txt   # 1 unnamed Agent
   claude -p --settings <scratch>/probe-settings.json --output-format json --max-turns 8 < scenario-b.txt   # 3 named Agents in one turn
   claude -p --settings <scratch>/probe-settings.json --output-format json --max-turns 8 < scenario-c.txt   # 2 unnamed Agents in one turn
   ```

   Each scenario prompt tells the model to call `Agent` with
   `subagent_type: general-purpose` and a subagent prompt of
   "Reply with the single word ok. Do not use any tools."

3. Read the rows from `~/.claude/artibot/runtime/probe-keys.ndjson`
   (one line per hook firing, key names only) and count PreToolUse /
   SubagentStart rows per scenario.

4. Read `host_version` from the probe sessions' transcripts:
   `grep -a -o '"version":"[0-9.]*"' ~/.claude/projects/<slug>/<session_id>.jsonl | sort -u`.

5. Write the new capture into the fixture with `verdict` per design §1.2:
   `prompt`, `description`, `subagent_type` all present in `tool_input`
   → `"D1-go"`; any missing → `"revert-to-C"` with the missing keys listed.
