/**
 * `scripts/checkpoint/read-order-guard.mjs` as its own process (CA-08, consumer
 * side): the limb's three done-conditions, against a REAL store seeded by the
 * real writer and REAL artifacts rendered by the real serializers.
 *
 *   1. KEY FALSE -> NOTHING HAPPENS. With `runtime.resume.staleGuard` anything
 *      but the literal `true` — an explicit `false`, a string, a number, an
 *      absent key, an absent or unparseable config file — the CLI prints ZERO
 *      bytes, on stdout and on stderr, and exits 0, for a CURRENT project and a
 *      STALE one alike, and for a MALFORMED COMMAND LINE too: the switch is read
 *      before the arguments are parsed, because a usage error's exit 2 is what
 *      `commands/resume.md` turns into `측정 불가` for steps 4 and 6, and OFF must
 *      never do that. An empty stdout is the only output that cannot differ from
 *      the pre-change document; that is the "byte-identical" pin. The sibling
 *      `resume-report.mjs` is pinned unchanged by the key as well. The SHIPPED
 *      config has been ON since 2026-09-30 (owner decision), so every OFF case
 *      injects its OFF through a temp plugin root instead of leaning on the
 *      shipped file; a separate block reads the real shipped file as a canary.
 *   2. KEY TRUE -> STALE / INVALID / NOT_ACCEPTABLE / BROKEN print ONE reason
 *      line and the body is absent from stdout. The body markers are unique
 *      sentinels that exist only inside a rendered body, and every scenario has
 *      a CURRENT twin that DOES print its sentinel (the negative control).
 *   3. CURRENT prints as before: header, then the body for the model to
 *      summarise to five lines.
 *
 * ── WHAT THIS FILE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - WHETHER THE MODEL RUNS THE CLI AT ALL. `/resume` is prose; a model that
 *     `Read`s plan.md directly never reaches this program. The doc test pins
 *     the sentence that forbids it, and a sentence is not an enforcement point.
 *     Live behaviour is UNMEASURED.
 *   - LIVE REACH. Production ships the key `true` but has no `.artibot/missions/`
 *     yet; every ON case runs against a temp project this file built.
 *   - THE git-common-dir STORE. The temp project is not a git repository, so
 *     the store resolves to the `project-root-fallback` location. The shared
 *     location is the same code path (`createStateStore`) but is not exercised
 *     here.
 *   - FIXTURE SIZE. Fixtures are tens of lines; the excerpt cap is exercised
 *     with a synthetic 1,000-line plan in the pure-logic file.
 *   - STEPS 3 AND 5, AND THE HANDOFF FALLBACK. Only steps 4 and 6 are guarded.
 *
 * @module tests/checkpoint/read-order-guard-cli
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStateStore } from '../../lib/project-state/state-manager.js';
import {
  BODY_FRAGMENTS, census, cleanupTempDirs, makePluginRoot, makeProject, MISSION,
  ON, OUTCOME_MARK, outcomeText, PLAN_MARK, planText, REL, reviewText,
} from './read-order-guard-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '../..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'checkpoint', 'read-order-guard.mjs');

/**
 * Run a script as its own process, no shell. Host session variables are blanked
 * explicitly: the child inherits `process.env`, and a live session id must not
 * be able to leak into a fixture run.
 *
 * @param {string} script - Script path.
 * @param {string[]} args - Arguments.
 * @param {{pluginRoot?: string}} [opts] - Omit `pluginRoot` for the SHIPPED config.
 * @returns {{status: number, stdout: string, stderr: string}} Outcome.
 */
function spawnScript(script, args, { pluginRoot } = {}) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' };
  if (pluginRoot === undefined) delete env.CLAUDE_PLUGIN_ROOT;
  else env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  const res = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf-8', timeout: 60_000, windowsHide: true, cwd: PLUGIN_ROOT, env,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const run = (args, opts) => spawnScript(CLI, args, opts);
const lineOf = (stdout, startsWith) => stdout.split('\n').find((l) => l.startsWith(startsWith));

/** @type {string} */ let onRoot;
/** @type {string} */ let offRoot;
/** @type {Record<string, string>} */ const projects = {};

beforeAll(() => {
  onRoot = makePluginRoot(ON);
  // The OFF cases inject this instead of reading the shipped file, which ships ON.
  offRoot = makePluginRoot({ runtime: { resume: { staleGuard: false } } });
  const all = { 'plan.md': planText(), 'review.md': reviewText(), 'outcome.md': outcomeText() };
  // Everything at the live revisions the artifacts declare.
  projects.current = makeProject({ live: { intent: 3, plan: 5 }, files: all });
  // The intent moved 3 -> 4 under all three artifacts.
  projects.intentMoved = makeProject({ live: { intent: 4, plan: 5 }, files: all });
  // The plan moved 5 -> 6; the intent is stable.
  projects.planMoved = makeProject({ live: { intent: 3, plan: 6 }, files: all });
  // An unreadable plan, a review that never recorded its plan edge, a good outcome.
  projects.broken = makeProject({
    live: { intent: 3, plan: 5 },
    files: { 'plan.md': 'this is not a plan artifact\n', 'review.md': reviewText({ plan: null }), 'outcome.md': outcomeText() },
  });
  // Fresh edges, but the review did not pass and the outcome was not accepted.
  projects.rejected = makeProject({
    live: { intent: 3, plan: 5 },
    files: {
      'plan.md': planText(),
      'review.md': reviewText({ verdict: 'REPAIR_REQUIRED' }),
      'outcome.md': outcomeText({ accepted: false }),
    },
  });
  // Artifacts on disk, but the store has never heard of the mission.
  projects.noRow = makeProject({ live: null, files: all });
  projects.empty = makeProject({ live: { intent: 3, plan: 5 } });
  projects.reviewOnly = makeProject({ live: { intent: 3, plan: 5 }, files: { 'review.md': reviewText() } });
});

afterAll(cleanupTempDirs);

// The OFF cases below never read the SHIPPED config: it ships ON since 2026-09-30,
// so each one injects its OFF through a temp plugin root (`offRoot` for the plain
// `false`). The real shipped file is read only by the 'SHIPPED config' block, which is
// the canary: moving `runtime.resume.staleGuard` in `artibot.config.json` turns it red
// on purpose, and that move has to edit this pin and the doc test's shipped-value pin in
// the same commit (the precedent is CA-05 `saveOnSave` and CA-15).
describe('KEY FALSE — the CLI prints nothing, whatever the project holds', () => {
  const offCases = [
    ['an explicit false', makePluginRoot({ runtime: { resume: { staleGuard: false } } })],
    ['the string "true"', makePluginRoot({ runtime: { resume: { staleGuard: 'true' } } })],
    ['the number 1', makePluginRoot({ runtime: { resume: { staleGuard: 1 } } })],
    ['an absent key', makePluginRoot({ runtime: { resume: {} } })],
    ['an empty config', makePluginRoot({})],
    ['no config file at all', makePluginRoot(undefined)],
    ['an unparseable config file', makePluginRoot(undefined, { raw: '{ not json' })],
  ];

  it.each(offCases)('%s -> empty stdout, empty stderr, exit 0 (STALE project)', (_label, pluginRoot) => {
    const res = run(['--mission', MISSION, '--cwd', projects.intentMoved], { pluginRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it('an explicit OFF is silent on a CURRENT project too (nothing to leak, nothing to add)', () => {
    const res = run(['--mission', MISSION, '--cwd', projects.current], { pluginRoot: offRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it('OFF touches nothing under the project (whole-tree census, before == after)', () => {
    const before = census(projects.intentMoved);
    // A non-trivial tree, or "unchanged" is a statement about an empty directory.
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(4);
    const res = run(['--mission', MISSION, '--cwd', projects.intentMoved], { pluginRoot: offRoot });
    expect(res.status).toBe(0);
    expect(census(projects.intentMoved)).toEqual(before);
  });

  // The switch is read BEFORE the arguments are parsed. If it were the other way
  // round, OFF + a typo'd flag would exit 2, the command document would read the
  // non-zero exit as 측정 불가 for steps 4 and 6, and OFF would not be a no-op.
  it.each([
    ['no arguments', []],
    ['a typo\'d flag', ['--mision', MISSION]],
    ['an unknown flag beside a good one', ['--mission', MISSION, '--nope']],
    ['--mission with no value', ['--mission']],
    ['--mission followed by another flag', ['--mission', '--cwd', '/x']],
    ['a bare positional', [MISSION]],
    ['--cwd with no value', ['--mission', MISSION, '--cwd']],
  ])('OFF is a pure no-op even for a malformed command line (%s): exit 0, 0 bytes on both streams', (_label, args) => {
    const res = run(args, { pluginRoot: offRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it('...and the same holds for an explicit false, a string "true" and a broken config file', () => {
    for (const [label, root] of [
      ['explicit false', makePluginRoot({ runtime: { resume: { staleGuard: false } } })],
      ['string "true"', makePluginRoot({ runtime: { resume: { staleGuard: 'true' } } })],
      ['unparseable config', makePluginRoot(undefined, { raw: '{ not json' })],
    ]) {
      const res = run(['--mision', MISSION], { pluginRoot: root });
      expect({ label, status: res.status, stdout: res.stdout, stderr: res.stderr })
        .toEqual({ label, status: 0, stdout: '', stderr: '' });
    }
  });

  it('negative control: the SAME typo\'d command line is a usage error once the key is ON', () => {
    // Without this the two tests above would pass for a CLI that never reports
    // a usage error at all.
    const res = run(['--mision', MISSION], { pluginRoot: onRoot });
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('unknown argument: --mision');
  });
});

// The canary. No plugin root is injected, so the CLI reads the artibot.config.json this
// checkout ships: ON since 2026-09-30 (owner decision). Everything above injects its OFF.
describe('SHIPPED config — runtime.resume.staleGuard ships ON', () => {
  it('a STALE project prints its reason lines and no body', () => {
    const res = run(['--mission', MISSION, '--cwd', projects.intentMoved]);
    expect(res.status, res.stderr).toBe(0);
    const out = res.stdout;
    expect(lineOf(out, 'STALE: plan')).toBe('STALE: plan rev 5 — intent_revision(선언 3, 현재 4) · 본문 미출력');
    expect(out).not.toContain(PLAN_MARK);
    expect(out).not.toContain(OUTCOME_MARK);
  });

  it('a CURRENT project prints exactly what an injected ON prints', () => {
    const shipped = run(['--mission', MISSION, '--cwd', projects.current]);
    const injected = run(['--mission', MISSION, '--cwd', projects.current], { pluginRoot: onRoot });
    expect(shipped.status, shipped.stderr).toBe(0);
    expect(shipped.stdout).toBe(injected.stdout);
    expect(shipped.stdout).toContain(PLAN_MARK);
  });

  it('a malformed command line is a usage error (exit 2), which the doc reads as 측정 불가', () => {
    const res = run(['--mision', MISSION]);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('unknown argument: --mision');
  });
});

describe('KEY TRUE — a CURRENT project prints as the doc has always described', () => {
  it('prints header, provenance line and body for all three artifacts', () => {
    const res = run(['--mission', MISSION, '--cwd', projects.current], { pluginRoot: onRoot });
    expect(res.status, res.stderr).toBe(0);
    const out = res.stdout;
    expect(out).toContain(`[4/6] ${REL('plan.md')}`);
    expect(out).toContain(`[6/6] ${REL('review.md')}`);
    expect(out).toContain(`[6/6] ${REL('outcome.md')}`);
    expect(lineOf(out, 'CURRENT: plan')).toBe('CURRENT: plan rev 5 — intent_revision 3 = 현재 3');
    expect(lineOf(out, 'CURRENT: review')).toBe(
      'CURRENT: review rev 1 — intent_revision 3 = 현재 3, plan_revision 5 = 현재 5 · verdict PASS',
    );
    expect(lineOf(out, 'CURRENT: outcome')).toBe(
      'CURRENT: outcome — intent_revision 3 = 현재 3, plan_revision 5 = 현재 5, review_revision 1 = 현재 1 · accepted true',
    );
    expect(out).toContain(PLAN_MARK);
    expect(out).toContain(OUTCOME_MARK);
    for (const word of ['STALE:', 'INVALID:', 'NOT_ACCEPTABLE:', 'BROKEN:', '측정 불가:', '부재:']) {
      expect(out, word).not.toContain(word);
    }
  });

  it('a CURRENT review that did not pass and a CURRENT outcome that was not accepted are not presented as if they had', () => {
    const out = run(['--mission', MISSION, '--cwd', projects.rejected], { pluginRoot: onRoot }).stdout;
    expect(lineOf(out, 'CURRENT: review')).toMatch(/ · verdict REPAIR_REQUIRED$/);
    expect(lineOf(out, 'CURRENT: outcome')).toMatch(/ · accepted false$/);
    // Both are CURRENT (their edges are fresh) and their bodies ARE printed, so
    // the CURRENT line is the only place the frontmatter's answer appears: the
    // lowercase word occurs exactly once in the whole output.
    expect(out).toContain(OUTCOME_MARK);
    expect(out.match(/\baccepted\b/g)?.length).toBe(1);
  });

  it('steps come out in order: 4 before 6, review before outcome', () => {
    const out = run(['--mission', MISSION, '--cwd', projects.current], { pluginRoot: onRoot }).stdout;
    const at = (s) => out.indexOf(s);
    expect(at('[4/6]')).toBeGreaterThanOrEqual(0);
    expect(at('[4/6]')).toBeLessThan(at(`[6/6] ${REL('review.md')}`));
    expect(at(`[6/6] ${REL('review.md')}`)).toBeLessThan(at(`[6/6] ${REL('outcome.md')}`));
  });
});

describe('KEY TRUE — STALE / INVALID / NOT_ACCEPTABLE / BROKEN print the reason, not the body', () => {
  it('the intent moved: plan STALE, review INVALID, outcome NOT_ACCEPTABLE, no body anywhere', () => {
    const res = run(['--mission', MISSION, '--cwd', projects.intentMoved], { pluginRoot: onRoot });
    expect(res.status, res.stderr).toBe(0);
    const out = res.stdout;
    expect(lineOf(out, 'STALE: plan')).toBe('STALE: plan rev 5 — intent_revision(선언 3, 현재 4) · 본문 미출력');
    expect(lineOf(out, 'INVALID: review')).toBe('INVALID: review rev 1 — intent_revision(선언 3, 현재 4) · 본문 미출력');
    expect(lineOf(out, 'NOT_ACCEPTABLE: outcome')).toBe(
      'NOT_ACCEPTABLE: outcome — intent_revision(선언 3, 현재 4) · 본문 미출력',
    );
    expect(out).not.toContain(PLAN_MARK);
    expect(out).not.toContain(OUTCOME_MARK);
    for (const fragment of BODY_FRAGMENTS) expect(out, fragment).not.toContain(fragment);
    expect(out).not.toContain('CURRENT:');
    expect(out).not.toContain('--- 본문');
  });

  it('negative control: the same fixtures at their own revisions DO print the bodies', () => {
    // Without this the absence above would hold for a CLI that never prints a body.
    const out = run(['--mission', MISSION, '--cwd', projects.current], { pluginRoot: onRoot }).stdout;
    expect(out).toContain(PLAN_MARK);
    expect(out).toContain(OUTCOME_MARK);
    for (const fragment of BODY_FRAGMENTS) expect(out, fragment).toContain(fragment);
  });

  it('the plan moved: the plan (which depends only on the intent) is still presented; review and outcome are not', () => {
    const out = run(['--mission', MISSION, '--cwd', projects.planMoved], { pluginRoot: onRoot }).stdout;
    expect(lineOf(out, 'CURRENT: plan')).toBeDefined();
    expect(lineOf(out, 'INVALID: review')).toContain('plan_revision(선언 5, 현재 6)');
    expect(lineOf(out, 'NOT_ACCEPTABLE: outcome')).toContain('plan_revision(선언 5, 현재 6)');
    expect(out).toContain(PLAN_MARK);
    expect(out).not.toContain(OUTCOME_MARK);
  });

  it('BROKEN: an unreadable plan and a review with no plan edge; the outcome beside them is judged on its own', () => {
    const out = run(['--mission', MISSION, '--cwd', projects.broken], { pluginRoot: onRoot }).stdout;
    expect(lineOf(out, 'BROKEN: plan')).toBe('BROKEN: plan — frontmatter 판독 불가(FRONTMATTER_MISSING) · 본문 미출력');
    expect(lineOf(out, 'BROKEN: review')).toContain('plan_revision(선언 없음, 현재 5)');
    expect(out).not.toContain('this is not a plan artifact');
    expect(out).not.toContain('## Verdict');
    // Its own three edges sit at the live revisions and its review is the one on disk.
    expect(lineOf(out, 'CURRENT: outcome')).toBeDefined();
  });

  it('BROKEN: artifacts on disk but no store row — nothing can be asserted fresh, so nothing is shown', () => {
    const out = run(['--mission', MISSION, '--cwd', projects.noRow], { pluginRoot: onRoot }).stdout;
    for (const kind of ['plan', 'review', 'outcome']) {
      const line = lineOf(out, `BROKEN: ${kind}`);
      expect(line, kind).toBeDefined();
      expect(line, kind).toContain('현재 미확인');
      expect(line, kind).toContain('mission-row-absent');
    }
    expect(out).not.toContain(PLAN_MARK);
    expect(out).not.toContain(OUTCOME_MARK);
  });
});

describe('KEY TRUE — absence, ids and encodings', () => {
  it('an empty mission prints the two 부재 lines the doc specifies', () => {
    const res = run(['--mission', MISSION, '--cwd', projects.empty], { pluginRoot: onRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toBe(`부재: ${REL('plan.md')}\n\n부재: review/outcome\n`);
  });

  it('a mission with only a review prints only that review', () => {
    const out = run(['--mission', MISSION, '--cwd', projects.reviewOnly], { pluginRoot: onRoot }).stdout;
    expect(out).toContain(`[6/6] ${REL('review.md')}`);
    expect(out).toContain(`부재: ${REL('plan.md')}`);
    expect(out).not.toContain('부재: review/outcome');
    expect(out).not.toContain('outcome');
  });

  it('a path-traversal id is refused before any path is built (a planted plan.md is never read)', () => {
    const root = makeProject({ live: { intent: 3, plan: 5 } });
    // `.artibot/missions/../plan.md` is `.artibot/plan.md`: a naive join finds this.
    writeFileSync(path.join(root, '.artibot', 'plan.md'), planText(), 'utf-8');
    const res = run(['--mission', '..', '--cwd', root], { pluginRoot: onRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toContain(PLAN_MARK);
    expect(res.stdout.match(/^측정 불가:/gm)?.length).toBe(2);
    expect(res.stdout).toContain('4단계');
    expect(res.stdout).toContain('6단계');
  });

  it.each(['m-20260929-001', 'M-2026-001', 'M-20260929-001/../x', ' M-20260929-001', 'M-20260929-01'])(
    'refuses the malformed id %j',
    (id) => {
      const res = run(['--mission', id, '--cwd', projects.current], { pluginRoot: onRoot });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).not.toContain(PLAN_MARK);
      expect(res.stdout.match(/^측정 불가:/gm)?.length).toBe(2);
    },
  );

  it('a CRLF checkout (autocrlf) prints the body without carriage returns', () => {
    const root = makeProject({
      live: { intent: 3, plan: 5 },
      files: { 'plan.md': planText().replace(/\n/g, '\r\n') },
    });
    const out = run(['--mission', MISSION, '--cwd', root], { pluginRoot: onRoot }).stdout;
    expect(out).toContain('CURRENT: plan rev 5');
    expect(out).toContain(PLAN_MARK);
    expect(out).not.toContain('\r');
  });

  it('a plan.md that is a DIRECTORY is reported, not thrown', () => {
    const root = makeProject({ live: { intent: 3, plan: 5 } });
    mkdirSync(path.join(root, '.artibot', 'missions', MISSION, 'plan.md'), { recursive: true });
    const res = run(['--mission', MISSION, '--cwd', root], { pluginRoot: onRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('측정 불가: plan — 읽을 수 없음(');
  });

  it('an artifact over the size limit is reported, not read (a 1.2 MB plan.md)', () => {
    const root = makeProject({
      live: { intent: 3, plan: 5 },
      files: { 'plan.md': planText({ marker: 'A'.repeat(1_200_000) }) },
    });
    const res = run(['--mission', MISSION, '--cwd', root], { pluginRoot: onRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('측정 불가: plan — 읽을 수 없음(too-large) · 본문 미출력');
    expect(res.stdout).not.toContain('AAAAAAAAAA');
    expect(res.stdout.length).toBeLessThan(1000);
  });

  it('a corrupt store reads as an absent row: fail closed, no crash, and it is not "repaired" by looking', () => {
    const root = makeProject({ live: { intent: 3, plan: 5 }, files: { 'plan.md': planText() } });
    const storeDir = path.join(root, '.artibot', 'runtime');
    const storeFiles = readdirSync(storeDir);
    // Non-trivial: a seeded store has files to corrupt, or this proves nothing.
    expect(storeFiles.length).toBeGreaterThan(0);
    for (const name of storeFiles) writeFileSync(path.join(storeDir, name), '{ corrupt', 'utf-8');

    const before = census(root);
    const res = run(['--mission', MISSION, '--cwd', root], { pluginRoot: onRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(lineOf(res.stdout, 'BROKEN: plan')).toContain('mission-row-absent');
    expect(res.stdout).not.toContain(PLAN_MARK);
    expect(census(root)).toEqual(before);
  });

  it('writes nothing: the whole project tree is byte-identical across a run', () => {
    const before = census(projects.intentMoved);
    const res = run(['--mission', MISSION, '--cwd', projects.intentMoved], { pluginRoot: onRoot });
    expect(res.status, res.stderr).toBe(0);
    expect(census(projects.intentMoved)).toEqual(before);
  });

  it('looking does not create a store for a project that has none', () => {
    const before = census(projects.noRow);
    run(['--mission', MISSION, '--cwd', projects.noRow], { pluginRoot: onRoot });
    expect(census(projects.noRow)).toEqual(before);
  });
});

// Every case below runs with the key ON: OFF never parses its arguments (see the
// KEY FALSE block), so a usage error can only be reported by a guard that is on.
describe('KEY TRUE — usage errors exit 2 and print nothing on stdout', () => {
  for (const [name, args] of [
    ['no arguments at all', []],
    ['a typo\'d flag', ['--mision', MISSION]],
    ['an unknown flag', ['--mission', MISSION, '--nope']],
    ['--mission with no value', ['--mission']],
    ['a bare positional', [MISSION]],
  ]) {
    it(`exits 2 on ${name}`, () => {
      const res = run(args, { pluginRoot: onRoot });
      expect(res.status).toBe(2);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('usage: read-order-guard.mjs');
    });
  }
});

describe('the existing contract CLI is untouched by the new key', () => {
  it('resume-report.mjs prints the same document with the key OFF and ON (generated_at aside)', () => {
    const report = path.join(PLUGIN_ROOT, 'scripts', 'checkpoint', 'resume-report.mjs');
    const exec = (pluginRoot) => {
      const res = spawnScript(report, ['--all', '--cwd', projects.current, '--json'], { pluginRoot });
      expect(res.status, res.stderr).toBe(0);
      return JSON.parse(res.stdout);
    };
    const off = exec(makePluginRoot({ runtime: { resume: { staleGuard: false } } }));
    const on = exec(onRoot);
    off.generated_at = 'T';
    on.generated_at = 'T';
    expect(on).toEqual(off);
    // A non-trivial document, or "equal" is a statement about two empty ones.
    expect(off.contract.missions.map((m) => m.mission_id)).toEqual([MISSION]);
  });
});

/** Strip block comments and whole-line `//` comments. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Filesystem APIs that create, change or remove something. */
const FS_WRITE_APIS = [
  'writeFile', 'appendFile', 'mkdir', 'unlink', 'rename', 'rmdir', 'rm', 'copyFile', 'cp',
  'createWriteStream', 'truncate', 'symlink', 'link', 'chmod', 'chown', 'utimes', 'mkdtemp', 'open',
];
const writeApiHits = (code) => FS_WRITE_APIS.filter((api) => new RegExp(`\\b${api}(Sync)?\\s*\\(`).test(code));

describe('source pins — this CLI reports; it cannot write', () => {
  const source = readFileSync(CLI, 'utf-8');
  const code = stripComments(source);

  it('never mentions the runtime ledger writer, comments included', () => {
    const needle = ['append', 'Ledger', 'Event'].join('');
    expect(source.split(needle).length - 1).toBe(0);
  });

  // The write-port pin is an ALLOWLIST. The write set is every function the REAL store exposes minus the names
  // below, so a method the store grows later is a write port until someone decides it reads and lists it here.
  // The deny-list this replaced named five methods and could not see `writeProjection` (it writes
  // .artibot/state.yaml) or `appendEvent`.
  /** Store methods that cannot change the store. */
  const READ_ONLY_PORTS = ['getState', 'getProjection', 'getMission', 'getTaskGraph', 'getLease', 'renderProjection'];
  /** Names this CLI spells on purpose, in a form pinned below: `appendEvent` as the option that hands the store a REFUSING ledger port. */
  const SPELLED_UNDER_A_PIN = ['appendEvent'];
  const storeMethods = (store) => Object.keys(store).filter((name) => typeof store[name] === 'function');
  const writePortsOf = (store, allowed) => storeMethods(store).filter((name) => !allowed.includes(name));

  it('binds no write port of the StateStore — the write set is derived from the real store, minus the allowlist', () => {
    const store = createStateStore({ projectRoot: PLUGIN_ROOT, sessionId: 'write-port-pin', appendEvent: () => ({ ok: false }) });
    const allowed = [...READ_ONLY_PORTS, ...SPELLED_UNDER_A_PIN];
    // An entry that is no longer a store method is a rename this pin would otherwise stop noticing.
    for (const name of allowed) expect(storeMethods(store), `${name} is not a StateStore method`).toContain(name);
    const writePorts = writePortsOf(store, allowed);
    // The known writes must come out as writes, or the loop below can pass over nothing.
    expect(writePorts).toEqual(expect.arrayContaining(['updateMission', 'updateTask', 'claimTask', 'releaseTask', 'heartbeatWorker', 'writeProjection']));
    for (const port of writePorts) expect(source, `${port} must not appear in a report-only CLI`).not.toContain(port);
  });

  it('the write-port derivation fails closed: a store method it has never seen is a write port (self-check)', () => {
    expect(writePortsOf({ getMission() {}, purgeMission() {}, paths: {} }, ['getMission'])).toEqual(['purgeMission']);
  });

  it('never reconciles or applies anything', () => {
    expect(source).not.toContain('reconcile');
    expect(source).not.toContain('apply: true');
  });

  it('calls no filesystem write API', () => {
    expect(writeApiHits(code)).toEqual([]);
  });

  it('the write-API scanner goes red on a planted write and ignores a comment (self-check)', () => {
    expect(writeApiHits('fs.writeFileSync(p, x);')).toEqual(['writeFile']);
    expect(writeApiHits('await fs.promises.mkdir(d)')).toEqual(['mkdir']);
    expect(writeApiHits(stripComments('// fs.writeFileSync(p, x);\n/* mkdir(d) */\nconst a = 1;'))).toEqual([]);
    expect(writeApiHits('const stat = fs.statSync(p); fs.readFileSync(p);')).toEqual([]);
  });

  it('opens the store with a REFUSING ledger port and no projection file', () => {
    expect(code).toMatch(/appendEvent:\s*\(\)\s*=>\s*\(\{\s*ok:\s*false/);
    expect(code).toContain('renderProjectionFile: false');
  });

  it('starts no process and makes no network call (nothing external)', () => {
    for (const token of ['child_process', 'execSync', 'spawn', 'fetch(', 'http://', 'https://', 'node:net', 'node:http']) {
      expect(code, token).not.toContain(token);
    }
  });

  it('reads the switch from the one path the reader exports, not a second spelling', () => {
    expect(code).toContain('READ_ORDER_STALE_GUARD_CONFIG_PATH');
    expect(code.split("'runtime.resume.staleGuard'").length - 1).toBe(1);
  });
});
