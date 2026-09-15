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

`probe-hook-keys.test.js` in this directory tests the probe script's
guarantees (stdout empty, exit 0, key names only) and the fixture's format
and verdict rule. It sits here only because the `l2-probe` split limb owned
no other test path; relocating it to `tests/hooks/` is fine.

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

## Regenerating `PostToolUse.Skill.json`

Same mechanism as above (temporary `--settings` file in the scratchpad, never
`~/.claude/settings.json` or `hooks/hooks.json`), measured 2026-09-15 on host 2.1.272.

1. Register the probe on **both** `PreToolUse` and `PostToolUse` with the plain
   string matcher `"Skill"` (the `tool == "Skill"` expression form is untested
   here and did not fire in an earlier probe). `scripts/dev/probe-hook-keys.js`
   records top-level keys and `tool_input` keys only; to see `tool_response`
   keys add a second, scratchpad-only hook command that prints
   `Object.keys(tool_response)` (and JSON types) to a scratchpad ndjson. Do not
   add that companion to the repo, and never record values.

2. Run two scenarios headless from the repo root, one session each, `--max-turns 6`:
   (1) "Invoke the Skill tool exactly once with skill `artibot:quickstart` and no
   arguments, then reply ok"; (2) the same with a one-word `args`. Every
   `skills/*/SKILL.md` declares `context: fork`, so pick a skill whose body does
   nothing external; `artibot:quickstart` was used.

3. Read the new rows from `~/.claude/artibot/runtime/probe-keys.ndjson` filtered
   by `tool_name == "Skill"` and by timestamp -- the file is append-only and other
   sessions may write rows into it concurrently. Expect 1 PreToolUse + 1
   PostToolUse row per scenario.

4. Read `host_version` from the two probe transcripts (step 4 above) and record
   the branch/reflog of the worktree before and after each run (a SessionStart
   hook once moved worktree branches; verify it did not).

5. Write the capture with `verdict` = `"skill-key-present"` iff `tool_input.skill`
   was present on every Skill row, else `"skill-key-absent:<keys seen>"`.
