import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(__dirname, '..', '..', 'scripts', 'hooks', 'session-digest.js');

function run(stdinJson) {
  return execFileSync('node', [HOOK], {
    input: stdinJson,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function runCapture(stdinJson) {
  try {
    const stdout = execFileSync('node', [HOOK], {
      input: stdinJson,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

describe('session-digest hook/safety contract', () => {
  it('빈 stdin이어도 crash 없이 SessionStart additionalContext 출력', () => {
    const out = run('{}');
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string');
  });

  it('additionalContext는 [Artibot] prefix로 시작', () => {
    const out = run('{}');
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext.startsWith('[Artibot]')).toBe(true);
  });

  it('학습/패턴/스웜 세 섹션 모두 언급', () => {
    const out = run('{}');
    const parsed = JSON.parse(out);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    // Either full digest or the "unavailable" fallback line.
    const hasSections = ctx.includes('Learning') && ctx.includes('Patterns') && ctx.includes('Swarm');
    const isFallback = ctx.includes('unavailable');
    expect(hasSections || isFallback).toBe(true);
  });

  it('비정상 stdin(잘못된 JSON)에도 exit 0', () => {
    const out = run('not-json-garbage');
    // Should not throw — hook must be resilient.
    expect(out.length).toBeGreaterThan(0);
  });

  it('출력은 유효한 JSON', () => {
    const out = run('{}');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  // Regression guard: bare `main()` previously had no `.catch`, risking an
  // unhandled promise rejection that prints a stack trace and exits non-zero.
  // It is now wrapped with createErrorHandler('session-digest', { exit: true }).
  it('main()은 .catch 가드로 unhandled rejection 트레이스를 흘리지 않음', () => {
    const { stderr } = runCapture('not-json-garbage');
    expect(stderr).not.toContain('UnhandledPromiseRejection');
    expect(stderr).not.toMatch(/at\s+main\b/);
  });

  it('비정상 입력에도 프로세스가 비정상 종료 코드로 죽지 않음', () => {
    const { status } = runCapture('not-json-garbage');
    expect(status).toBe(0);
  });
});
