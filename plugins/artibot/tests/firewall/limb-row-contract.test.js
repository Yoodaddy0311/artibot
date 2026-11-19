/**
 * Limb-row contract — the seam between the two limb providers.
 *
 * A `/split` `plan.json` row and a bound `/orca` `run.json` row must satisfy ONE
 * contract, because the landing side (`scripts/split/land.mjs`, the completion
 * reader `lib/git/limb-completion.js`) reads the same fields from either:
 * `limb`, `branch`, `worktreePath`, `affectedPaths`, `forkPoint`. The contract
 * has two twins that this file keeps in agreement:
 *   - `schemas/limb-row.schema.json` (draft-07, run here by ajv),
 *   - `lib/git/orca-plan.js#validateLimbRow` (hand-written: the plugin ships no
 *     JSON-Schema validator at runtime).
 *
 * Where the rows come from (rules section 9: a hand-written row makes this a
 * vacuous pass):
 *  - `/split` side: the REAL producer. `appendLimbs` is the pure core of
 *    `scripts/split/plan-append.mjs`, the one sanctioned writer of limb rows, and
 *    one row is captured from the real CLI (`--dry-run --json`, spawned as a
 *    process). The post-dispatch row gets its `forkPoint` the way `dispatch.mjs`
 *    records it (`updatePlanJson` on the parent's plan.json). `dispatch.mjs`
 *    itself needs a real worktree and session and is NOT run here.
 *  - `/orca` side: the REAL `compileRun` + `bindLimb`, with the worktree values
 *    transcribed from the P0 receipt `wt-a-show.json` (Orca 1.4.259).
 *  - The consumers are real too: `land.mjs#loadPlanLimb` and
 *    `effectiveBase`, `forkPointForLimb`, and `readLimbCompletion` against a
 *    temporary git repository.
 *
 * WHAT THIS FILE CANNOT SEE (written next to the gate, per repo rule):
 *  - Whether `land.mjs` PASSES a limb: only that it can LOAD the row and find its
 *    base. The seven landing checks are `limb-landing-check.js`'s.
 *  - Rows that come from `/split plan`'s inline write (the leader writes plan.json
 *    by hand at step 7) rather than `plan-append.mjs`: the shape is documented in
 *    `commands/split.md` and matches, but no producer script emits it.
 *  - Which ajv enforces the schema. It is a declared devDependency (^6.15.0), and the
 *    ajv block is REQUIRED, never skipped: a run that measured no schema behaviour
 *    must not report the same green as one that measured all of it.
 *  - The battery below is hand-written. It pins agreement on those rows, not on every
 *    possible row; a new keyword in the schema needs a new row here.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLimbCompletion } from '../../lib/git/limb-completion.js';
import {
  bindLimb, compileRun, DISPATCH_KINDS, LIMB_SLUG, validateLimbRow,
} from '../../lib/git/orca-plan.js';
import { orcaRunPath, readOrcaRun, writeOrcaRun } from '../../lib/git/orca-run-file.js';
import { forkPointForLimb, planJsonPath, readPlanJson, updatePlanJson } from '../../lib/git/split-run-file.js';
import { appendLimbs } from '../../scripts/split/plan-append.mjs';
import { effectiveBase, loadPlanLimb } from '../../scripts/split/land.mjs';

// Imported defensively at module scope only so that a missing ajv produces the explicit AJV_MISSING
// failure below instead of an unresolved-import crash whose message says nothing about what to do.
// Absence is still a FAILURE.
let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}
const AJV_MISSING = 'ajv is the ONLY oracle that reads limb-row.schema.json here. It is a devDependency of plugins/artibot; '
  + 'if it is gone, restore it — never skip this block.';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(testDir, '..', '..');
const SCHEMA_PATH = path.join(PLUGIN_ROOT, 'schemas', 'limb-row.schema.json');
const PLAN_APPEND = path.join(PLUGIN_ROOT, 'scripts', 'split', 'plan-append.mjs');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));

const compile = () => {
  expect(Ajv, AJV_MISSING).not.toBeNull();
  return new Ajv({ allErrors: true }).compile(schema);
};

const tmpDirs = [];
const mkTmp = (prefix = 'limb-row-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

/** Values transcribed from the P0 receipt `wt-a-show.json`; the user path is `<HOME>` there too. */
const P0_WORKTREE = {
  worktreeId: 'd56eb7c9-5a43-4fcf-8c27-05cfbf914642::<HOME>/orca/workspaces/Artibot/orca-p0-a',
  worktreePath: '<HOME>/orca/workspaces/Artibot/orca-p0-a',
  branch: 'orca/p0-a-fcb0gj',
};

describe('limb-row.schema.json — the document', () => {
  it('is draft-07, requires exactly limb, branch, worktreePath and affectedPaths, and stays open to other keys', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.type).toBe('object');
    expect([...schema.required].sort()).toEqual(['affectedPaths', 'branch', 'limb', 'worktreePath']);
    expect(schema.additionalProperties).toBe(true); // /split rows carry wave, rolling, worktreeName, ...
    expect(Object.keys(schema.properties).sort()).toEqual([
      'affectedPaths', 'branch', 'deps', 'dispatches', 'forkPoint', 'limb', 'taskIds', 'worktreeId', 'worktreePath',
    ]);
  });

  it('shares its patterns and vocabulary with the code, so the two twins cannot drift apart silently', () => {
    expect(schema.properties.limb.pattern).toBe(LIMB_SLUG.source);
    expect(schema.properties.deps.items.pattern).toBe(LIMB_SLUG.source);
    expect(schema.properties.dispatches.items.properties.kind.enum).toEqual([...DISPATCH_KINDS]);
    expect(schema.properties.dispatches.items.required.sort()).toEqual(['at', 'dispatchId', 'kind', 'taskId']);
  });

  it('describes a LANDABLE row: branch and worktreePath are strings, so an unbound /orca row is not valid', () => {
    expect(schema.properties.branch.type).toBe('string');
    expect(schema.properties.worktreePath.type).toBe('string');
    expect(schema.description).toMatch(/NOT valid here/);
  });

  it('compiles, and ajv itself is present', () => {
    expect(typeof compile()).toBe('function');
  });
});

describe('the contract against real producers and consumers', () => {
  let repo = '';
  let base = '';
  let done = '';
  // No inherited GIT_* variable: a hook that runs the tests (GIT_DIR, GIT_INDEX_FILE, ...) must not aim these commands at the real repo.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_AUTHOR_NAME: 'orca-test',
    GIT_AUTHOR_EMAIL: 'orca-test@example.invalid',
    GIT_COMMITTER_NAME: 'orca-test',
    GIT_COMMITTER_EMAIL: 'orca-test@example.invalid',
  };
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

  beforeAll(() => {
    repo = mkTmp('limb-row-git-');
    git(['init', '-q', '-b', 'main', '.']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base']);
    base = git(['rev-parse', 'HEAD']);
    const tree = git(['rev-parse', `${base}^{tree}`]);
    done = git(['commit-tree', tree, '-p', base, '-m', 'feat: the limb work', '-m', 'Split-Limb: done']);
  });

  afterAll(() => {
    for (const dir of tmpDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  });

  /** A temp parent root with a `/split` plan.json, as `plan-append.mjs` needs it. */
  const seedSplitParent = () => {
    const parent = mkTmp('limb-row-split-');
    fs.mkdirSync(path.dirname(planJsonPath(parent)), { recursive: true });
    fs.writeFileSync(planJsonPath(parent), `${JSON.stringify({ runId: 'split-demo', repoShort: 'demo', base, limbs: [] }, null, 2)}\n`);
    return parent;
  };

  /** Rows the pure core of `plan-append.mjs` builds (the sanctioned writer of limb rows). */
  const appendedRows = (parent) => {
    const specs = [
      { limb: 'alpha', taskIds: ['alpha'], affectedPaths: ['src/alpha/'], wave: 1, rolling: false },
      { limb: 'beta-api', taskIds: ['T1', 'T2'], affectedPaths: ['src/beta.js', 'tests/beta.test.js'], wave: 25, rolling: true },
    ];
    const result = appendLimbs({ limbs: [] }, null, specs, { parentRoot: parent, repoShort: 'demo' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.added;
  };

  /** One row captured from the real CLI, spawned as a process: `--dry-run --json`. */
  const cliRow = (parent) => {
    const run = spawnSync(process.execPath, [
      PLAN_APPEND, '--parent', parent, '--limb', 'gamma', '--task', 'T9', '--path', 'src/gamma.js', '--path', 'docs/', '--wave', '3', '--rolling', '--dry-run', '--json',
    ], { encoding: 'utf-8', timeout: 60_000, windowsHide: true });
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out).toMatchObject({ ok: true, dryRun: true });
    expect(out.added).toHaveLength(1);
    return out.added[0];
  };

  /** The `/orca` row after the real `compileRun` and `bindLimb`. */
  const orcaRun = (branchValue = P0_WORKTREE.branch, forkPoint = base) => {
    const compiled = compileRun({
      objective: 'o',
      tag: 'a1b2c3',
      now: new Date('2026-11-19T04:50:00.000Z'),
      tasks: [{ id: 'alpha', affectedPaths: ['src/alpha/'] }, { id: 'beta', affectedPaths: ['src/beta/'], dependsOn: ['alpha'] }],
      plan: null,
    });
    expect(compiled.ok).toBe(true);
    const bound = bindLimb(compiled.run, 'alpha', { ...P0_WORKTREE, branch: branchValue, forkPoint });
    expect(bound.ok).toBe(true);
    return { unbound: compiled.run, bound: bound.run };
  };

  describe('/split rows from the real producer', () => {
    it('plan-append`s row builder (appendLimbs) satisfies the schema and validateLimbRow', () => {
      const validate = compile();
      const rows = appendedRows(seedSplitParent());
      expect(rows.map((row) => row.limb)).toEqual(['alpha', 'beta-api']);
      expect(Object.keys(rows[0])).toEqual(expect.arrayContaining(['limb', 'worktreeName', 'worktreePath', 'branch', 'taskIds', 'affectedPaths', 'wave', 'rolling']));
      for (const row of rows) {
        expect(validate(row), JSON.stringify(validate.errors)).toBe(true);
        expect(validateLimbRow(row)).toEqual({ ok: true, errors: [] });
      }
    });

    it('a row captured from the real plan-append CLI (--dry-run --json, spawned) satisfies both', () => {
      const validate = compile();
      const row = cliRow(seedSplitParent());
      expect(row).toMatchObject({ limb: 'gamma', taskIds: ['T9'], affectedPaths: ['src/gamma.js', 'docs/'], wave: 3, rolling: true });
      expect(validate(row), JSON.stringify(validate.errors)).toBe(true);
      expect(validateLimbRow(row)).toEqual({ ok: true, errors: [] });
    });

    it('a row that dispatch has stamped with a forkPoint (updatePlanJson, a real commit id) still satisfies both', () => {
      const validate = compile();
      const parent = seedSplitParent();
      const [row] = appendedRows(parent);
      fs.writeFileSync(planJsonPath(parent), `${JSON.stringify({ runId: 'split-demo', repoShort: 'demo', base, limbs: [row] }, null, 2)}\n`);
      updatePlanJson(parent, (current) => ({ ...current, limbs: current.limbs.map((entry) => (entry.limb === row.limb ? { ...entry, forkPoint: base } : entry)) }));
      const stamped = readPlanJson(parent).limbs[0];
      expect(stamped.forkPoint).toBe(base);
      expect(validate(stamped), JSON.stringify(validate.errors)).toBe(true);
      expect(validateLimbRow(stamped)).toEqual({ ok: true, errors: [] });
    });
  });

  describe('/orca rows from compileRun and bindLimb', () => {
    it('a BOUND row satisfies the schema and validateLimbRow, with and without dispatches', () => {
      const validate = compile();
      const { bound } = orcaRun();
      const row = bound.limbs[0];
      expect(row).toMatchObject({ limb: 'alpha', worktreeId: P0_WORKTREE.worktreeId, worktreePath: P0_WORKTREE.worktreePath, branch: P0_WORKTREE.branch, forkPoint: base });
      expect(validate(row), JSON.stringify(validate.errors)).toBe(true);
      expect(validateLimbRow(row)).toEqual({ ok: true, errors: [] });

      const withDispatch = { ...row, dispatches: [{ dispatchId: 'ctx_e759f8cefc88', taskId: 'task_dfa5c850df6a', kind: 'initial', at: '2026-11-19T05:00:00.000Z' }] };
      expect(validate(withDispatch), JSON.stringify(validate.errors)).toBe(true);
      expect(validateLimbRow(withDispatch).ok).toBe(true);
    });

    it('an UNBOUND row is not landable: invalid for the schema and for validateLimbRow, valid only as a planning row', () => {
      const validate = compile();
      const { unbound } = orcaRun();
      for (const row of unbound.limbs) {
        expect(row.branch).toBeNull();
        expect(validate(row), row.limb).toBe(false);
        expect(validate.errors.map((error) => error.dataPath)).toEqual(expect.arrayContaining(['.branch', '.worktreePath']));
        expect(validateLimbRow(row).ok, row.limb).toBe(false);
        expect(validateLimbRow(row, { allowUnbound: true }).ok, row.limb).toBe(true);
      }
    });

    it('a bound limb beside an unbound one: only the bound row is landable', () => {
      const { bound } = orcaRun();
      expect(validateLimbRow(bound.limbs[0]).ok).toBe(true);
      expect(validateLimbRow(bound.limbs[1]).ok).toBe(false);
    });
  });

  describe('ajv and validateLimbRow agree on a battery of rows', () => {
    const wsp = (...codePoints) => String.fromCodePoint(...codePoints);
    const good = { limb: 'alpha', branch: 'worktree-split-demo-alpha', worktreePath: '/repo/.claude/worktrees/split-demo-alpha', affectedPaths: ['src/alpha/'] };
    const dispatch = { dispatchId: 'ctx_1', taskId: 'task_1', kind: 'initial', at: '2026-11-19T05:00:00.000Z' };
    const withPatch = (patch) => ({ ...good, ...patch });
    const without = (key) => Object.fromEntries(Object.entries(good).filter(([name]) => name !== key));
    const battery = [
      // [label, row, valid]
      ['the four required keys alone', good, true],
      ['a full /orca row', withPatch({ forkPoint: 'f'.repeat(40), taskIds: ['L1'], deps: ['beta', 'gamma-2'], worktreeId: 'wt::/p', dispatches: [dispatch, { ...dispatch, dispatchId: 'ctx_2', kind: 'rework' }] }), true],
      ['/split extras (wave, rolling, worktreeName, plannedBranch)', withPatch({ wave: 3, rolling: true, worktreeName: 'x', plannedBranch: 'y' }), true],
      ['empty affectedPaths', withPatch({ affectedPaths: [] }), true],
      ['null forkPoint and worktreeId', withPatch({ forkPoint: null, worktreeId: null }), true],
      ['empty taskIds, deps and dispatches', withPatch({ taskIds: [], deps: [], dispatches: [] }), true],
      ['missing limb', without('limb'), false],
      ['missing branch', without('branch'), false],
      ['missing worktreePath', without('worktreePath'), false],
      ['missing affectedPaths', without('affectedPaths'), false],
      ['undefined branch (an absent key)', withPatch({ branch: undefined }), false],
      ['limb with an uppercase letter', withPatch({ limb: 'Alpha' }), false],
      ['limb of one character', withPatch({ limb: 'a' }), false],
      ['limb of 32 characters', withPatch({ limb: 'x'.repeat(32) }), false],
      ['limb of 31 characters', withPatch({ limb: 'x'.repeat(31) }), true],
      ['limb with a slash', withPatch({ limb: 'auth/x' }), false],
      ['limb that is a number', withPatch({ limb: 5 }), false],
      ['empty branch', withPatch({ branch: '' }), false],
      ['null branch', withPatch({ branch: null }), false],
      ['numeric branch', withPatch({ branch: 7 }), false],
      ['array worktreePath', withPatch({ worktreePath: ['x'] }), false],
      ['null worktreePath', withPatch({ worktreePath: null }), false],
      ['affectedPaths as a string', withPatch({ affectedPaths: 'src/' }), false],
      ['affectedPaths with a number', withPatch({ affectedPaths: ['src/', 1] }), false],
      ['affectedPaths with an empty entry', withPatch({ affectedPaths: [''] }), false],
      ['null affectedPaths', withPatch({ affectedPaths: null }), false],
      ['empty forkPoint', withPatch({ forkPoint: '' }), false],
      ['numeric forkPoint', withPatch({ forkPoint: 5 }), false],
      ['taskIds as a string', withPatch({ taskIds: 'L1' }), false],
      ['taskIds with an empty entry', withPatch({ taskIds: [''] }), false],
      ['deps with an uppercase name', withPatch({ deps: ['Beta'] }), false],
      ['deps with a one-character name', withPatch({ deps: ['b'] }), false],
      ['deps as a string', withPatch({ deps: 'beta' }), false],
      ['empty worktreeId', withPatch({ worktreeId: '' }), false],
      ['numeric worktreeId', withPatch({ worktreeId: 9 }), false],
      ['dispatches as an object', withPatch({ dispatches: {} }), false],
      ['a null dispatch', withPatch({ dispatches: [null] }), false],
      ['a dispatch without kind', withPatch({ dispatches: [{ dispatchId: 'ctx_1', taskId: 'task_1', at: 'x' }] }), false],
      ['a dispatch with an unknown kind', withPatch({ dispatches: [{ ...dispatch, kind: 'launch' }] }), false],
      ['a dispatch with a blank id', withPatch({ dispatches: [{ ...dispatch, dispatchId: ' ' }] }), false],
      ['a blank branch of spaces', withPatch({ branch: '   ' }), false],
      ['a branch of only a no-break space', withPatch({ branch: wsp(0xa0) }), false],
      ['a branch of only a BOM', withPatch({ branch: wsp(0xfeff) }), false],
      ['a branch of only a line separator', withPatch({ branch: wsp(0x2028) }), false],
      ['a branch of only a zero-width space (not whitespace to JS or to a regex)', withPatch({ branch: wsp(0x200b) }), true],
      ['an affectedPaths entry of only a no-break space', withPatch({ affectedPaths: [wsp(0xa0)] }), false],
    ];

    it.each(battery)('%s', (_label, row, valid) => {
      const validate = compile();
      expect(validate(row), JSON.stringify(validate.errors)).toBe(valid);
      expect(validateLimbRow(row).ok, JSON.stringify(validateLimbRow(row).errors)).toBe(valid);
    });

    it('rows that are not objects fail in both', () => {
      const validate = compile();
      for (const value of [null, [], 'row', 5, true]) {
        expect(validate(value), String(value)).toBe(false);
        expect(validateLimbRow(value).ok, String(value)).toBe(false);
      }
    });

    it('allowUnbound relaxes exactly null for branch and worktreePath, which the schema (landable rows) never does', () => {
      const validate = compile();
      for (const [label, row, relaxed] of [
        ['both null', withPatch({ branch: null, worktreePath: null }), true],
        ['branch null only', withPatch({ branch: null }), true],
        ['blank branch', withPatch({ branch: '' }), false],
        ['missing branch', without('branch'), false],
        ['numeric worktreePath', withPatch({ worktreePath: 3 }), false],
      ]) {
        expect(validate(row), label).toBe(false);
        expect(validateLimbRow(row).ok, label).toBe(false);
        expect(validateLimbRow(row, { allowUnbound: true }).ok, label).toBe(relaxed);
      }
    });
  });

  describe('the landing side reads both providers` rows the same way', () => {
    it('land.mjs can load a /split plan.json row and a bound /orca run.json row (and its forkPoint), and refuses an unbound one', () => {
      const splitParent = seedSplitParent();
      const [splitRow] = appendedRows(splitParent);
      fs.writeFileSync(planJsonPath(splitParent), `${JSON.stringify({ runId: 'split-demo', base, limbs: [{ ...splitRow, forkPoint: base }] }, null, 2)}\n`);
      const loadedSplit = loadPlanLimb(planJsonPath(splitParent), splitRow.limb);
      expect(loadedSplit.ok, JSON.stringify(loadedSplit)).toBe(true);
      expect(loadedSplit.entry.branch).toBe(splitRow.branch);

      const orcaParent = mkTmp('limb-row-orca-');
      const { unbound, bound } = orcaRun();
      expect(writeOrcaRun(orcaParent, bound)).toEqual({ ok: true, path: orcaRunPath(orcaParent) });
      const read = readOrcaRun(orcaParent);
      expect(read.ok).toBe(true);
      // land.mjs is pointed at run.json with --plan; plan.base does not exist there, forkPoint is the base
      const loadedOrca = loadPlanLimb(orcaRunPath(orcaParent), 'alpha');
      expect(loadedOrca.ok, JSON.stringify(loadedOrca)).toBe(true);
      expect(loadedOrca.entry).toMatchObject({ branch: P0_WORKTREE.branch, worktreePath: P0_WORKTREE.worktreePath, affectedPaths: ['src/alpha/'], forkPoint: base });
      const orcaBase = effectiveBase({ planBase: typeof loadedOrca.plan.base === 'string' ? loadedOrca.plan.base : '', forkPoint: forkPointForLimb(loadedOrca.plan, 'alpha'), branch: loadedOrca.entry.branch, cwd: repo });
      expect(orcaBase).toMatchObject({ base, source: 'forkPoint' });

      const unboundParent = mkTmp('limb-row-unbound-');
      expect(writeOrcaRun(unboundParent, unbound).ok).toBe(true);
      const refused = loadPlanLimb(orcaRunPath(unboundParent), 'alpha');
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(/has no branch in plan/); // why the landable contract needs a bound row
    });

    it('the completion reader finds the done trailer on the branch either provider recorded, from the recorded forkPoint', () => {
      const parent = seedSplitParent();
      const [splitRow] = appendedRows(parent);
      git(['update-ref', `refs/heads/${splitRow.branch}`, done]);
      git(['update-ref', `refs/heads/${P0_WORKTREE.branch}`, done]);
      const { bound } = orcaRun();
      for (const row of [{ ...splitRow, forkPoint: base }, bound.limbs[0]]) {
        expect(validateLimbRow(row).ok, row.limb).toBe(true);
        const completion = readLimbCompletion({ cwd: repo, branch: row.branch, base: row.forkPoint });
        expect(completion, row.branch).toMatchObject({ complete: true, reason: 'done', commitCount: 1 });
        expect(completion.doneCommit.sha).toBe(done);
      }
    });
  });
});
