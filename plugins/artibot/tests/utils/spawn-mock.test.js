import { describe, expect, it, vi } from 'vitest';
import {
  commandRouter,
  execFileRouter,
  mockChildProcess,
  spawnSyncRouter,
} from './spawn-mock.js';

describe('commandRouter', () => {
  it('returns mapped string for exact command match', () => {
    const route = commandRouter({
      'git rev-parse HEAD': 'abc1234',
      'git rev-parse --show-toplevel': '/fake/repo',
    });
    expect(route('git rev-parse HEAD')).toBe('abc1234');
    expect(route('git rev-parse --show-toplevel')).toBe('/fake/repo');
  });

  it('accepts Map as routes', () => {
    const routes = new Map([['git status', 'clean']]);
    const route = commandRouter(routes);
    expect(route('git status')).toBe('clean');
  });

  it('invokes function value with the matched command', () => {
    const route = commandRouter({
      'git diff': (cmd) => `output-for-${cmd}`,
    });
    expect(route('git diff')).toBe('output-for-git diff');
  });

  it('returns fallback when no route matches', () => {
    const route = commandRouter({ 'git status': 'clean' }, 'FALLBACK');
    expect(route('git unknown')).toBe('FALLBACK');
  });

  it('fallback defaults to empty string', () => {
    const route = commandRouter({});
    expect(route('anything')).toBe('');
  });

  it('fallback can be a function of the command', () => {
    const route = commandRouter({}, (cmd) => `miss:${cmd}`);
    expect(route('foo')).toBe('miss:foo');
  });

  it('throws Error fallback if requested', () => {
    const route = commandRouter({}, () => {
      throw new Error('not allowed');
    });
    expect(() => route('whatever')).toThrow('not allowed');
  });
});

describe('execFileRouter', () => {
  it('matches on file + args joined by space', () => {
    const route = execFileRouter({
      'git rev-parse HEAD': 'sha-abc',
    });
    expect(route('git', ['rev-parse', 'HEAD'])).toBe('sha-abc');
  });

  it('supports function values receiving (file, args)', () => {
    const route = execFileRouter({
      'node script.js': (file, args) => `${file}:${args.join(',')}`,
    });
    expect(route('node', ['script.js'])).toBe('node:script.js');
  });

  it('returns fallback empty string for unmatched', () => {
    const route = execFileRouter({});
    expect(route('git', ['log'])).toBe('');
  });
});

describe('spawnSyncRouter', () => {
  it('returns { status:0, stdout, stderr:"" } shape for matched commands', () => {
    const route = spawnSyncRouter({
      'git push origin master': { stdout: 'pushed' },
    });
    const result = route('git', ['push', 'origin', 'master']);
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toBe('pushed');
    expect(String(result.stderr)).toBe('');
  });

  it('honours explicit status / stderr in the route entry', () => {
    const route = spawnSyncRouter({
      'git push origin master': { status: 1, stderr: 'rejected' },
    });
    const result = route('git', ['push', 'origin', 'master']);
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toBe('rejected');
  });

  it('returns status 0 + empty stdout for unmatched by default', () => {
    const route = spawnSyncRouter({});
    const result = route('git', ['unknown']);
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toBe('');
  });
});

describe('mockChildProcess', () => {
  it('returns a vi.mock factory result with provided spies', () => {
    const execSync = vi.fn();
    const factory = mockChildProcess({ execSync });
    expect(factory.execSync).toBe(execSync);
  });

  it('omits keys not provided (so real impls stay unmocked at the call site)', () => {
    const factory = mockChildProcess({ execSync: vi.fn() });
    expect('execSync' in factory).toBe(true);
    expect('spawnSync' in factory).toBe(false);
    expect('execFileSync' in factory).toBe(false);
  });

  it('accepts all three forms simultaneously', () => {
    const factory = mockChildProcess({
      execSync: vi.fn(),
      execFileSync: vi.fn(),
      spawnSync: vi.fn(),
    });
    expect(typeof factory.execSync).toBe('function');
    expect(typeof factory.execFileSync).toBe('function');
    expect(typeof factory.spawnSync).toBe('function');
  });
});
