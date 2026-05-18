/**
 * Unit tests for lib/autopilot/auto-pr.js
 *
 * Covers:
 *   - verifyRepoOwnership: ADMIN/WRITE/MAINTAIN → canPush
 *   - verifyRepoOwnership: READ/TRIAGE/NONE → !canPush
 *   - verifyRepoOwnership: gh failure → error string, !canPush
 *   - verifyRepoOwnership: malformed JSON → !canPush, error
 *   - verifyRepoOwnership: nested owner.login object → parsed
 *   - createAutoPR: missing title/body → reject
 *   - createAutoPR: !canPush blocked BEFORE gh runs
 *   - createAutoPR: bubbles ghRunner error
 *   - createAutoPR: success returns parsed URL
 *   - createAutoPR: passes --draft when opts.draft = true
 *   - createAutoPR: passes --base and --head when present
 *   - createAutoPR: passes ownership through opts without re-invoking gh
 *   - createAutoPR: body injection still goes through string args (no shell)
 *   - createAutoPR: rejects when ghRunner returns non-URL stdout (url=null but ok=true)
 *   - createAutoPR: never invokes gh on ownership-fail path
 *   - DATA POLICY: gh args do not contain `--repo` to other org/user
 */
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  createAutoPR,
  verifyRepoOwnership,
} from '../../lib/autopilot/auto-pr.js';

function makeRunner(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fn = vi.fn((args) => {
    calls.push(args);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'string' ? next : '';
  });
  fn.calls = calls;
  return fn;
}

describe('verifyRepoOwnership', () => {
  it('parses ADMIN permission as canPush + isOwner', () => {
    const ghRunner = makeRunner(JSON.stringify({
      owner: 'me', name: 'repo', viewerPermission: 'ADMIN',
    }));
    const out = verifyRepoOwnership({ ghRunner });
    expect(out).toEqual({
      isOwner: true, canPush: true, owner: 'me', name: 'repo', permission: 'ADMIN',
    });
    expect(ghRunner.calls[0]).toEqual([
      'repo', 'view', '--json', 'owner,name,viewerPermission',
    ]);
  });

  it('accepts WRITE permission as canPush but not isOwner', () => {
    const ghRunner = makeRunner(JSON.stringify({
      owner: 'org', name: 'repo', viewerPermission: 'WRITE',
    }));
    const out = verifyRepoOwnership({ ghRunner });
    expect(out.canPush).toBe(true);
    expect(out.isOwner).toBe(false);
  });

  it('accepts MAINTAIN permission as canPush', () => {
    const ghRunner = makeRunner(JSON.stringify({
      owner: 'org', name: 'repo', viewerPermission: 'MAINTAIN',
    }));
    const out = verifyRepoOwnership({ ghRunner });
    expect(out.canPush).toBe(true);
  });

  it('rejects READ permission (canPush=false)', () => {
    const ghRunner = makeRunner(JSON.stringify({
      owner: 'other', name: 'repo', viewerPermission: 'READ',
    }));
    const out = verifyRepoOwnership({ ghRunner });
    expect(out.canPush).toBe(false);
    expect(out.isOwner).toBe(false);
    expect(out.permission).toBe('READ');
  });

  it('rejects TRIAGE permission', () => {
    const ghRunner = makeRunner(JSON.stringify({
      owner: 'other', name: 'repo', viewerPermission: 'TRIAGE',
    }));
    expect(verifyRepoOwnership({ ghRunner }).canPush).toBe(false);
  });

  it('returns error when gh throws', () => {
    const ghRunner = makeRunner(new Error('not authenticated'));
    const out = verifyRepoOwnership({ ghRunner });
    expect(out.canPush).toBe(false);
    expect(out.error).toContain('gh repo view failed');
    expect(out.error).toContain('not authenticated');
  });

  it('returns error on malformed JSON', () => {
    const ghRunner = makeRunner('{not json');
    const out = verifyRepoOwnership({ ghRunner });
    expect(out.canPush).toBe(false);
    expect(out.error).toContain('malformed JSON');
  });

  it('parses owner as nested {login} object', () => {
    const ghRunner = makeRunner(JSON.stringify({
      owner: { login: 'nested-user' }, name: 'repo', viewerPermission: 'ADMIN',
    }));
    const out = verifyRepoOwnership({ ghRunner });
    expect(out.owner).toBe('nested-user');
    expect(out.canPush).toBe(true);
  });
});

describe('createAutoPR — validation', () => {
  it('rejects when title is missing', () => {
    const ghRunner = makeRunner('');
    const out = createAutoPR({ body: 'hello', ghRunner });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('title and body');
    expect(ghRunner.calls.length).toBe(0);
  });

  it('rejects when body is empty/whitespace', () => {
    const ghRunner = makeRunner('');
    const out = createAutoPR({ title: 'T', body: '   ', ghRunner });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('title and body');
    expect(ghRunner.calls.length).toBe(0);
  });
});

describe('createAutoPR — ownership gate', () => {
  let ghRunner;
  beforeEach(() => {
    ghRunner = vi.fn();
  });

  it('blocks PR creation when canPush=false (gh never called)', () => {
    const ownership = {
      isOwner: false, canPush: false, owner: 'someone-else',
      name: 'their-repo', permission: 'READ',
    };
    const out = createAutoPR({
      title: 'X', body: 'Y', ownership, ghRunner,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('push permission');
    expect(ghRunner).not.toHaveBeenCalled();
  });

  it('uses provided ownership without re-calling gh repo view', () => {
    const ownership = {
      isOwner: true, canPush: true, owner: 'me', name: 'repo', permission: 'ADMIN',
    };
    const runner = makeRunner('https://github.com/me/repo/pull/1\n');
    const out = createAutoPR({
      title: 'T', body: 'B', ownership, ghRunner: runner,
    });
    expect(out.ok).toBe(true);
    expect(runner.calls.length).toBe(1);
    expect(runner.calls[0][0]).toBe('pr');
  });

  it('auto-verifies ownership when not provided (success path)', () => {
    const runner = makeRunner([
      JSON.stringify({ owner: 'me', name: 'repo', viewerPermission: 'ADMIN' }),
      'https://github.com/me/repo/pull/2\n',
    ]);
    const out = createAutoPR({ title: 'T', body: 'B', ghRunner: runner });
    expect(out.ok).toBe(true);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0][0]).toBe('repo');
    expect(runner.calls[1][0]).toBe('pr');
  });

  it('auto-verifies and blocks when ownership fails (only 1 gh call)', () => {
    const runner = makeRunner(
      JSON.stringify({ owner: 'other', name: 'repo', viewerPermission: 'READ' }),
    );
    const out = createAutoPR({ title: 'T', body: 'B', ghRunner: runner });
    expect(out.ok).toBe(false);
    expect(runner.calls).toHaveLength(1);
  });
});

describe('createAutoPR — gh invocation', () => {
  it('passes title and body as separate string args', () => {
    const ownership = {
      isOwner: true, canPush: true, owner: 'me', name: 'r', permission: 'ADMIN',
    };
    const runner = makeRunner('https://github.com/me/r/pull/3\n');
    createAutoPR({
      title: 'My Title $(rm -rf /)',
      body: 'Body with backticks ` and quotes "',
      ownership,
      ghRunner: runner,
    });
    const args = runner.calls[0];
    expect(args).toContain('--title');
    expect(args).toContain('--body');
    // Args are passed as-is to execFile — no shell, no expansion.
    expect(args[args.indexOf('--title') + 1]).toBe('My Title $(rm -rf /)');
    expect(args[args.indexOf('--body') + 1]).toBe(
      'Body with backticks ` and quotes "',
    );
  });

  it('adds --draft when opts.draft=true', () => {
    const ownership = {
      isOwner: true, canPush: true, owner: 'me', name: 'r', permission: 'ADMIN',
    };
    const runner = makeRunner('https://github.com/me/r/pull/4');
    createAutoPR({
      title: 'T', body: 'B', draft: true, ownership, ghRunner: runner,
    });
    expect(runner.calls[0]).toContain('--draft');
  });

  it('passes --base and --head when supplied', () => {
    const ownership = {
      isOwner: true, canPush: true, owner: 'me', name: 'r', permission: 'ADMIN',
    };
    const runner = makeRunner('https://github.com/me/r/pull/5');
    createAutoPR({
      title: 'T', body: 'B', base: 'master', head: 'feat/x',
      ownership, ghRunner: runner,
    });
    const args = runner.calls[0];
    expect(args[args.indexOf('--base') + 1]).toBe('master');
    expect(args[args.indexOf('--head') + 1]).toBe('feat/x');
  });

  it('does NOT include --repo to redirect to another repo (DATA POLICY)', () => {
    const ownership = {
      isOwner: true, canPush: true, owner: 'me', name: 'r', permission: 'ADMIN',
    };
    const runner = makeRunner('https://github.com/me/r/pull/6');
    createAutoPR({
      title: 'T', body: 'B', ownership, ghRunner: runner,
    });
    expect(runner.calls[0]).not.toContain('--repo');
  });

  it('returns url=null but ok=true when stdout has no URL', () => {
    const ownership = {
      isOwner: true, canPush: true, owner: 'me', name: 'r', permission: 'ADMIN',
    };
    const runner = makeRunner('done\n');
    const out = createAutoPR({
      title: 'T', body: 'B', ownership, ghRunner: runner,
    });
    expect(out.ok).toBe(true);
    expect(out.url).toBeNull();
  });

  it('parses URL from last non-empty line', () => {
    const ownership = {
      isOwner: true, canPush: true, owner: 'me', name: 'r', permission: 'ADMIN',
    };
    const runner = makeRunner(
      'Creating draft PR…\nhttps://github.com/me/r/pull/7\n\n',
    );
    const out = createAutoPR({
      title: 'T', body: 'B', ownership, ghRunner: runner,
    });
    expect(out.url).toBe('https://github.com/me/r/pull/7');
  });

  it('surfaces gh failure as ok=false + error string', () => {
    const ownership = {
      isOwner: true, canPush: true, owner: 'me', name: 'r', permission: 'ADMIN',
    };
    const runner = makeRunner(new Error('network down'));
    const out = createAutoPR({
      title: 'T', body: 'B', ownership, ghRunner: runner,
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('gh pr create failed');
    expect(out.error).toContain('network down');
  });
});
