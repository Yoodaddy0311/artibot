import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REPO_INPUT_ERRORS, RepoInputError } from '../../lib/core/repo-input.js';
import {
  acquireRepo,
  formatSourceStamp,
  measureTreeBytes,
  REPO_ACQUIRE_ERRORS,
  RepoAcquireError,
  resolveCachedRepo,
  resolveCacheRoot,
  syncRepoTree,
} from '../../lib/git/repo-acquire.js';

/**
 * lib/git/repo-acquire.js — the single owner of the /repo clone step.
 *
 * No network. A real local git repository stands in for the remote, reached
 * through the `runGit` transport seam: `acquireRepo` still receives a real
 * https URL and still runs the full validation path, and only the argv handed
 * to git has the URL swapped for the fixture path. Validation is therefore
 * exercised, not bypassed — which is why the negative-control test below can
 * still prove that a rejected input creates nothing on disk.
 */

const SOURCE_URL = 'https://fixtures.test/artibot/demo';

let workspace;
/** Local git repo standing in for the remote. */
let fixture;
/** Same path with forward slashes — what actually gets handed to git. */
let fixtureRef;

/**
 * Run git for real, with the fixture path substituted in both directions.
 * Output substitution matters for `git remote get-url origin`: without it the
 * cache-conflict guard would see the transport path and reject its own clone.
 *
 * @returns {(args: string[], cwd?: string) => string}
 */
function makeRunGit() {
  return (args, cwd) => {
    const mapped = args.map((a) => (a === SOURCE_URL ? fixtureRef : a));
    const out = execFileSync('git', mapped, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out.split(fixtureRef).join(SOURCE_URL);
  };
}

/**
 * Commit a file into the fixture repo and return the new HEAD sha.
 *
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function commitToFixture(name, body) {
  writeFileSync(path.join(fixture, name), body, 'utf-8');
  const git = (args) =>
    execFileSync('git', args, { cwd: fixture, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['add', name]);
  git([
    '-c', 'user.name=artibot-test',
    '-c', 'user.email=artibot@test.invalid',
    'commit', '-m', `add ${name}`,
  ]);
  return git(['rev-parse', 'HEAD']);
}

let runGit;
let cacheRoot;
let seedSha;

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'artibot-repo-acquire-'));
  fixture = path.join(workspace, 'demo');
  mkdirSync(fixture, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] });
  fixtureRef = fixture.split(path.sep).join('/');
  seedSha = commitToFixture('README.md', '# demo fixture\n');
  runGit = makeRunGit();
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  cacheRoot = mkdtempSync(path.join(workspace, 'cache-'));
});

describe('acquireRepo — clone, reuse, and the sourceSha round trip', () => {
  it('clones into <cacheRoot>/<repo-name> and stamps the source commit', () => {
    const repo = acquireRepo(SOURCE_URL, { cacheRoot, runGit });

    expect(repo.cacheStatus).toBe('created');
    expect(repo.localPath).toBe(path.join(cacheRoot, 'demo'));
    expect(existsSync(path.join(repo.localPath, 'README.md'))).toBe(true);
    // The stamp is the whole point of the helper: the report must be able to
    // name the commit its file:line citations were read at.
    expect(repo.sourceSha).toBe(seedSha);
    expect(repo.sourceSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.sourceUrl).toBe(SOURCE_URL);
    expect(repo.depth).toBe(1);
    expect(repo.sizeBytes).toBeGreaterThan(0);
    expect(repo.cacheKey).toBe('demo');
    expect(repo.host).toBe('fixtures.test');
    expect(repo.owner).toBe('artibot');
    expect(Object.isFrozen(repo)).toBe(true);
  });

  it('reuses an existing cache with cacheStatus=fresh when HEAD has not moved', () => {
    acquireRepo(SOURCE_URL, { cacheRoot, runGit });
    const second = acquireRepo(SOURCE_URL, { cacheRoot, runGit });

    expect(second.cacheStatus).toBe('fresh');
    expect(second.sourceSha).toBe(seedSha);
  });

  it('reports cacheStatus=updated and a new sourceSha after the source advances', () => {
    const first = acquireRepo(SOURCE_URL, { cacheRoot, runGit });
    const advancedSha = commitToFixture('CHANGELOG.md', 'v2\n');
    const second = acquireRepo(SOURCE_URL, { cacheRoot, runGit });

    expect(first.sourceSha).not.toBe(advancedSha);
    expect(second.cacheStatus).toBe('updated');
    expect(second.sourceSha).toBe(advancedSha);
    expect(existsSync(path.join(second.localPath, 'CHANGELOG.md'))).toBe(true);
  });

  it('honours --skip-clone: the cache is reused and NOT pulled', () => {
    const first = acquireRepo(SOURCE_URL, { cacheRoot, runGit });
    const advancedSha = commitToFixture('SKIP.md', 'skip\n');
    const skipped = acquireRepo(SOURCE_URL, { cacheRoot, runGit, skipClone: true });

    // Negative control on the flag: if skipClone silently pulled anyway, the
    // sha would have moved to advancedSha and this would be indistinguishable
    // from the plain-reuse case above.
    expect(skipped.cacheStatus).toBe('fresh');
    expect(skipped.sourceSha).toBe(first.sourceSha);
    expect(skipped.sourceSha).not.toBe(advancedSha);
    expect(existsSync(path.join(skipped.localPath, 'SKIP.md'))).toBe(false);
  });

  it('fails CACHE_MISS when --skip-clone is used with no cache', () => {
    let thrown = null;
    try {
      acquireRepo(SOURCE_URL, { cacheRoot, runGit, skipClone: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAcquireError);
    expect(thrown.code).toBe(REPO_ACQUIRE_ERRORS.CACHE_MISS);
    expect(existsSync(path.join(cacheRoot, 'demo'))).toBe(false);
  });

  it('reports depth=null for a --deep (full history) clone', () => {
    const repo = acquireRepo(SOURCE_URL, { cacheRoot, runGit, deep: true });
    expect(repo.depth).toBeNull();
    expect(repo.sourceSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('acquireRepo — guards', () => {
  it('aborts on a cache-name collision instead of pulling a foreign tree', () => {
    // Same repo NAME, different origin — the cache key is the repo name alone
    // (SKILL.md § Cache Strategy), so this is reachable in production.
    const impostor = path.join(workspace, 'impostor');
    mkdirSync(impostor, { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: impostor, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(impostor, 'x.md'), 'x\n', 'utf-8');
    execFileSync('git', ['add', 'x.md'], { cwd: impostor, stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-m', 'x'],
      { cwd: impostor, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    mkdirSync(cacheRoot, { recursive: true });
    execFileSync(
      'git',
      ['clone', '--quiet', '--', impostor.split(path.sep).join('/'), path.join(cacheRoot, 'demo')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let thrown = null;
    try {
      acquireRepo(SOURCE_URL, { cacheRoot, runGit });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAcquireError);
    expect(thrown.code).toBe(REPO_ACQUIRE_ERRORS.CACHE_CONFLICT);
    // The impostor tree is left untouched — no silent overwrite.
    expect(existsSync(path.join(cacheRoot, 'demo', 'x.md'))).toBe(true);
  });

  /**
   * Build an orphan git tree at the cache key: real `.git`, real commits, but
   * **no origin remote**. This is what an interrupted clone or a hand-made
   * folder leaves behind, and it is the shape that defeated the first version
   * of the guard.
   *
   * @returns {string} The orphan's HEAD sha.
   */
  function plantOrphanCacheEntry() {
    const orphan = path.join(cacheRoot, 'demo');
    mkdirSync(orphan, { recursive: true });
    const git = (args) =>
      execFileSync('git', args, { cwd: orphan, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--quiet']);
    writeFileSync(path.join(orphan, 'NOT-THE-REQUESTED-REPO.md'), 'wrong tree\n', 'utf-8');
    git(['add', 'NOT-THE-REQUESTED-REPO.md']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-m', 'orphan']);
    expect(git(['remote'])).toBe(''); // fixture precondition: no origin
    return git(['rev-parse', 'HEAD']);
  }

  it('refuses a cache entry with no origin remote under --skip-clone', () => {
    // Regression, reproduced end-to-end by review: the guard used to return
    // early on a missing origin ("nothing to contradict"), so this exact
    // combination returned cacheStatus='fresh' and stamped the requested
    // sourceUrl + the orphan's HEAD onto a tree that is not the requested
    // repo. Unprovable provenance is now a hard failure.
    const orphanSha = plantOrphanCacheEntry();

    let thrown = null;
    try {
      acquireRepo(SOURCE_URL, { cacheRoot, runGit, skipClone: true });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAcquireError);
    expect(thrown.code).toBe(REPO_ACQUIRE_ERRORS.CACHE_CONFLICT);
    expect(thrown.message).toContain('no origin remote');
    // The wrong tree is left in place, unmodified — the caller is told to
    // remove it rather than having it silently overwritten or adopted.
    expect(existsSync(path.join(cacheRoot, 'demo', 'NOT-THE-REQUESTED-REPO.md'))).toBe(true);
    expect(existsSync(path.join(cacheRoot, 'demo', 'README.md'))).toBe(false);
    expect(orphanSha).toMatch(/^[0-9a-f]{40}$/); // it did have a sha to stamp
  });

  it('refuses a cache entry with no origin remote on the normal (pulling) path too', () => {
    plantOrphanCacheEntry();

    let thrown = null;
    try {
      acquireRepo(SOURCE_URL, { cacheRoot, runGit });
    } catch (err) {
      thrown = err;
    }
    // Not UPDATE_FAILED: the refusal must come from the provenance check
    // before any pull is attempted, so the reason reported is the real one.
    expect(thrown).toBeInstanceOf(RepoAcquireError);
    expect(thrown.code).toBe(REPO_ACQUIRE_ERRORS.CACHE_CONFLICT);
  });

  it('aborts on an oversized tree with the real measured size', () => {
    // The fixture reaches the failure region: maxBytes is set below the tree's
    // actual byte count, so the guard fires on a measurement, not a stub.
    const measured = measureTreeBytes(fixture);
    expect(measured).toBeGreaterThan(1);

    let thrown = null;
    try {
      acquireRepo(SOURCE_URL, { cacheRoot, runGit, maxBytes: 1 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoInputError);
    expect(thrown.code).toBe(REPO_INPUT_ERRORS.SIZE_EXCEEDED);
  });

  it('surfaces UPDATE_FAILED rather than leaving a half-synced cache', () => {
    acquireRepo(SOURCE_URL, { cacheRoot, runGit });
    const brokenRunGit = (args, cwd) => {
      if (args[0] === 'pull') throw new Error('fatal: refusing to merge unrelated histories');
      return runGit(args, cwd);
    };
    let thrown = null;
    try {
      acquireRepo(SOURCE_URL, { cacheRoot, runGit: brokenRunGit });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAcquireError);
    expect(thrown.code).toBe(REPO_ACQUIRE_ERRORS.UPDATE_FAILED);
  });

  it('surfaces CLONE_FAILED when git cannot clone', () => {
    const brokenRunGit = (args, cwd) => {
      if (args[0] === 'clone') throw new Error('fatal: repository not found');
      return runGit(args, cwd);
    };
    let thrown = null;
    try {
      acquireRepo(SOURCE_URL, { cacheRoot, runGit: brokenRunGit });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoAcquireError);
    expect(thrown.code).toBe(REPO_ACQUIRE_ERRORS.CLONE_FAILED);
  });
});

describe('acquireRepo — rejected inputs create nothing (negative control)', () => {
  /** @type {Array<[string, string, string]>} */
  const cases = [
    ['file:// URL', 'file:///tmp/evil', REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS],
    ['scp/SSH form', 'git@github.com:evil/repo.git', REPO_INPUT_ERRORS.NOT_ABSOLUTE_URL],
    ['relative path', '../../etc', REPO_INPUT_ERRORS.NOT_ABSOLUTE_URL],
    ['plain http', 'http://fixtures.test/artibot/demo', REPO_INPUT_ERRORS.SCHEME_NOT_HTTPS],
    ['IPv4 host', 'https://127.0.0.1/artibot/demo', REPO_INPUT_ERRORS.HOST_INVALID],
    ['shell metachar', 'https://fixtures.test/a/b;id', REPO_INPUT_ERRORS.PATH_CHAR_NOT_ALLOWED],
  ];

  it.each(cases)('rejects %s before touching the filesystem', (_label, input, code) => {
    const before = readdirSync(cacheRoot);
    let thrown = null;
    try {
      acquireRepo(input, { cacheRoot, runGit });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RepoInputError);
    expect(thrown.code).toBe(code);
    // Validation runs before mkdir/clone: the cache root is byte-identical.
    expect(readdirSync(cacheRoot)).toEqual(before);
  });

  it('rejects the same inputs in resolveCachedRepo, without leaking cache existence', () => {
    for (const [, input] of cases) {
      expect(() => resolveCachedRepo(input, { cacheRoot, runGit })).toThrow(RepoInputError);
    }
  });
});

describe('resolveCachedRepo — read-only', () => {
  it('reports a missing cache without creating it', () => {
    const status = resolveCachedRepo(SOURCE_URL, { cacheRoot, runGit });
    expect(status.exists).toBe(false);
    expect(status.sourceSha).toBeNull();
    expect(status.originUrl).toBeNull();
    expect(status.stale).toBe(true); // unknown timestamp = refresh-worthy
    expect(status.localPath).toBe(path.join(cacheRoot, 'demo'));
    expect(existsSync(status.localPath)).toBe(false);
  });

  it('reports an existing cache with its sha and origin', () => {
    const repo = acquireRepo(SOURCE_URL, { cacheRoot, runGit });
    const status = resolveCachedRepo(SOURCE_URL, { cacheRoot, runGit });

    expect(status.exists).toBe(true);
    expect(status.sourceSha).toBe(repo.sourceSha);
    expect(status.originUrl).toBe(SOURCE_URL);
    expect(status.stale).toBe(false);
    expect(status.fetchedAt).toBeGreaterThan(0);
  });

  it('marks a cache older than the 7-day threshold as stale', () => {
    acquireRepo(SOURCE_URL, { cacheRoot, runGit });
    const eightDaysOn = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(resolveCachedRepo(SOURCE_URL, { cacheRoot, runGit, now: eightDaysOn }).stale).toBe(true);
  });
});

describe('measureTreeBytes', () => {
  it('sums file bytes under a tree', () => {
    const dir = mkdtempSync(path.join(workspace, 'measure-'));
    writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(100), 'utf-8');
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'nested', 'b.txt'), 'y'.repeat(50), 'utf-8');
    expect(measureTreeBytes(dir)).toBe(150);
  });

  it('stops early once the cap is passed and still reports over-cap', () => {
    const dir = mkdtempSync(path.join(workspace, 'measure-cap-'));
    writeFileSync(path.join(dir, 'a.txt'), 'x'.repeat(100), 'utf-8');
    expect(measureTreeBytes(dir, 10)).toBeGreaterThan(10);
  });

  it('returns 0 for a path that cannot be read rather than throwing', () => {
    expect(measureTreeBytes(path.join(workspace, 'does-not-exist'))).toBe(0);
  });
});

describe('syncRepoTree — low-level transport', () => {
  it('clones without validating (documented as internal)', () => {
    const target = path.join(cacheRoot, 'raw');
    syncRepoTree({ sourceUrl: SOURCE_URL, localPath: target, depth: 1, update: false, runGit });
    expect(existsSync(path.join(target, 'README.md'))).toBe(true);
  });
});

describe('resolveCacheRoot', () => {
  it('defaults under the artibot home dir', () => {
    const root = resolveCacheRoot();
    expect(root.endsWith(path.join('.claude', 'artibot', 'repos'))).toBe(true);
  });

  it('honours an explicit override', () => {
    expect(resolveCacheRoot({ cacheRoot: '/tmp/x' })).toBe('/tmp/x');
  });
});

describe('formatSourceStamp', () => {
  it('renders url@shortsha with depth and cache status', () => {
    expect(
      formatSourceStamp({
        sourceUrl: 'https://github.com/google/magika',
        sourceSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        depth: 1,
        cacheStatus: 'created',
      }),
    ).toBe('https://github.com/google/magika@a1b2c3d (depth 1, created)');
  });

  it('says "full clone" when depth is null', () => {
    expect(
      formatSourceStamp({
        sourceUrl: 'https://github.com/a/b',
        sourceSha: '0123456789abcdef0123456789abcdef01234567',
        depth: null,
        cacheStatus: 'updated',
      }),
    ).toBe('https://github.com/a/b@0123456 (full clone, updated)');
  });
});
