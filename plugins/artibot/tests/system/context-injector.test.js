import { describe, it, expect } from 'vitest';
import {
  shouldInject,
  formatContext,
  injectContext,
  classifyAction,
  ACTION_SPACE,
} from '../../lib/system/context-injector.js';

// Sample telemetry snapshot for testing
const mockTelemetry = {
  timestamp: '2024-01-01T00:00:00Z',
  platform: { os: 'linux', arch: 'x64' },
  cpu: {
    usage: 75,
    topProcesses: [
      { name: 'node', pid: 1234, cpu: 30.5 },
      { name: 'chrome', pid: 5678, cpu: 20.1 },
    ],
  },
  memory: {
    total: '8.0 GB',
    used: '5.5 GB',
    free: '2.5 GB',
    usage: 69,
    totalBytes: 8589934592,
    usedBytes: 5905580032,
    freeBytes: 2684354560,
  },
  disk: [
    { mount: '/', total: '100G', used: '60G', free: '40G', usage: 60 },
    { mount: '/data', total: '200G', used: '150G', free: '50G', usage: 75 },
  ],
  network: [
    { port: 3000, pid: 1234, state: 'LISTEN' },
    { port: 8080, pid: 5678, state: 'LISTEN' },
  ],
  errors: [
    { timestamp: '2024-01-01T00:00:00Z', level: 'error', message: 'Kernel panic: out of memory' },
  ],
  docker: [
    { name: 'postgres', status: 'Up 2 hours', ports: '5432/tcp' },
    { name: 'redis', status: 'Up 1 hour', ports: '6379/tcp' },
  ],
  git: {
    branch: 'main',
    status: 'clean',
    recentCommits: [{ hash: 'abc1234', message: 'Initial commit' }],
  },
};

// ---------------------------------------------------------------------------
// shouldInject()
// ---------------------------------------------------------------------------
describe('shouldInject()', () => {
  it('returns false for null input', () => {
    expect(shouldInject(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(shouldInject('')).toBe(false);
  });

  it('returns false for irrelevant prompt', () => {
    expect(shouldInject('Please write a haiku about spring flowers')).toBe(false);
  });

  it('returns true for prompt containing "cpu" keyword', () => {
    expect(shouldInject('Why is my cpu usage high?')).toBe(true);
  });

  it('returns true for prompt containing "memory" keyword', () => {
    expect(shouldInject('I have a memory leak in my app')).toBe(true);
  });

  it('returns true for prompt containing "error" keyword', () => {
    expect(shouldInject('I keep getting an error in production')).toBe(true);
  });

  it('returns true for prompt containing "docker" keyword', () => {
    expect(shouldInject('My docker container keeps crashing')).toBe(true);
  });

  it('returns true for prompt containing "disk" keyword', () => {
    expect(shouldInject('My disk is almost full')).toBe(true);
  });

  it('returns true for prompt containing "port" keyword', () => {
    expect(shouldInject('What port is my server listening on?')).toBe(true);
  });

  it('returns true for prompt containing "git" keyword', () => {
    expect(shouldInject('What branch am I on in git?')).toBe(true);
  });

  it('returns true for Korean keyword "느려"', () => {
    expect(shouldInject('시스템이 느려요')).toBe(true);
  });

  it('returns true for prompt containing "system" keyword', () => {
    expect(shouldInject('Show me my system information')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(shouldInject('CPU usage is high')).toBe(true);
    expect(shouldInject('MEMORY leak detected')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatContext()
// ---------------------------------------------------------------------------
describe('formatContext()', () => {
  it('returns empty string for null telemetry', () => {
    expect(formatContext(null, ['cpu'])).toBe('');
  });

  it('returns empty string for empty relevantKeys', () => {
    expect(formatContext(mockTelemetry, [])).toBe('');
  });

  it('returns empty string for null relevantKeys', () => {
    expect(formatContext(mockTelemetry, null)).toBe('');
  });

  it('formats CPU section correctly', () => {
    const result = formatContext(mockTelemetry, ['cpu']);
    expect(result).toContain('CPU: 75%');
    expect(result).toContain('node(30.5%)');
  });

  it('formats memory section correctly', () => {
    const result = formatContext(mockTelemetry, ['memory']);
    expect(result).toContain('Memory:');
    expect(result).toContain('69% used');
  });

  it('formats disk section with multiple mounts', () => {
    const result = formatContext(mockTelemetry, ['disk']);
    expect(result).toContain('Disk /');
    expect(result).toContain('60%');
  });

  it('formats network section with port list', () => {
    const result = formatContext(mockTelemetry, ['network']);
    expect(result).toContain('Listening ports:');
    expect(result).toContain('3000');
    expect(result).toContain('8080');
  });

  it('formats network section as no listening ports when empty', () => {
    const telemetry = { ...mockTelemetry, network: [] };
    const result = formatContext(telemetry, ['network']);
    expect(result).toContain('no listening ports');
  });

  it('formats errors section', () => {
    const result = formatContext(mockTelemetry, ['errors']);
    expect(result).toContain('System errors');
    expect(result).toContain('Kernel panic');
  });

  it('formats errors as none recent when empty', () => {
    const telemetry = { ...mockTelemetry, errors: [] };
    const result = formatContext(telemetry, ['errors']);
    expect(result).toContain('none recent');
  });

  it('formats docker section with container names', () => {
    const result = formatContext(mockTelemetry, ['docker']);
    expect(result).toContain('postgres');
    expect(result).toContain('redis');
  });

  it('formats docker as no running containers when empty', () => {
    const telemetry = { ...mockTelemetry, docker: [] };
    const result = formatContext(telemetry, ['docker']);
    expect(result).toContain('no running containers');
  });

  it('formats git section with branch and status', () => {
    const result = formatContext(mockTelemetry, ['git']);
    expect(result).toContain('Git: main | clean');
  });

  it('includes platform info in the output', () => {
    const result = formatContext(mockTelemetry, ['cpu']);
    expect(result).toContain('linux/x64');
  });

  it('wraps result in [System Context: ...] brackets', () => {
    const result = formatContext(mockTelemetry, ['cpu']);
    expect(result).toMatch(/^\[System Context:/);
    expect(result).toMatch(/\]$/);
  });

  it('respects token budget and truncates long content', () => {
    const manyKeys = ['cpu', 'memory', 'disk', 'network', 'errors', 'docker', 'git'];
    const result = formatContext(mockTelemetry, manyKeys);
    // MAX_CONTEXT_CHARS = 500 * 4 = 2000
    expect(result.length).toBeLessThanOrEqual(2100); // allow some slack
  });
});

// ---------------------------------------------------------------------------
// injectContext()
// ---------------------------------------------------------------------------
describe('injectContext()', () => {
  it('returns original prompt for irrelevant input', () => {
    const prompt = 'Write a poem about flowers';
    const result = injectContext(prompt, mockTelemetry);
    expect(result).toBe(prompt);
  });

  it('returns original prompt when telemetry is null', () => {
    const prompt = 'My cpu is slow';
    expect(injectContext(prompt, null)).toBe(prompt);
  });

  it('returns empty string for null prompt', () => {
    expect(injectContext(null, mockTelemetry)).toBe('');
  });

  it('injects context for CPU-related prompt', () => {
    const prompt = 'Why is my CPU usage so high?';
    const result = injectContext(prompt, mockTelemetry);
    expect(result).toContain(prompt);
    expect(result).toContain('[System Context:');
    expect(result).toContain('CPU:');
  });

  it('injects context for memory-related prompt', () => {
    const prompt = 'I have a memory leak';
    const result = injectContext(prompt, mockTelemetry);
    expect(result).toContain('[System Context:');
    expect(result).toContain('Memory:');
  });

  it('injects context after a double newline', () => {
    const prompt = 'My disk is full';
    const result = injectContext(prompt, mockTelemetry);
    expect(result).toContain('\n\n');
    const parts = result.split('\n\n');
    expect(parts[0]).toBe(prompt);
  });

  it('injects git context for git-related prompt', () => {
    const prompt = 'What git branch am I on?';
    const result = injectContext(prompt, mockTelemetry);
    expect(result).toContain('Git:');
  });

  it('injects docker context for deploy-related prompt', () => {
    const prompt = 'My docker container crashed';
    const result = injectContext(prompt, mockTelemetry);
    expect(result).toContain('Docker:');
  });
});

// ---------------------------------------------------------------------------
// classifyAction()
// ---------------------------------------------------------------------------
describe('classifyAction()', () => {
  it('returns blocked for null input', () => {
    const result = classifyAction(null);
    expect(result.classification).toBe('blocked');
  });

  it('returns blocked for empty string', () => {
    const result = classifyAction('');
    expect(result.classification).toBe('blocked');
  });

  it('classifies system shutdown as blocked', () => {
    const result = classifyAction('system shutdown now');
    expect(result.classification).toBe('blocked');
    expect(result.reason).toContain('blocked');
  });

  it('classifies format disk as blocked', () => {
    const result = classifyAction('format disk /dev/sda');
    expect(result.classification).toBe('blocked');
  });

  it('classifies rm -rf as blocked', () => {
    const result = classifyAction('run rm -rf /var/data');
    expect(result.classification).toBe('blocked');
  });

  it('classifies drop database as blocked', () => {
    const result = classifyAction('drop database production');
    expect(result.classification).toBe('blocked');
  });

  it('classifies kill process as confirm', () => {
    const result = classifyAction('kill process 1234');
    expect(result.classification).toBe('confirm');
    expect(result.reason).toContain('confirmation');
  });

  it('classifies restart service as confirm', () => {
    const result = classifyAction('restart service nginx');
    expect(result.classification).toBe('confirm');
  });

  it('classifies delete file as confirm', () => {
    const result = classifyAction('delete file /tmp/test.log');
    expect(result.classification).toBe('confirm');
  });

  it('classifies stop container as confirm', () => {
    const result = classifyAction('stop container my-app');
    expect(result.classification).toBe('confirm');
  });

  it('classifies process list as auto', () => {
    const result = classifyAction('process list');
    expect(result.classification).toBe('auto');
    expect(result.reason).toContain('safe');
  });

  it('classifies disk usage as auto', () => {
    const result = classifyAction('disk usage');
    expect(result.classification).toBe('auto');
  });

  it('classifies memory usage as auto', () => {
    const result = classifyAction('memory usage check');
    expect(result.classification).toBe('auto');
  });

  it('classifies git status as auto', () => {
    const result = classifyAction('git status');
    expect(result.classification).toBe('auto');
  });

  it('classifies docker status as auto', () => {
    const result = classifyAction('docker status check');
    expect(result.classification).toBe('auto');
  });

  it('defaults unknown actions to confirm', () => {
    const result = classifyAction('do something completely unknown');
    expect(result.classification).toBe('confirm');
    expect(result.reason).toContain('Unknown');
  });

  it('blocked takes priority over auto (when combined)', () => {
    const result = classifyAction('process list format disk');
    expect(result.classification).toBe('blocked');
  });
});

// ---------------------------------------------------------------------------
// ACTION_SPACE export
// ---------------------------------------------------------------------------
describe('ACTION_SPACE', () => {
  it('has auto, confirm, and blocked arrays', () => {
    expect(Array.isArray(ACTION_SPACE.auto)).toBe(true);
    expect(Array.isArray(ACTION_SPACE.confirm)).toBe(true);
    expect(Array.isArray(ACTION_SPACE.blocked)).toBe(true);
  });

  it('auto contains safe read-only operations', () => {
    expect(ACTION_SPACE.auto).toContain('process list');
    expect(ACTION_SPACE.auto).toContain('memory usage');
    expect(ACTION_SPACE.auto).toContain('git status');
  });

  it('blocked contains dangerous operations', () => {
    expect(ACTION_SPACE.blocked).toContain('system shutdown');
    expect(ACTION_SPACE.blocked).toContain('rm -rf');
    expect(ACTION_SPACE.blocked).toContain('format disk');
  });

  it('confirm contains reversible-but-risky operations', () => {
    expect(ACTION_SPACE.confirm).toContain('kill process');
    expect(ACTION_SPACE.confirm).toContain('delete file');
  });
});
