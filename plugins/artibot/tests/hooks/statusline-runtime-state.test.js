/**
 * statusline.sh must read the hook state from where the hooks WRITE it. (O2)
 *
 * ── the defect this pins ─────────────────────────────────────────────────────
 * `scripts/hooks/statusline.sh` read `$PLUGIN_ROOT/runtime/{current-teammates,
 * token-usage-session,current-effort,long-context-active}.json`, where
 * `PLUGIN_ROOT` is two directories above the SCRIPT — `~/.claude/artibot` for the
 * copy install.sh places and users wire into settings.json. The hooks, run by
 * Claude Code from the marketplace cache, wrote the same file names to THEIR
 * plugin root, `~/.claude/plugins/cache/artibot/artibot/<v>/runtime/`. Measured
 * 2026-09-30: `~/.claude/artibot/runtime/` held account-badge.json,
 * checkpoints.json and probe files and none of those four, while the cache
 * version dirs held `current-teammates.json` / `token-usage-session.json`. The
 * team and token segments could not render from a marketplace install (inferred
 * for the live bar; the owner's wired bar is the THEMED variant, which renders
 * neither segment).
 *
 * Now hooks write session state to
 * `~/.claude/artibot/runtime/sessions/<session_id>/<file>` and this script — which
 * gets `session_id` on stdin — reads its own session's file first, then the flat
 * file in the state dir, then the flat file under the plugin root (state from a
 * hook that predates O2).
 *
 * ── how these tests run the script ──────────────────────────────────────────
 * Two layers, because a full `statusline.sh` run is slow where `fork()` is slow:
 * measured 2026-09-30 on Windows 11 / Git Bash, ONE run took 34 s unloaded and up to
 * 165 s while other jobs ran (the script has 57 `$(...)` command substitutions, each a
 * fork, plus the processes they start; where fork is cheap it should be far faster —
 * not measured here). So
 *   1. the state-resolution block is EXTRACTED from the deployed file between its
 *      `# >>> artibot-runtime-state >>>` markers and run on its own — fast, and
 *      it cannot drift from the script because it IS the script's text (the same
 *      approach as statusline-zero-result-segment.test.js); a missing marker is
 *      RED, not a skip;
 *   2. ONE end-to-end run of the whole script, fed by the REAL hook writers, proves
 *      the block is actually called and that a hook and this script agree on a path.
 *
 * WHAT THIS CANNOT SEE: the themed variant (it reads none of these files), a real
 * Claude Code statusLine payload (stdin here is synthesized from the documented
 * schema), or a shell where `bash` is WSL's (the suite skips there, see
 * scripts/utils/bash-compat.js).
 */

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';
import { resolveArtibotDir } from '../../lib/core/config.js';
import { resolveSessionStatePath, sanitizeSessionId } from '../../lib/core/runtime-state.js';
import { announceBashSkip, probeBash, toBashPath } from '../../scripts/utils/bash-compat.js';
import { makeVersionRoot } from '../helpers/linked-plugin-root.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATUSLINE_SRC = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh');
const THEMED_SRC = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline-themed.sh');
const WORKFLOW_STATUS = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'workflow-status.js');

const BEGIN = '# >>> artibot-runtime-state >>>';
const END = '# <<< artibot-runtime-state <<<';

const BASH = probeBash();
if (!BASH.ok) announceBashSkip('statusline-runtime-state', BASH.reason);

// Every case here spawns bash; under a busy machine one spawn alone can cross the 30 s default.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const lf = (text) => text.replace(/\r\n/g, '\n');
const sourceText = lf(readFileSync(STATUSLINE_SRC, 'utf8'));

let base;
let home;
let project;
let savedEnv;
const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME', 'ARTIBOT_USER_PROFILE_PATH',
  'CLAUDE_PLUGIN_ROOT', 'ARTIBOT_RUNTIME_CHECKPOINT_DISABLE', 'ARTIBOT_RUNTIME_MEMORY_DISABLE',
];

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-sl-o2-'));
  home = path.join(base, 'home');
  project = path.join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(project, '.git'), { recursive: true });
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ARTIBOT_STATE_DIR;
  delete process.env.ARTIBOT_STATE_DIR_HOME;
  delete process.env.ARTIBOT_USER_PROFILE_PATH;
  process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
  process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

/** The script's own text between the markers, or null. */
function extractBlock() {
  const start = sourceText.indexOf(BEGIN);
  const end = sourceText.indexOf(END);
  return start >= 0 && end > start ? sourceText.slice(start, end + END.length) : null;
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/**
 * Run `call` (shell text) with the extracted block sourced, under the same shell
 * options the script sets. `input` is the statusLine stdin JSON the block parses;
 * `args` reach `call` as "$@" (after a `shift 4`).
 */
function runBlock({ input, pluginRoot, call, args = [] }) {
  const block = extractBlock();
  if (block === null) throw new Error('statusline.sh has lost its artibot-runtime-state markers');
  const blockFile = path.join(base, 'block.sh');
  writeFileSync(blockFile, `${block}\n`);
  const r = spawnSync('bash', [
    '-c',
    'set -euo pipefail; input="$1"; PLUGIN_ROOT="$2"; . "$3"; eval "$4"',
    '_', input, toBashPath(pluginRoot), toBashPath(blockFile), call, ...args,
  ], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/**
 * Source the block once PER INPUT inside ONE shell and run `probe` after each, one
 * output line per input. A shell spawn is ~1 s here (Git Bash's fork is slow; hundreds
 * of ms on Linux) and a spawn per case is what made this suite time out when the machine
 * was busy — the block's top-level statements recompute from `$input` every time it is
 * sourced, which is exactly the per-render behaviour under test.
 *
 * @returns {string[]} one line per input (probe output must not contain a newline)
 */
function runBlockEach({ inputs, pluginRoot, probe }) {
  const block = extractBlock();
  if (block === null) throw new Error('statusline.sh has lost its artibot-runtime-state markers');
  const blockFile = path.join(base, 'block.sh');
  writeFileSync(blockFile, `${block}\n`);
  const r = spawnSync('bash', [
    '-c',
    'set -euo pipefail; PLUGIN_ROOT="$1"; BLOCK="$2"; shift 2; '
      + 'for input in "$@"; do . "$BLOCK"; eval "$PROBE"; printf "\\n"; done',
    '_', toBashPath(pluginRoot), toBashPath(blockFile), ...inputs,
  ], { encoding: 'utf8', env: { ...process.env, PROBE: probe, HOME: home, USERPROFILE: home } });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\n').slice(0, inputs.length);
}

const stateRoot = () => resolveArtibotDir();

describe('statusline.sh — the state-resolution block', () => {
  it('is present in the deployed script, between its markers (fail-closed, never a skip)', () => {
    expect(extractBlock()).not.toBeNull();
    expect(sourceText).toMatch(/state_file current-effort\.json/);
    expect(sourceText).toMatch(/state_file current-teammates\.json/);
    expect(sourceText).toMatch(/state_file long-context-active\.json/);
    expect(sourceText).toMatch(/state_file token-usage-session\.json/);
  });

  it('no longer reads the four files straight from $PLUGIN_ROOT/runtime', () => {
    // The pre-O2 spelling. A tripwire: each of these is a read that bypasses state_file.
    for (const name of ['current-effort', 'current-teammates', 'long-context-active', 'token-usage-session']) {
      expect(sourceText, `${name}.json is read through state_file, not by literal path`)
        .not.toMatch(new RegExp(`\\$PLUGIN_ROOT/runtime/${name}\\.json`));
    }
  });

  it('the block\'s CODE forks at most once (the jq read) — a command substitution is a fork, and this runs every render', () => {
    const code = extractBlock().split('\n').filter((line) => !/^\s*#/.test(line));
    // Every `$(` in the block's code, with its line, so a regression names itself.
    const forks = code.filter((line) => line.includes('$('));
    expect(forks.map((line) => line.trim())).toEqual(['SESSION_ID_RAW=$(_session_id_via_jq || true)']);
    // nor pipes nor external text tools on the no-jq path
    expect(code.join('\n')).not.toMatch(/\|\s*(sed|grep|head|cut|tr|awk)\b/);
  });

  it('the themed variant reads none of these (so it needs no change)', () => {
    const themed = lf(readFileSync(THEMED_SRC, 'utf8'));
    for (const name of ['current-effort', 'current-teammates', 'long-context-active', 'token-usage-session']) {
      expect(themed).not.toContain(name);
    }
  });

  describe.skipIf(!BASH.ok)('precedence', () => {
    const pluginRoot = () => path.join(base, 'plugin');
    const sessionFile = (sid) => path.join(stateRoot(), 'runtime', 'sessions', sid, 'current-teammates.json');
    const who = (line) => (line ? JSON.parse(line).who : '');

    /**
     * `who` of the file `state_file` picks for each input, '' when it picks none. The file is
     * CAT-ed inside bash: the path it prints is in the shell's own spelling (`/tmp/…` under
     * Git Bash), which node on Windows would read as `C:\tmp\…`.
     */
    const PICK = 'state_file current-teammates.json; if [ -n "$STATE_FILE" ]; then cat "$STATE_FILE"; fi';
    const payload = (sid) => JSON.stringify({ session_id: sid });

    it('session file > flat file in the state dir > plugin-root file, and no session ever reads another\'s', () => {
      writeJson(sessionFile('sess-A'), { who: 'A' });
      writeJson(sessionFile('sess-B'), { who: 'B' });
      writeJson(path.join(stateRoot(), 'runtime', 'current-teammates.json'), { who: 'flat' });
      writeJson(path.join(pluginRoot(), 'runtime', 'current-teammates.json'), { who: 'legacy' });
      // `sessions/../../../evil` would resolve to <home>/.claude/evil if the id were used raw.
      writeJson(path.join(home, '.claude', 'evil', 'current-teammates.json'), { who: 'evil' });

      const picked = runBlockEach({
        inputs: [payload('sess-A'), payload('sess-B'), payload('sess-C'), '{}', payload('../../../evil')],
        pluginRoot: pluginRoot(),
        probe: PICK,
      }).map(who);

      expect(picked).toEqual([
        'A', //      its own session file, over the flat and the legacy ones
        'B', //      a different session reads a different file — B never sees A's
        'flat', //   a session with no file of its own falls back to the state dir's flat file
        'flat', //   a payload with no session id still reads the flat files
        'flat', //   a hostile id is sanitized, so it cannot point outside sessions/
      ]);
    });

    it('falls back to the plugin-root file last (state a hook wrote before O2), and to nothing when there is none', () => {
      writeJson(path.join(pluginRoot(), 'runtime', 'current-teammates.json'), { who: 'legacy' });

      // The probe removes the file it read, so the SECOND pass finds no candidate at all.
      const picked = runBlockEach({
        inputs: [payload('sess-A'), payload('sess-A')],
        pluginRoot: pluginRoot(),
        probe: 'state_file current-teammates.json; if [ -n "$STATE_FILE" ]; then cat "$STATE_FILE"; rm -f "$STATE_FILE"; fi',
      }).map(who);

      expect(picked).toEqual(['legacy', '']); // and the script survived `set -euo pipefail` with nothing found
    });
  });

  describe.skipIf(!BASH.ok)('session id parity with the writers', () => {
    // Session ids are UUIDs, so this is pinned for ASCII: the bash sanitizer is a byte
    // filter and would differ from the JS one on multi-byte characters.
    const IDS = [
      '9120048e-3385-4855-a35b-09c89e5dd684',
      '../../etc/passwd',
      'a b/c',
      '..hidden',
      '-lead-dash',
      'x..y...z',
      'sess:1|2',
      'a'.repeat(200),
    ];

    it('bash and lib/core/runtime-state.js sanitize every ASCII id identically (one shell, all ids)', () => {
      const out = runBlock({
        input: '{}',
        pluginRoot: path.join(base, 'plugin'),
        call: 'shift 4; for id in "$@"; do _sanitize_session_id "$id"; printf "%s\\n" "$SESSION_ID_SAFE"; done',
        args: IDS,
      });
      expect(out.split('\n').slice(0, IDS.length)).toEqual(IDS.map(sanitizeSessionId));
    });

    it('the id the block DERIVES from a payload is the writer\'s directory name', () => {
      const ids = [IDS[0], IDS[1], IDS[7]];
      const derived = runBlockEach({
        inputs: ids.map((id) => JSON.stringify({ session_id: id })),
        pluginRoot: path.join(base, 'plugin'),
        probe: 'printf %s "$SESSION_ID_SAFE"',
      });
      expect(derived).toEqual(ids.map(sanitizeSessionId));
    });

    it('the no-jq reader (bash regex, no process) takes the FIRST session_id, survives a miss, and never aborts', () => {
      const id = '9120048e-3385-4855-a35b-09c89e5dd684';
      const read = runBlockEach({
        inputs: [
          JSON.stringify({ model: { id: 'm' }, session_id: id, cwd: '/x' }),
          JSON.stringify({ model: { id: 'm' }, session_id: id }, null, 2), // pretty-printed, as some hosts emit it
          '{"session_id":"first","nested":{"session_id":"second"}}',
          '{"model":"x"}', //  no match: not an error under set -euo pipefail ...
          '', //               ... nor is an empty payload
          '{"session_id":"after-the-misses"}', // and the loop — the "script" — is still alive to read this
        ],
        pluginRoot: path.join(base, 'plugin'),
        probe: '_session_id_via_bash; printf %s "$SESSION_ID_RAW"',
      });
      expect(read).toEqual([id, id, 'first', '', '', 'after-the-misses']);
    });

    it.skipIf(spawnSync('jq', ['--version'], { encoding: 'utf8' }).status !== 0)(
      'the jq reader and the bash reader agree',
      () => {
        const inputs = [JSON.stringify({ model: { id: 'm' }, session_id: 'sess-jq-1', cwd: '/x' })];
        const viaJq = runBlockEach({
          inputs,
          pluginRoot: path.join(base, 'plugin'),
          probe: 'printf %s "$(_session_id_via_jq || true)"',
        });
        const viaBash = runBlockEach({
          inputs,
          pluginRoot: path.join(base, 'plugin'),
          probe: '_session_id_via_bash; printf %s "$SESSION_ID_RAW"',
        });
        expect(viaJq).toEqual(['sess-jq-1']);
        expect(viaBash).toEqual(viaJq);
      },
    );
  });
});

describe.skipIf(!BASH.ok)('statusline.sh — end to end, fed by the real hook writers', () => {
  it('renders this session\'s effort, team, tokens and long-context, and nothing from another session or the decoys', async () => {
    const root = makeVersionRoot(base, '4.70.0');
    process.env.CLAUDE_PLUGIN_ROOT = root;

    // REAL writers, session A and session B.
    const out = await handleUserPromptSubmit({
      hook_event_name: 'UserPromptSubmit',
      prompt: '/implement add oauth login',
      session_id: 'sess-A',
      prompt_id: 'p-1',
      cwd: project,
    });
    expect(out).not.toBeNull();
    for (const [sid, agent] of [['sess-A', 'alpha'], ['sess-B', 'beta']]) {
      const r = spawnSync(process.execPath, [WORKFLOW_STATUS, 'teammate-update'], {
        input: JSON.stringify({ agent_id: agent, current_task: 'working', session_id: sid, cwd: project }),
        encoding: 'utf8',
        cwd: project,
        env: { ...process.env },
      });
      expect(r.status, r.stderr).toBe(0);
    }
    // long-context is written by session-start.js; the path is the same helper, so seed it with it.
    writeJson(resolveSessionStatePath('sess-A', 'long-context-active.json'), { enabled: true });

    // DECOYS the script must NOT prefer: a flat file in the state dir and a legacy file under its plugin root.
    const scriptPlugin = path.join(base, 'script-plugin');
    const hooksDir = path.join(scriptPlugin, 'scripts', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, 'statusline.sh'), sourceText); // LF copy: a CRLF checkout cannot run under bash
    writeFileSync(path.join(scriptPlugin, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    writeJson(path.join(stateRoot(), 'runtime', 'current-teammates.json'), { teammates: [{ name: 'flatdecoy' }] });
    writeJson(path.join(scriptPlugin, 'runtime', 'current-teammates.json'), { teammates: [{ name: 'legacydecoy' }] });
    writeJson(path.join(scriptPlugin, 'runtime', 'token-usage-session.json'), { totalTokens: 7777777 });

    const r = spawnSync('bash', [toBashPath(path.join(hooksDir, 'statusline.sh'))], {
      input: JSON.stringify({
        session_id: 'sess-A',
        model: { display_name: 'Opus' },
        context_window: { used_percentage: 12 },
      }),
      encoding: 'utf8',
      cwd: project,
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: base },
    });
    expect(r.status, r.stderr).toBe(0);

    const effort = JSON.parse(readFileSync(resolveSessionStatePath('sess-A', 'current-effort.json'), 'utf8')).effort;
    const tokens = JSON.parse(readFileSync(resolveSessionStatePath('sess-A', 'token-usage-session.json'), 'utf8')).totalTokens;
    const tokenLabel = tokens >= 1000 ? `~${Math.floor(tokens / 1000)}K tokens` : `~${tokens} tokens`;

    expect(r.stdout).toContain(`🎚 ${effort}`);
    expect(r.stdout).toContain('👥 alpha');
    expect(r.stdout).toContain('🪟 1M');
    expect(r.stdout).toContain(tokenLabel);
    // isolation + precedence: not B's teammate, not the flat decoy, not the legacy decoys.
    expect(r.stdout).not.toContain('beta');
    expect(r.stdout).not.toContain('flatdecoy');
    expect(r.stdout).not.toContain('legacydecoy');
    expect(r.stdout).not.toContain('~7M'); // the legacy decoy's 7,777,777 tokens
  }, 300_000);
});
