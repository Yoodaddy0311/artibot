/**
 * Tests for the dev-only probe `scripts/dev/probe-hook-keys.js` and for the
 * frozen fixture `PreToolUse.Agent.json` that it produced.
 *
 * Why this file lives inside a fixtures directory: split limb `l2-probe`
 * (run split-9d6dc2) owns exactly two paths — the probe script and this
 * `host-payloads/` directory. `tests/hooks/*.test.js` is outside that
 * allowlist, and the review gate refuses code without tests, so the test
 * sits in the only owned location. The integration leader may move it to
 * `tests/hooks/probe-hook-keys.test.js` (or delete the probe altogether —
 * it is a temporary dev tool).
 *
 * The probe's contract (its header, 2026-09-04):
 *   - stdout is empty on every path (PreToolUse is a blocking point)
 *   - exit code is 0 on every path, including non-JSON stdin
 *   - it never throws to the host; a failure is one stderr line
 *   - it writes KEY NAMES only — no value of any field, no cwd/session_id/paths
 *
 * The script resolves its output file from `os.homedir()`, which on Windows
 * follows USERPROFILE and on POSIX follows HOME, so each test points both at
 * a fresh temp directory and never touches the real ~/.claude.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'dev', 'probe-hook-keys.js');
const FIXTURE = path.join(HERE, 'PreToolUse.Agent.json');

/** Run the probe with stdin = `input`, home = `home`. Never throws. */
function runProbe(input, home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CODE_VERSION;
  return spawnSync(process.execPath, [SCRIPT], { input, env, encoding: 'utf8' });
}

function rowsIn(home) {
  const file = path.join(home, '.claude', 'artibot', 'runtime', 'probe-keys.ndjson');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Every value below is a sentinel: none of them may appear in the ndjson row.
const SENTINELS = ['SID-SENTINEL', 'C:/SENTINEL/x.jsonl', 'C:/SENTINEL', 'toolu_SENTINEL', 'prompt-SENTINEL', 'PROMPT BODY SENTINEL', 'desc-SENTINEL', 'name-SENTINEL', 'model-SENTINEL'];
const FULL_PAYLOAD = JSON.stringify({
  session_id: 'SID-SENTINEL',
  transcript_path: 'C:/SENTINEL/x.jsonl',
  cwd: 'C:/SENTINEL',
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_use_id: 'toolu_SENTINEL',
  prompt_id: 'prompt-SENTINEL',
  tool_input: { prompt: 'PROMPT BODY SENTINEL', description: 'desc-SENTINEL', subagent_type: 'artibot:tdd-guide', name: 'name-SENTINEL', model: 'model-SENTINEL' },
});

describe('scripts/dev/probe-hook-keys.js', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'probe-keys-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('full Agent payload: stdout empty, exit 0, one row with key names only', () => {
    const r = runProbe(FULL_PAYLOAD, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');

    const rows = rowsIn(home);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.hook_event_name).toBe('PreToolUse');
    expect(row.tool_name).toBe('Agent');
    expect(row.top_level_keys).toEqual(['cwd', 'hook_event_name', 'prompt_id', 'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'transcript_path']);
    expect(row.tool_input_keys).toEqual(['description', 'model', 'name', 'prompt', 'subagent_type']);
    expect(row.has_prompt_id).toBe(true);
    expect(row).not.toHaveProperty('tool_input_type');
    expect(Object.keys(row).sort()).toEqual(['has_prompt_id', 'hook_event_name', 'host_version', 'tool_input_keys', 'tool_name', 'top_level_keys', 'ts']);

    const serialized = JSON.stringify(row);
    for (const s of SENTINELS) expect(serialized).not.toContain(s);
  });

  it('SubagentStart payload (no tool_input): tool_input_keys is null, no type field', () => {
    const r = runProbe(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'SID-SENTINEL', agent_type: 'general-purpose', cwd: 'C:/SENTINEL' }), home);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const [row] = rowsIn(home);
    expect(row.hook_event_name).toBe('SubagentStart');
    expect(row.tool_name).toBeNull();
    expect(row.tool_input_keys).toBeNull();
    expect(row).not.toHaveProperty('tool_input_type');
    expect(row.has_prompt_id).toBe(false);
    expect(JSON.stringify(row)).not.toContain('SENTINEL');
  });

  it('non-object tool_input (host masking case): records the JSON type, never the value', () => {
    const r = runProbe(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: 'MASKED SENTINEL' }), home);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const [row] = rowsIn(home);
    expect(row.tool_input_keys).toBeNull();
    expect(row.tool_input_type).toBe('string');
    expect(JSON.stringify(row)).not.toContain('SENTINEL');
  });

  it('non-JSON stdin: stdout empty, exit 0, one stderr line, no row written', () => {
    const r = runProbe('not json at all', home);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(rowsIn(home)).toHaveLength(0);
  });

  it('empty stdin: stdout empty, exit 0, no row written', () => {
    const r = runProbe('', home);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(rowsIn(home)).toHaveLength(0);
  });

  it('appends: two payloads → two rows', () => {
    runProbe(FULL_PAYLOAD, home);
    runProbe(FULL_PAYLOAD, home);
    expect(rowsIn(home)).toHaveLength(2);
  });
});

describe('fixture PreToolUse.Agent.json', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it('declares itself value-free and carries the §6.1 ① required fields', () => {
    expect(typeof fixture._note).toBe('string');
    expect(fixture.extraction_method).toBe('live probe via --settings, key names only');
    for (const key of ['host_version', 'extracted_at_kst', 'scenarios', 'PreToolUse', 'SubagentStart', 'verdict', 'missing']) {
      expect(fixture).toHaveProperty(key);
    }
    expect(fixture.host_version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const s of fixture.scenarios) {
      for (const key of ['id', 'spawns', 'pretooluse_rows', 'subagentstart_rows']) expect(s).toHaveProperty(key);
    }
  });

  it('verdict follows design §1.2: D1-go iff prompt, description, subagent_type are always present', () => {
    const always = new Set(fixture.PreToolUse.tool_input_keys_always);
    const missing = fixture.required_keys_for_D1.filter((k) => !always.has(k));
    expect(fixture.missing).toEqual(missing);
    expect(fixture.verdict).toBe(missing.length === 0 ? 'D1-go' : 'revert-to-C');
  });

  it('contains no values: no user path, no tool-use id, no session id shape', () => {
    const text = readFileSync(FIXTURE, 'utf8');
    expect(text).not.toMatch(/HeechangLee|toolu_|\/Users\//);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
