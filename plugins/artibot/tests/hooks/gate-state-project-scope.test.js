import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  blocked, canonical, cleanup, git, hookPath, makeDir, makeRepo, runDevVerifyStop, runEdit,
  runHookPatiently,
} from './_gate-state-harness.js';

/**
 * O2 — the DEV verify gate's state is per project and per session, not per
 * plugin version.
 *
 * THE DEFECT, MEASURED BEFORE THE FIX. `mark-main-agent-edit.js` wrote ONE file,
 * `<pluginRoot>/runtime/last-main-agent-edit.timestamp`, for every Edit/Write in
 * every project, and `dev-verify-gate.js#hasNewerMainAgentEdit` compared that
 * file's mtime with ONE `<pluginRoot>/runtime/last-dev-verify-sha.txt`. So:
 *   1. an edit in project A made project B's next Stop fire (B's main agent had
 *      edited nothing) — the cross-project misfire;
 *   2. two sessions in one project shared the pair, so one session's fire
 *      swallowed the other's unverified edit (a false negative);
 *   3. the pair lived in a directory that is replaced on every plugin update
 *      (`~/.claude/plugins/cache/artibot/artibot/<version>/`), so a verify ask
 *      was forgotten — measured with `ls`: four version directories, four
 *      different `runtime/` contents.
 *
 * Every case below spawns the REAL hook scripts (see `_gate-state-harness.js`
 * for why) and asserts only on what a process prints or leaves behind, never on
 * a path the implementation picked — so the cases that failed before the fix
 * are the same cases that pass after it, for the reason stated in their titles.
 *
 * WHAT THESE CANNOT SEE (rules §9): a live Claude Code session — only the payload
 * keys the hooks read are sent; two hooks racing on the same second (spawns here
 * are sequential); a plugin update's effect on `hooks.json` registration; and
 * `claude --resume`, whose session-id behaviour on this host is UNMEASURED (a
 * changed id reads as "no marker", which fails safe: the gate stays quiet).
 */

/** @type {string[]} */
const created = [];
afterEach(() => cleanup(created));

/** A fresh session id per case so no two cases can share a slot by accident. */
let counter = 0;
const sid = (label) => `gate-${label}-${process.pid}-${Date.now()}-${(counter += 1)}`;

describe('O2 — a main-agent edit only fires the gate of the project and session that made it', () => {
  it('an edit in project A does NOT fire project B (cross-project misfire)', () => {
    const plugin = makeDir(created, 'plugin');
    const projectA = makeRepo(created, 'proj-a');
    const projectB = makeRepo(created, 'proj-b');

    const sessionB = sid('b');

    // Project A's main agent edits. Project B's main agent does nothing at all,
    // but B has a dirty tree (any branch resumed from elsewhere looks like this).
    runEdit(projectA, plugin, sid('a'));
    const stopB = runDevVerifyStop(projectB, plugin, sessionB);

    expect(blocked(stopB.stdout), `B's Stop must stay quiet. stdout=${stopB.stdout} stderr=${stopB.stderr}`)
      .toBe(false);

    // CONTROL IN THE SAME PROJECT. A gate that cannot reach git reads "no repo, no
    // changes" and is just as silent — the host's own git timeout is swallowed — so
    // the silence above proves nothing by itself. B's OWN main agent now edits: B's
    // gate must fire, which it can only do if it really looked at B.
    runEdit(projectB, plugin, sessionB);
    const ownStopB = runDevVerifyStop(projectB, plugin, sessionB);
    expect(blocked(ownStopB.stdout), `B's own edit must fire B. stdout=${ownStopB.stdout} stderr=${ownStopB.stderr}`)
      .toBe(true);
  }, 240_000);

  it('CONTROL: the gate still fires in the project whose own main agent edited', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');
    const session = sid('own');

    runEdit(project, plugin, session);
    const stop = runDevVerifyStop(project, plugin, session);

    // Without this, the silence asserted above could be a harness that can
    // never fire (a repo the gate does not accept, a missing git, a bad payload).
    expect(blocked(stop.stdout), `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(true);
    expect(stop.stdout).toContain('DEV verify');
  }, 120_000);

  it('an edit in session S1 does NOT fire session S2 of the same project', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');
    const s2 = sid('s2');

    runEdit(project, plugin, sid('s1'));
    const stopS2 = runDevVerifyStop(project, plugin, s2);

    expect(blocked(stopS2.stdout), `S2 edited nothing. stdout=${stopS2.stdout} stderr=${stopS2.stderr}`)
      .toBe(false);

    // CONTROL IN THE SAME PROJECT (see the cross-project case): S2's own edit must
    // fire S2, or S2's silence was a gate that never got to look.
    runEdit(project, plugin, s2);
    const ownStopS2 = runDevVerifyStop(project, plugin, s2);
    expect(blocked(ownStopS2.stdout), `S2's own edit must fire S2. stdout=${ownStopS2.stdout} stderr=${ownStopS2.stderr}`)
      .toBe(true);
  }, 240_000);

  it('two sessions of one project keep independent "already verified" state', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');
    const s1 = sid('s1');
    const s2 = sid('s2');

    // S2 edits first, S1 edits second, S1's Stop fires and records its verified
    // state. S2's own edit is still unverified, so S2's Stop must fire too.
    // Before the fix both sessions shared one "last verified" file, written by
    // S1's fire AFTER S2's edit, so S2's marker looked already-verified and its
    // edit was never asked about.
    runEdit(project, plugin, s2);
    runEdit(project, plugin, s1);
    const stop1 = runDevVerifyStop(project, plugin, s1);
    const stop2 = runDevVerifyStop(project, plugin, s2);

    expect(blocked(stop1.stdout), `S1. stdout=${stop1.stdout} stderr=${stop1.stderr}`).toBe(true);
    expect(blocked(stop2.stdout), `S2. stdout=${stop2.stdout} stderr=${stop2.stderr}`).toBe(true);
  }, 180_000);

  it('the state survives a plugin update (each plugin version is its own directory)', () => {
    const pluginV1 = makeDir(created, 'plugin-v1');
    const pluginV2 = makeDir(created, 'plugin-v2');
    const project = makeRepo(created, 'proj');
    const session = sid('upd');

    // The edit is observed by version 1; the Stop is answered by version 2.
    runEdit(project, pluginV1, session);
    const stop = runDevVerifyStop(project, pluginV2, session);

    expect(blocked(stop.stdout), `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(true);
  }, 120_000);

  it('does not re-ask about a state it already asked about, even after a plugin update', () => {
    const pluginV1 = makeDir(created, 'plugin-v1');
    const pluginV2 = makeDir(created, 'plugin-v2');
    const project = makeRepo(created, 'proj');
    const session = sid('dup');

    runEdit(project, pluginV1, session);
    expect(blocked(runDevVerifyStop(project, pluginV1, session).stdout)).toBe(true);
    // Same working-tree state, new plugin directory: the loop guard's memory is
    // the project's, so the answer is still "already asked".
    const again = runDevVerifyStop(project, pluginV2, session);

    expect(blocked(again.stdout), `stdout=${again.stdout} stderr=${again.stderr}`).toBe(false);

    // CONTROL: a genuinely NEW state must still be asked about, under the new
    // plugin directory and in the same session. The loop guard fingerprints the SET
    // of changed files (not their content), so a second file is what makes a new
    // state. Without this, "already asked" could equally be a gate that never got
    // to look (a swallowed git timeout is silent too).
    writeFileSync(path.join(project, 'src', 'a.js'), 'export const a = 2;\n');
    runEdit(project, pluginV2, session);
    const fresh = runDevVerifyStop(project, pluginV2, session);
    expect(blocked(fresh.stdout), `a new state must be asked about. stdout=${fresh.stdout} stderr=${fresh.stderr}`)
      .toBe(true);
  }, 300_000);

  it('fires in a linked worktree — the /split window layout', () => {
    const plugin = makeDir(created, 'plugin');
    const main = makeRepo(created, 'main', { dirty: false });
    const wt = path.join(makeDir(created, 'wt-parent'), 'wt');
    git(['worktree', 'add', '-q', wt, '-b', `gate-it-wt-${process.pid}-${Date.now()}`], main);
    writeFileSync(path.join(wt, 'tracked.txt'), `dirty in worktree ${Date.now()}\n`);
    const session = sid('wt');

    runEdit(wt, plugin, session);
    const stop = runDevVerifyStop(wt, plugin, session);

    expect(blocked(stop.stdout), `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(true);
  }, 120_000);

  it('another worktree of the same repository is not fired by this worktree\'s edit', () => {
    const plugin = makeDir(created, 'plugin');
    const main = makeRepo(created, 'main', { dirty: false });
    const wt = path.join(makeDir(created, 'wt-parent'), 'wt');
    git(['worktree', 'add', '-q', wt, '-b', `gate-it-wt2-${process.pid}-${Date.now()}`], main);
    writeFileSync(path.join(wt, 'tracked.txt'), `dirty in worktree ${Date.now()}\n`);
    writeFileSync(path.join(main, 'tracked.txt'), `dirty in main ${Date.now()}\n`);

    const sessionMain = sid('main');

    // Both trees share ONE git common directory (the store's F3 location), so a
    // store keyed by project alone would let the worktree's edit fire main.
    runEdit(wt, plugin, sid('wt'));
    const stopMain = runDevVerifyStop(main, plugin, sessionMain);

    expect(blocked(stopMain.stdout), `stdout=${stopMain.stdout} stderr=${stopMain.stderr}`).toBe(false);

    // CONTROL IN THE SAME TREE: main's own main-agent edit must fire main's gate,
    // or the silence above was a gate that never got to look at main.
    runEdit(main, plugin, sessionMain);
    const ownStopMain = runDevVerifyStop(main, plugin, sessionMain);
    expect(blocked(ownStopMain.stdout), `main's own edit must fire main. stdout=${ownStopMain.stdout} stderr=${ownStopMain.stderr}`)
      .toBe(true);
  }, 240_000);

  it('fires when the edit hook ran from a subdirectory of the project', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');
    const session = sid('sub');
    const sub = path.join(project, 'plugins', 'artibot');

    // A `cd` inside the session moves the payload's cwd; the marker must still
    // land where the Stop gate (which resolves the repository root) looks.
    runEdit(project, plugin, session, { cwd: sub });
    const stop = runDevVerifyStop(project, plugin, session);

    expect(blocked(stop.stdout), `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(true);
  }, 120_000);

  it('fires when the edit hook and the gate spell the project path differently', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');
    const session = sid('spell');

    // `os.tmpdir()` is an 8.3 short name on this Windows host, so the canonical
    // spelling differs from the one the gate is started under. Where the two
    // spellings are equal (POSIX) the case is a plain repeat — it cannot fail
    // there, and that is the honest limit of this case.
    runEdit(project, plugin, session, { cwd: canonical(project) });
    const stop = runDevVerifyStop(project, plugin, session);

    expect(blocked(stop.stdout), `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(true);
  }, 120_000);
});

describe('O2 — through the real dispatchers (the production path)', () => {
  // Production never spawns these hooks directly: `hooks/hooks.json` points the
  // host at `_posttooluse-dispatcher.js` and `_stop-dispatcher.js`, which read the
  // host payload once and hand it to each child. The cases above prove the hooks;
  // this one proves the WIRING — that `cwd` and `session_id` survive the hop, so the
  // writer and the reader still meet. The spawn cwd is each case's own throwaway
  // repository (`mkdtemp`), never the checkout, and HOME is a throwaway too, so the
  // other children of these slots (tool tracker, session notes, ...) write there.

  it('an Edit through one dispatcher and a Stop through the other fire only the edited project', () => {
    const plugin = makeDir(created, 'plugin');
    const home = makeDir(created, 'home');
    const projectA = makeRepo(created, 'proj-a');
    const projectB = makeRepo(created, 'proj-b');
    const sessionA = sid('da');
    const sessionB = sid('db');
    const env = { HOME: home, USERPROFILE: home };
    // Patient, because a dispatcher kills a child at its own budget (8 s for the DEV
    // verify gate) and a busy host turns that into a silent Stop — see the harness.
    const stop = (repo, session) => runHookPatiently(hookPath('_stop-dispatcher.js'), {
      hook_event_name: 'Stop', stop_hook_active: false, session_id: session, cwd: repo,
    }, { cwd: repo, pluginRoot: plugin, env });

    const edit = runHookPatiently(hookPath('_posttooluse-dispatcher.js'), {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(projectA, 'tracked.txt') },
      tool_response: { success: true },
      session_id: sessionA,
      cwd: projectA,
    }, { cwd: projectA, pluginRoot: plugin, env });
    const stopB = stop(projectB, sessionB);
    const stopA = stop(projectA, sessionA);

    expect(edit.status, `edit dispatcher stderr=${edit.stderr}`).toBe(0);
    expect(blocked(stopB.stdout), `B. stdout=${stopB.stdout} stderr=${stopB.stderr}`).toBe(false);
    // The control that makes B's silence mean something: A's own Stop blocks.
    expect(blocked(stopA.stdout), `A. stdout=${stopA.stdout} stderr=${stopA.stderr}`).toBe(true);
    expect(stopA.stdout).toContain('DEV verify');
    expect(existsSync(path.join(plugin, 'runtime')), 'runtime/ under the plugin root').toBe(false);
  }, 240_000);
});

describe('O2 — the edit marker stays out of the plugin directory and out of unrelated projects', () => {
  it('writes nothing under the plugin root', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');

    runEdit(project, plugin, sid('ns'));

    // The plugin directory is version-scoped and, for an installed plugin, may
    // be read-only or replaced under a running session. A project's gate state
    // has no business there.
    expect(existsSync(path.join(plugin, 'runtime')), 'runtime/ under the plugin root').toBe(false);
  }, 120_000);

  it('writes nothing in a git project that is not an Artibot repo', () => {
    const plugin = makeDir(created, 'plugin');
    const stranger = makeRepo(created, 'stranger', { artibot: false });

    runEdit(stranger, plugin, sid('x'));

    expect(existsSync(path.join(plugin, 'runtime'))).toBe(false);
    // No Artibot gate can ever read a marker here, so none is left behind.
    expect(existsSync(path.join(stranger, '.git', 'artibot'))).toBe(false);
    expect(existsSync(path.join(stranger, '.artibot'))).toBe(false);
  }, 120_000);

  it('writes nothing outside any git work tree', () => {
    const plugin = makeDir(created, 'plugin');
    const plain = makeDir(created, 'plain');
    mkdirSync(path.join(plain, 'plugins', 'artibot'), { recursive: true });
    writeFileSync(path.join(plain, 'plugins', 'artibot', 'CLAUDE.md'), '# stub\n');

    runEdit(plain, plugin, sid('plain'));

    // The Stop gates need a git work tree to run at all, so a marker here is
    // unreachable state. Nothing under the plugin root, nothing in the project.
    expect(existsSync(path.join(plugin, 'runtime'))).toBe(false);
    expect(existsSync(path.join(plain, '.artibot'))).toBe(false);
  }, 120_000);

  it('a subagent edit leaves no marker anywhere (teammates must not fire the leader)', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');
    const session = sid('mate');

    runEdit(project, plugin, session, { extra: { subagent_id: 'sub-1' } });
    const stop = runDevVerifyStop(project, plugin, session);

    expect(blocked(stop.stdout), `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(false);
    expect(existsSync(path.join(plugin, 'runtime'))).toBe(false);

    // CONTROL IN THE SAME SESSION: the leader's own edit fires the gate, so the
    // silence above was a gate that looked and found no marker, not one that never
    // looked.
    runEdit(project, plugin, session);
    const ownStop = runDevVerifyStop(project, plugin, session);
    expect(blocked(ownStop.stdout), `the leader's own edit must fire. stdout=${ownStop.stdout} stderr=${ownStop.stderr}`)
      .toBe(true);
  }, 240_000);
});

describe('O2 — the writer and the reader root on the payload cwd, not on the process cwd', () => {
  // The host reports the directory a hook ran in (`cwd`) and starts the hook process
  // in some directory too. They are the same in a healthy session, but they are two
  // facts, and the marker's writer (`mark-main-agent-edit`) and its reader
  // (`dev-verify-gate`) have to read the SAME one or they look in two places. The
  // writer always used the payload; the reader used `git rev-parse` from the process
  // cwd. Both now use the payload `cwd` and fall back to the process cwd only when
  // the payload names none.

  it('a Stop whose process runs outside any repository still gates the project its payload names', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');
    const elsewhere = makeDir(created, 'elsewhere');
    const session = sid('pcwd');

    runEdit(project, plugin, session, { processCwd: elsewhere });
    const stop = runDevVerifyStop(project, plugin, session, { processCwd: elsewhere });

    expect(blocked(stop.stdout), `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(true);
  }, 120_000);

  it('the payload cwd wins over the directory the process happens to run in', () => {
    const plugin = makeDir(created, 'plugin');
    const projectA = makeRepo(created, 'proj-a');
    const projectB = makeRepo(created, 'proj-b');
    const sessionA = sid('pa');
    const sessionB = sid('pb');

    // A's payload, but both processes run inside B (another Artibot checkout with
    // its own dirty tree). Rooted on the process cwd the Stop would judge B and
    // find no marker for A's session — silent; rooted on the payload it judges A.
    runEdit(projectA, plugin, sessionA, { processCwd: projectB });
    const stopA = runDevVerifyStop(projectA, plugin, sessionA, { processCwd: projectB });
    expect(blocked(stopA.stdout), `A. stdout=${stopA.stdout} stderr=${stopA.stderr}`).toBe(true);

    // And the other way: B's payload from a process inside A. B's main agent has
    // edited nothing, so B stays quiet — then B's own edit fires B. The second half
    // is what makes the first mean something.
    const stopB = runDevVerifyStop(projectB, plugin, sessionB, { processCwd: projectA });
    expect(blocked(stopB.stdout), `B. stdout=${stopB.stdout} stderr=${stopB.stderr}`).toBe(false);
    runEdit(projectB, plugin, sessionB, { processCwd: projectA });
    const ownStopB = runDevVerifyStop(projectB, plugin, sessionB, { processCwd: projectA });
    expect(blocked(ownStopB.stdout), `B own. stdout=${ownStopB.stdout} stderr=${ownStopB.stderr}`).toBe(true);
  }, 360_000);

  it('falls back to the process cwd when the payload names no cwd', () => {
    const plugin = makeDir(created, 'plugin');
    const project = makeRepo(created, 'proj');
    const session = sid('nocwd');
    // Payloads WITHOUT a `cwd` key, sent from a process running in the project.
    runHookPatiently(hookPath('mark-main-agent-edit.js'), {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(project, 'tracked.txt') },
      session_id: session,
    }, { cwd: project, pluginRoot: plugin });
    const stop = runHookPatiently(hookPath('dev-verify-gate.js'), {
      hook_event_name: 'Stop',
      stop_hook_active: false,
      session_id: session,
    }, { cwd: project, pluginRoot: plugin });

    expect(blocked(stop.stdout), `stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(true);
  }, 120_000);
});
