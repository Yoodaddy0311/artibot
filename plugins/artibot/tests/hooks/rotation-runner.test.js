import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '..', '..', 'scripts', 'hooks', 'rotation-runner.js');

function run(stdinJson) {
  return execFileSync('node', [HOOK], {
    input: stdinJson,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runCaptureStderr(stdinJson) {
  try {
    execFileSync('node', [HOOK], {
      input: stdinJson,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return '';
  } catch (err) {
    return err?.stderr?.toString?.() ?? '';
  }
}

describe('rotation-runner hook/safety contract', () => {
  it('빈 stdin에도 exit 0 (쓰기 없어도 crash 안 남)', () => {
    const out = run('{}');
    // rotation-runner writes to stderr, stdout remains empty
    expect(typeof out).toBe('string');
  });

  it('stderr에 rotation 요약 출력', () => {
    // Use spawnSync to capture both streams reliably.
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('node', [HOOK], { input: '{}', encoding: 'utf-8' });
    expect(r.status).toBe(0);
    // Should include the [rotation] tag
    expect(r.stderr).toContain('[rotation]');
  });

  it('4개 파일 모두 리포트에 포함 (daily-experiences, skill-injection-log, patterns, learning-log)', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('node', [HOOK], { input: '{}', encoding: 'utf-8' });
    expect(r.stderr).toContain('daily-experiences');
    expect(r.stderr).toContain('skill-injection-log');
    expect(r.stderr).toContain('patterns');
    expect(r.stderr).toContain('learning-log');
  });

  it('비정상 stdin에도 never throw', () => {
    expect(() => run('not-json')).not.toThrow();
  });

  it('exit code 0 (성공)', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('node', [HOOK], { input: '{}', encoding: 'utf-8' });
    expect(r.status).toBe(0);
  });

  // Silence unused import warning
  void runCaptureStderr;
});
