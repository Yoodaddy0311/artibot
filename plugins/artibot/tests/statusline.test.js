import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
