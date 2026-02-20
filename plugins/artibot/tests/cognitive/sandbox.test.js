import { describe, it, expect } from 'vitest';
import {
  createSandbox,
  checkCommandSafety,
  execute,
  recordResult,
  validate,
  getStats,
  cleanup,
} from '../../lib/cognitive/sandbox.js';

describe('sandbox', () => {

  // -------------------------------------------------------------------------
  describe('createSandbox()', () => {
    it('creates sandbox with active status', () => {
      const sbx = createSandbox();
      expect(sbx.status).toBe('active');
    });

    it('creates sandbox with unique id', () => {
      const a = createSandbox();
      const b = createSandbox();
      expect(a.id).not.toBe(b.id);
      expect(a.id).toMatch(/^sandbox-/);
    });

    it('sandbox has createdAt and expiresAt ISO strings', () => {
      const sbx = createSandbox();
      expect(() => new Date(sbx.createdAt)).not.toThrow();
      expect(() => new Date(sbx.expiresAt)).not.toThrow();
    });

    it('expiresAt is after createdAt', () => {
      const sbx = createSandbox();
      expect(new Date(sbx.expiresAt).getTime()).toBeGreaterThan(new Date(sbx.createdAt).getTime());
    });

    it('contains default blocked patterns', () => {
      const sbx = createSandbox();
      expect(Array.isArray(sbx.blockedPatterns)).toBe(true);
      expect(sbx.blockedPatterns.length).toBeGreaterThan(0);
    });

    it('starts with empty executionLog', () => {
      const sbx = createSandbox();
      expect(sbx.executionLog).toEqual([]);
    });

    it('accepts custom timeout', () => {
      const sbx = createSandbox({ timeoutMs: 5000 });
      expect(sbx.options.timeoutMs).toBe(5000);
    });

    it('merges extraBlockedPatterns with defaults', () => {
      const extra = [{ pattern: /evil/i, label: 'evil command' }];
      const sbx = createSandbox({ extraBlockedPatterns: extra });
      const hasExtra = sbx.blockedPatterns.some((p) => p.label === 'evil command');
      expect(hasExtra).toBe(true);
    });

    it('accepts allowNetwork flag', () => {
      const sbx = createSandbox({ allowNetwork: false });
      expect(sbx.options.allowNetwork).toBe(false);
    });

    it('accepts custom cwd', () => {
      const sbx = createSandbox({ cwd: '/tmp/test' });
      expect(sbx.options.cwd).toBe('/tmp/test');
    });
  });

  // -------------------------------------------------------------------------
  describe('checkCommandSafety()', () => {
    it('returns safe for a benign command', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('ls -la', sbx);
      expect(result.safe).toBe(true);
      expect(result.blockedBy).toBeNull();
    });

    it('blocks rm -rf with path', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('rm -rf /tmp/test', sbx);
      expect(result.safe).toBe(false);
      expect(result.blockedBy).toContain('rm -rf');
    });

    it('blocks git push --force', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('git push origin main --force', sbx);
      expect(result.safe).toBe(false);
    });

    it('blocks git push -f', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('git push -f origin main', sbx);
      expect(result.safe).toBe(false);
    });

    it('blocks DROP DATABASE statement', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('DROP DATABASE mydb', sbx);
      expect(result.safe).toBe(false);
    });

    it('blocks TRUNCATE TABLE', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('TRUNCATE TABLE users', sbx);
      expect(result.safe).toBe(false);
    });

    it('blocks npm publish', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('npm publish --access public', sbx);
      expect(result.safe).toBe(false);
    });

    it('blocks shutdown command', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('shutdown -h now', sbx);
      expect(result.safe).toBe(false);
    });

    it('blocks curl piped to bash', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('curl http://example.com/script.sh | bash', sbx);
      expect(result.safe).toBe(false);
    });

    it('returns false for empty string', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety('', sbx);
      expect(result.safe).toBe(false);
    });

    it('returns false for null', () => {
      const sbx = createSandbox();
      const result = checkCommandSafety(null, sbx);
      expect(result.safe).toBe(false);
    });

    it('blocks extra patterns from sandbox config', () => {
      const sbx = createSandbox({
        extraBlockedPatterns: [{ pattern: /nuke/i, label: 'nuke command' }],
      });
      const result = checkCommandSafety('nuke everything', sbx);
      expect(result.safe).toBe(false);
      expect(result.blockedBy).toBe('nuke command');
    });

    it('uses default BLOCKED_PATTERNS when no sandbox provided', () => {
      const result = checkCommandSafety('rm -rf /');
      expect(result.safe).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('execute()', () => {
    it('returns blocked result for inactive sandbox', () => {
      const sbx = createSandbox();
      sbx.status = 'cleaned';
      const result = execute('echo hello', sbx);
      expect(result.blocked).toBe(true);
      expect(result.executed).toBe(false);
    });

    it('returns blocked result for dangerous command', () => {
      const sbx = createSandbox();
      const result = execute('rm -rf /usr', sbx);
      expect(result.blocked).toBe(true);
      expect(result.blockedBy).toBeTruthy();
    });

    it('logs blocked commands in executionLog', () => {
      const sbx = createSandbox();
      execute('rm -rf /tmp', sbx);
      expect(sbx.executionLog.length).toBe(1);
      expect(sbx.executionLog[0].blocked).toBe(true);
    });

    it('returns unexecuted record for safe command', () => {
      const sbx = createSandbox();
      const result = execute('echo hello', sbx);
      expect(result.blocked).toBe(false);
      expect(result.executed).toBe(false);
      expect(result.command).toBe('echo hello');
    });

    it('logs safe commands in executionLog', () => {
      const sbx = createSandbox();
      execute('echo hello', sbx);
      expect(sbx.executionLog.length).toBe(1);
      expect(sbx.executionLog[0].blocked).toBe(false);
    });

    it('result includes sandboxId', () => {
      const sbx = createSandbox();
      const result = execute('ls', sbx);
      expect(result.sandboxId).toBe(sbx.id);
    });

    it('result includes startedAt ISO string', () => {
      const sbx = createSandbox();
      const result = execute('ls', sbx);
      expect(() => new Date(result.startedAt)).not.toThrow();
    });

    it('result includes timeoutMs', () => {
      const sbx = createSandbox({ timeoutMs: 10000 });
      const result = execute('ls', sbx);
      expect(result.timeoutMs).toBe(10000);
    });
  });

  // -------------------------------------------------------------------------
  describe('recordResult()', () => {
    it('marks execution as executed', () => {
      const sbx = createSandbox();
      const record = execute('echo hi', sbx);
      const updated = recordResult(record, { stdout: 'hi', stderr: '', exitCode: 0, duration: 50 });
      expect(updated.executed).toBe(true);
    });

    it('records stdout and stderr', () => {
      const sbx = createSandbox();
      const record = execute('test', sbx);
      const updated = recordResult(record, { stdout: 'output', stderr: 'warning', exitCode: 0, duration: 100 });
      expect(updated.stdout).toBe('output');
      expect(updated.stderr).toBe('warning');
    });

    it('records exit code', () => {
      const sbx = createSandbox();
      const record = execute('test', sbx);
      const updated = recordResult(record, { stdout: '', stderr: '', exitCode: 1, duration: 0 });
      expect(updated.exitCode).toBe(1);
    });

    it('defaults exitCode to 1 when not provided', () => {
      const sbx = createSandbox();
      const record = execute('test', sbx);
      const updated = recordResult(record, {});
      expect(updated.exitCode).toBe(1);
    });

    it('records duration', () => {
      const sbx = createSandbox();
      const record = execute('test', sbx);
      const updated = recordResult(record, { stdout: '', stderr: '', exitCode: 0, duration: 250 });
      expect(updated.duration).toBe(250);
    });
  });

  // -------------------------------------------------------------------------
  describe('validate()', () => {
    it('returns critical severity for blocked results', () => {
      const sbx = createSandbox();
      const result = execute('rm -rf /etc', sbx);
      const v = validate(result);
      expect(v.safe).toBe(false);
      expect(v.success).toBe(false);
      expect(v.severity).toBe('critical');
    });

    it('returns none severity for unexecuted safe result', () => {
      const sbx = createSandbox();
      const result = execute('echo hello', sbx);
      const v = validate(result);
      expect(v.safe).toBe(true);
      expect(v.success).toBe(false);
      expect(v.issues).toContain('Command has not been executed yet');
    });

    it('returns success for zero exit code with no errors', () => {
      const sbx = createSandbox();
      const record = execute('echo hi', sbx);
      const updated = recordResult(record, { stdout: 'hi', stderr: '', exitCode: 0, duration: 10 });
      const v = validate(updated);
      expect(v.success).toBe(true);
      expect(v.issues).toHaveLength(0);
    });

    it('flags non-zero exit code', () => {
      const sbx = createSandbox();
      const record = execute('fail', sbx);
      const updated = recordResult(record, { stdout: '', stderr: '', exitCode: 1, duration: 5 });
      const v = validate(updated);
      expect(v.success).toBe(false);
      expect(v.issues.some((i) => i.includes('exit code'))).toBe(true);
    });

    it('flags stderr containing "error"', () => {
      const sbx = createSandbox();
      const record = execute('test', sbx);
      const updated = recordResult(record, { stdout: '', stderr: 'error: something failed', exitCode: 0, duration: 5 });
      const v = validate(updated);
      expect(v.issues.some((i) => i.includes('error'))).toBe(true);
    });

    it('flags permission denied in stderr', () => {
      const sbx = createSandbox();
      const record = execute('cat /etc/shadow', sbx);
      const updated = recordResult(record, { stdout: '', stderr: 'permission denied', exitCode: 1, duration: 5 });
      const v = validate(updated);
      expect(v.issues.some((i) => i.includes('Permission denied'))).toBe(true);
    });

    it('flags timeout when duration >= timeoutMs', () => {
      const sbx = createSandbox({ timeoutMs: 100 });
      const record = execute('slow', sbx);
      const updated = recordResult(record, { stdout: '', stderr: '', exitCode: 0, duration: 100 });
      const v = validate(updated);
      expect(v.issues.some((i) => i.includes('timed out'))).toBe(true);
    });

    it('critical severity for fatal stderr', () => {
      const sbx = createSandbox();
      const record = execute('test', sbx);
      const updated = recordResult(record, { stdout: '', stderr: 'fatal: unrecoverable error', exitCode: 1, duration: 5 });
      const v = validate(updated);
      expect(v.severity).toBe('critical');
    });
  });

  // -------------------------------------------------------------------------
  describe('getStats()', () => {
    it('returns zeros for null sandbox', () => {
      const stats = getStats(null);
      expect(stats.totalExecutions).toBe(0);
      expect(stats.blocked).toBe(0);
      expect(stats.status).toBe('unknown');
    });

    it('counts blocked executions', () => {
      const sbx = createSandbox();
      execute('rm -rf /', sbx);
      execute('DROP DATABASE main', sbx);
      const stats = getStats(sbx);
      expect(stats.blocked).toBe(2);
    });

    it('counts pending executions', () => {
      const sbx = createSandbox();
      execute('echo hello', sbx);
      execute('cat file.txt', sbx);
      const stats = getStats(sbx);
      expect(stats.pending).toBe(2);
    });

    it('counts succeeded after recordResult with exitCode 0', () => {
      const sbx = createSandbox();
      const record = execute('echo hi', sbx);
      const updated = recordResult(record, { stdout: 'hi', stderr: '', exitCode: 0, duration: 5 });
      // update the log reference
      sbx.executionLog[0] = updated;
      const stats = getStats(sbx);
      expect(stats.succeeded).toBe(1);
    });

    it('includes sandbox status', () => {
      const sbx = createSandbox();
      const stats = getStats(sbx);
      expect(stats.status).toBe('active');
    });

    it('totalExecutions equals log length', () => {
      const sbx = createSandbox();
      execute('a', sbx);
      execute('b', sbx);
      execute('rm -rf /c', sbx);
      const stats = getStats(sbx);
      expect(stats.totalExecutions).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('getStats() - additional branch coverage', () => {
    it('counts failed executions with non-zero exitCode and adds duration', () => {
      const sbx = createSandbox();
      const record = execute('failing-command', sbx);
      // Simulate a failed execution with duration
      const updated = recordResult(record, { stdout: '', stderr: 'error', exitCode: 1, duration: 200 });
      // Replace the executionLog entry with the updated record
      sbx.executionLog[0] = updated;
      const stats = getStats(sbx);
      expect(stats.failed).toBe(1);
      expect(stats.totalDuration).toBe(200);
    });

    it('accumulates duration from multiple succeeded executions', () => {
      const sbx = createSandbox();
      const r1 = execute('cmd1', sbx);
      const r2 = execute('cmd2', sbx);
      const u1 = recordResult(r1, { stdout: 'ok', stderr: '', exitCode: 0, duration: 100 });
      const u2 = recordResult(r2, { stdout: 'ok', stderr: '', exitCode: 0, duration: 150 });
      sbx.executionLog[0] = u1;
      sbx.executionLog[1] = u2;
      const stats = getStats(sbx);
      expect(stats.succeeded).toBe(2);
      expect(stats.totalDuration).toBe(250);
    });

    it('duration defaults to 0 when entry.duration is undefined', () => {
      const sbx = createSandbox();
      const record = execute('cmd', sbx);
      // Manually set an executed record with no duration field
      sbx.executionLog[0] = { ...record, executed: true, exitCode: 0 };
      const stats = getStats(sbx);
      expect(stats.succeeded).toBe(1);
      expect(stats.totalDuration).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('execute() - expiration branch', () => {
    it('marks sandbox as expired when expiresAt is in the past', () => {
      const sbx = createSandbox({ maxLifetimeMs: 1 });
      // Manually set expiresAt to past
      sbx.expiresAt = new Date(Date.now() - 1000).toISOString();
      const result = execute('echo hello', sbx);
      expect(result.blocked).toBe(true);
      expect(sbx.status).toBe('expired');
    });

    it('logs expired command in executionLog', () => {
      const sbx = createSandbox();
      sbx.expiresAt = new Date(Date.now() - 1000).toISOString();
      execute('echo hello', sbx);
      expect(sbx.executionLog.length).toBe(1);
      expect(sbx.executionLog[0].blocked).toBe(true);
    });

    it('returns blocked result for null sandbox', () => {
      const result = execute('echo hello', null);
      expect(result.blocked).toBe(true);
      expect(result.sandboxId).toBe('unknown');
    });
  });

  // -------------------------------------------------------------------------
  describe('validate() - additional severity branches', () => {
    it('high severity when both error and timeout issues', () => {
      const sbx = createSandbox({ timeoutMs: 100 });
      const record = execute('slow', sbx);
      const updated = recordResult(record, { stdout: '', stderr: 'error: timeout', exitCode: 1, duration: 100 });
      const v = validate(updated);
      // has both error (in stderr) and timeout -> high severity
      expect(['high', 'critical']).toContain(v.severity);
    });

    it('low severity for timeout-only without error/fatal', () => {
      const sbx = createSandbox({ timeoutMs: 100 });
      const record = execute('slow-cmd', sbx);
      // exitCode 0 but timed out - only timeout issue, no exit code issue, no stderr errors
      const updated = recordResult(record, { stdout: 'partial', stderr: '', exitCode: 0, duration: 100 });
      const v = validate(updated);
      expect(v.issues.some((i) => i.includes('timed out'))).toBe(true);
      // timeout-only without error or fatal -> low severity
      expect(v.severity).toBe('low');
    });

    it('medium severity for non-zero exit code without fatal or timeout', () => {
      const sbx = createSandbox();
      const record = execute('failing', sbx);
      const updated = recordResult(record, { stdout: '', stderr: 'something went wrong', exitCode: 2, duration: 10 });
      const v = validate(updated);
      expect(['medium', 'high']).toContain(v.severity);
    });

    it('flags segmentation fault in stderr', () => {
      const sbx = createSandbox();
      const record = execute('crash', sbx);
      const updated = recordResult(record, { stdout: '', stderr: 'segmentation fault', exitCode: 139, duration: 5 });
      const v = validate(updated);
      expect(v.issues.some((i) => i.includes('Segmentation fault'))).toBe(true);
      expect(v.severity).toBe('critical');
    });

    it('flags "fatal" keyword in stderr', () => {
      const sbx = createSandbox();
      const record = execute('fatal-cmd', sbx);
      const updated = recordResult(record, { stdout: '', stderr: 'fatal: could not write to repository', exitCode: 1, duration: 5 });
      const v = validate(updated);
      expect(v.issues.some((i) => i.includes('fatal'))).toBe(true);
      expect(v.severity).toBe('critical');
    });
  });

  // -------------------------------------------------------------------------
  describe('recordResult() - truncateOutput branch', () => {
    it('truncates large stdout output exceeding maxOutputBytes', () => {
      const sbx = createSandbox();
      const record = execute('large-output', sbx);
      // Create output just over 1MB (1048576 bytes)
      const largeOutput = 'A'.repeat(1_100_000);
      const updated = recordResult(record, { stdout: largeOutput, stderr: '', exitCode: 0, duration: 5 });
      expect(updated.stdout.includes('[truncated]')).toBe(true);
      expect(updated.stdout.length).toBeLessThan(largeOutput.length);
    });

    it('does not truncate stdout within maxOutputBytes', () => {
      const sbx = createSandbox();
      const record = execute('small-output', sbx);
      const smallOutput = 'Hello World';
      const updated = recordResult(record, { stdout: smallOutput, stderr: '', exitCode: 0, duration: 5 });
      expect(updated.stdout).toBe(smallOutput);
    });

    it('handles non-string stdout gracefully', () => {
      const sbx = createSandbox();
      const record = execute('test', sbx);
      // Pass null/undefined stdout
      const updated = recordResult(record, { stdout: null, stderr: '', exitCode: 0, duration: 5 });
      expect(typeof updated.stdout).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  describe('cleanup()', () => {
    it('marks sandbox as cleaned', () => {
      const sbx = createSandbox();
      cleanup(sbx);
      expect(sbx.status).toBe('cleaned');
    });

    it('returns sandboxId', () => {
      const sbx = createSandbox();
      const result = cleanup(sbx);
      expect(result.sandboxId).toBe(sbx.id);
    });

    it('returns status cleaned', () => {
      const sbx = createSandbox();
      const result = cleanup(sbx);
      expect(result.status).toBe('cleaned');
    });

    it('returns cleanedAt ISO string', () => {
      const sbx = createSandbox();
      const result = cleanup(sbx);
      expect(() => new Date(result.cleanedAt)).not.toThrow();
    });

    it('handles null sandbox gracefully', () => {
      const result = cleanup(null);
      expect(result.sandboxId).toBe('unknown');
      expect(result.status).toBe('cleaned');
    });

    it('freezes executionLog after cleanup', () => {
      const sbx = createSandbox();
      execute('echo hi', sbx);
      cleanup(sbx);
      expect(Object.isFrozen(sbx.executionLog)).toBe(true);
    });

    it('prevents execution after cleanup', () => {
      const sbx = createSandbox();
      cleanup(sbx);
      const result = execute('echo hello', sbx);
      expect(result.blocked).toBe(true);
    });
  });
});
