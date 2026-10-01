import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHomeDir } from '../lib/core/platform.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, '..', 'scripts', 'statusline.js');

function makeTmpRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'artibot-sl-'));
  mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  return dir;
}

function writeConfig(root, cfg) {
  writeFileSync(path.join(root, 'artibot.config.json'), JSON.stringify(cfg, null, 2));
}

function runStatusline(root) {
  return spawnSync('node', [ENTRY], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    encoding: 'utf-8',
  });
}

describe('scripts/statusline.js', () => {
  let tmp;

  beforeEach(() => {
    tmp = makeTmpRoot();
  });

  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('writes empty output when config is missing', () => {
    const r = runStatusline(tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('writes empty output when dashboard.enabled is false (default)', () => {
    writeConfig(tmp, { dashboard: { enabled: false } });
    const r = runStatusline(tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('writes empty output when config is malformed JSON', () => {
    writeFileSync(path.join(tmp, 'artibot.config.json'), '{ malformed');
    const r = runStatusline(tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('writes empty output when CLAUDE_PLUGIN_ROOT points to nonexistent dir', () => {
    const bogus = path.join(tmp, 'does-not-exist');
    const r = spawnSync('node', [ENTRY], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: bogus },
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('never crashes even on unexpected input', () => {
    // Pass a config where dashboard section is missing entirely
    writeConfig(tmp, { unrelated: 'field' });
    const r = runStatusline(tmp);
    expect(r.status).toBe(0);
    // stdout is either empty or a rendered line — never an error
    expect(typeof r.stdout).toBe('string');
  });
});

// O2 — the entrypoint reads `session_id` from the statusLine payload on stdin, because the
// hooks keep per-session state under `<state dir>/runtime/sessions/<session_id>/` and a
// renderer that does not know its session can only show the flat fallback.
describe('scripts/statusline.js — session_id from stdin (O2)', () => {
  let tmp;
  let stateDir;

  beforeEach(() => {
    tmp = makeTmpRoot();
    stateDir = mkdtempSync(path.join(tmpdir(), 'artibot-sl-state-'));
    writeConfig(tmp, { dashboard: { enabled: true, showEffort: true, showTaskBudget: true, showTeammates: true } });
  });

  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    if (stateDir && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  });

  // The child keeps this process's home, so a state dir paired with that home is honoured.
  const childEnv = () => ({
    ...process.env,
    CLAUDE_PLUGIN_ROOT: tmp,
    ARTIBOT_STATE_DIR: stateDir,
    ARTIBOT_STATE_DIR_HOME: getHomeDir(),
  });

  function writeState(relPath, value) {
    const file = path.join(stateDir, 'runtime', ...relPath.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  }

  function render(stdin) {
    return spawnSync('node', [ENTRY], { env: childEnv(), encoding: 'utf-8', input: stdin });
  }

  it('renders the session the payload names — two payloads, two different lines', () => {
    writeState('sessions/sess-A/current-effort.json', { effort: 'xhigh', command: 'implement' });
    writeState('sessions/sess-B/current-effort.json', { effort: 'low', command: 'daily' });

    const a = render(JSON.stringify({ session_id: 'sess-A', model: { display_name: 'Opus' } }));
    const b = render(JSON.stringify({ session_id: 'sess-B' }));

    expect(a.status).toBe(0);
    expect(a.stdout).toContain('effort=xhigh');
    expect(a.stdout).not.toContain('effort=low');
    expect(b.stdout).toContain('effort=low');
    expect(b.stdout).not.toContain('effort=xhigh');
  });

  it('a payload that names a session with no file of its own renders no foreign team or tokens (no flat fallback)', () => {
    writeState('sessions/sess-B/current-effort.json', { effort: 'low', command: 'daily' });
    // what another session, a session-less payload and a pre-O2 hook left behind
    writeState('current-effort.json', { effort: 'xhigh', command: 'flat' });
    writeState('current-teammates.json', { teammates: [{ name: 'ghost-from-other-session' }] });
    writeState('token-usage-session.json', { totalTokens: 987000 });
    writeFileSync(path.join(tmp, 'runtime', 'token-usage-session.json'), JSON.stringify({ totalTokens: 555000 }));

    const own = render(JSON.stringify({ session_id: 'sess-B' }));
    expect(own.status).toBe(0);
    expect(own.stdout).toContain('effort=low');
    for (const ghost of ['ghost', '987K', '555K', 'tokens=', 'team=', 'xhigh']) {
      expect(own.stdout, ghost).not.toContain(ghost);
    }

    // an id and no file at all: nothing — not the flat effort either
    const none = render(JSON.stringify({ session_id: 'sess-Z' }));
    expect(none.status).toBe(0);
    for (const ghost of ['effort=', 'ghost', 'tokens=', 'team=']) {
      expect(none.stdout, ghost).not.toContain(ghost);
    }
  });

  it('falls back to the flat file when the payload carries no session_id, or is not JSON', () => {
    writeState('sessions/sess-A/current-effort.json', { effort: 'xhigh', command: 'implement' });
    writeState('current-effort.json', { effort: 'medium', command: 'flat' });

    for (const stdin of ['', '{}', 'not json', '{"session_id": 42}']) {
      const r = render(stdin);
      expect(r.status).toBe(0);
      expect(r.stdout, `stdin ${JSON.stringify(stdin)}`).toContain('effort=medium');
      expect(r.stdout).not.toContain('xhigh');
    }
  });

  it('does not wait on a parent that never closes stdin (time-boxed read, then renders and exits)', async () => {
    writeState('current-effort.json', { effort: 'medium', command: 'flat' });
    const child = spawn('node', [ENTRY], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });

    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve('hung'); }, 15_000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
      // stdin stays OPEN: nothing is written and nothing is ended.
    });

    expect(exit).toBe(0);
    expect(stdout).toContain('effort=medium');
  }, 30_000);
});
