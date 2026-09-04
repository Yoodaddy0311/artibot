#!/usr/bin/env node
/**
 * dev-only probe, not registered in hooks.json, never run in CI.
 *
 * Purpose (ROUTE-RECEIPT-PRETOOLUSE design §1.2, D0 live probe):
 *   Record WHICH KEYS a live Claude Code host puts on a hook payload —
 *   top-level keys, and the keys of `tool_input` when present — so the
 *   D1 receipt hook can be written against measured facts instead of
 *   guessed ones.
 *
 * Rules (non-negotiable):
 *   - VALUES ARE NEVER WRITTEN. Not the prompt, not paths, not ids, not
 *     `cwd`, not `session_id`. Only key NAMES, one boolean for
 *     `prompt_id` presence, and the JSON type of `tool_input` when it is
 *     not a plain object (host masking / truncation case, design §6 #3).
 *   - stdout stays EMPTY. PreToolUse is a blocking point; any stdout could
 *     be read as a decision. exit code is always 0.
 *   - Never throws. Everything is wrapped; a failure is one stderr line.
 *
 * Registration: only via a temporary `claude --settings <file>` hooks file
 * (PreToolUse matcher `Agent` + SubagentStart matcher `*`). Never add this
 * to `hooks/hooks.json`.
 *
 * Output: one NDJSON line appended to
 *   ~/.claude/artibot/runtime/probe-keys.ndjson
 *   { ts, hook_event_name, tool_name, top_level_keys, tool_input_keys | null,
 *     tool_input_type?, has_prompt_id, host_version }
 * `host_version` comes from the CLAUDE_CODE_VERSION env var when the host
 * sets one, else null — the authoritative version is read from the probe
 * session's transcript `.jsonl` ("version":"<v>") afterwards.
 */
// ESM: plugins/artibot/package.json declares "type": "module" — `require` is
// not available here (the first self-test on 2026-09-04 died with exit 1 on
// exactly that; kept as a note so nobody "fixes" this back to CommonJS).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function main() {
  let raw;
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`probe-hook-keys: stdin read failed: ${err && err.code ? err.code : 'unknown'}\n`);
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.stderr.write('probe-hook-keys: stdin is not JSON\n');
    return;
  }

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(data)) {
    process.stderr.write('probe-hook-keys: payload is not an object\n');
    return;
  }

  const row = {
    ts: new Date().toISOString(),
    hook_event_name: typeof data.hook_event_name === 'string' ? data.hook_event_name : null,
    tool_name: typeof data.tool_name === 'string' ? data.tool_name : null,
    top_level_keys: Object.keys(data).sort(),
    tool_input_keys: null,
    has_prompt_id: Object.prototype.hasOwnProperty.call(data, 'prompt_id'),
    host_version: typeof process.env.CLAUDE_CODE_VERSION === 'string' ? process.env.CLAUDE_CODE_VERSION : null,
  };

  if (Object.prototype.hasOwnProperty.call(data, 'tool_input')) {
    const ti = data.tool_input;
    if (isObj(ti)) {
      row.tool_input_keys = Object.keys(ti).sort();
    } else {
      row.tool_input_keys = null;
      row.tool_input_type = ti === null ? 'null' : Array.isArray(ti) ? 'array' : typeof ti;
    }
  }

  try {
    const dir = path.join(os.homedir(), '.claude', 'artibot', 'runtime');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'probe-keys.ndjson'), JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`probe-hook-keys: append failed: ${err && err.code ? err.code : 'unknown'}\n`);
  }
}

try {
  main();
} catch (err) {
  try {
    process.stderr.write(`probe-hook-keys: unexpected: ${err && err.name ? err.name : 'Error'}\n`);
  } catch {
    // stderr itself is unavailable (closed pipe) — nothing left to report to; exit 0 regardless.
  }
}
process.exitCode = 0;
