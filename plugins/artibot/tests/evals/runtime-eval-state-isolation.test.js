/**
 * The runtime eval harness must not write hook state into the developer's real
 * `~/.claude/artibot`. (O2)
 *
 * ── the defect this pins ─────────────────────────────────────────────────────
 * `lib/runtime/evaluator.js` runs the REAL `user-prompt-handler.js` and
 * `runtime-prompt.js` hooks as child processes (scenario `reverify-hook-chain`)
 * with a synthetic prompt. Before O2 those hooks kept the user profile and the
 * token-usage file under `<pluginRoot>/runtime/` — inside the repository, where
 * `.gitignore` swallows it. O2 moved that state to `resolveArtibotDir()`
 * (`~/.claude/artibot`), so the same harness began writing to the developer's own
 * state dir. Measured 2026-09-30: one `npm run eval:runtime:check` (the last stage
 * of `npm run ci`) created `~/.claude/artibot/runtime/token-usage-session.json` and a
 * `user-profile.json` — a copy of the owner's real profile with the eval prompt
 * appended as a fourth signal. Under vitest this cannot happen, because
 * `tests/setup/state-dir.js` redirects the state dir for every worker; the
 * leak was only in the CLI path (`scripts/evals/run-runtime-task-suite.js`,
 * `scripts/ci/validate-runtime-evals.js`), which has no such setup.
 *
 * ── how this test sees it ────────────────────────────────────────────────────
 * It removes the state-dir override (as the CLI path has none), points HOME at a
 * scratch directory, runs the scenario, and looks for ANY state dir under that
 * HOME. The CONTROL half proves the detector can see a leak at all: the same hook
 * run directly, with the same HOME and no override, does write there — so an empty
 * result for the harness means the harness redirected, not that nothing is ever
 * written.
 *
 * WHAT THIS CANNOT SEE: hooks other than the two the harness spawns, and a
 * developer whose HOME is the real one while the override is set by hand to the
 * real state dir (an explicit choice, honoured).
 *
 * @module tests/evals/runtime-eval-state-isolation
 */

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_RUNTIME_EVAL_SCENARIOS, evaluateRuntimeScenario } from '../../lib/runtime/evaluator.js';

// Two real hook processes per scenario; under a busy machine that alone crosses 30 s.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME_PROMPT = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'runtime-prompt.js');

const ENV_KEYS = [
  'HOME', 'USERPROFILE', 'ARTIBOT_STATE_DIR', 'ARTIBOT_STATE_DIR_HOME', 'ARTIBOT_USER_PROFILE_PATH',
  'CLAUDE_PLUGIN_ROOT',
];

let base;
let home;
let savedEnv;

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'artibot-eval-iso-'));
  home = path.join(base, 'home');
  mkdirSync(home, { recursive: true });
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // The CLI path (`npm run eval:runtime`) has no vitest setup, hence no override.
  delete process.env.ARTIBOT_STATE_DIR;
  delete process.env.ARTIBOT_STATE_DIR_HOME;
  delete process.env.ARTIBOT_USER_PROFILE_PATH;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

const stateDirUnderHome = () => path.join(home, '.claude', 'artibot');

describe('runtime eval harness — state isolation (O2)', () => {
  it('CONTROL: the runtime-prompt hook, run the way the harness runs it but with no redirect, writes under HOME', () => {
    // Without this, "nothing under HOME" below could also mean "the hook writes nothing here".
    const project = path.join(base, 'project');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    const r = spawnSync(process.execPath, [RUNTIME_PROMPT], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', user_prompt: 'fix typo in readme', cwd: project }),
      encoding: 'utf8',
      cwd: project,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
        ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
      },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(stateDirUnderHome(), 'runtime', 'token-usage-session.json'))).toBe(true);
  });

  it('the hook-chain scenario passes and leaves no state dir under HOME', async () => {
    const scenario = DEFAULT_RUNTIME_EVAL_SCENARIOS.find((item) => item.id === 'reverify-hook-chain');
    expect(scenario, 'the scenario that spawns the hooks still exists').toBeDefined();

    const result = await evaluateRuntimeScenario(scenario);

    expect(result.passed, JSON.stringify(result.assertions)).toBe(true);
    expect(existsSync(stateDirUnderHome())).toBe(false);
  });

  it('an operator-supplied state dir is honoured, not replaced', async () => {
    const mine = path.join(base, 'operator-state');
    process.env.ARTIBOT_STATE_DIR = mine;
    process.env.ARTIBOT_STATE_DIR_HOME = home;
    const scenario = DEFAULT_RUNTIME_EVAL_SCENARIOS.find((item) => item.id === 'reverify-hook-chain');

    const result = await evaluateRuntimeScenario(scenario);

    expect(result.passed, JSON.stringify(result.assertions)).toBe(true);
    // the hook wrote where it was told to, and nothing went to the HOME-derived dir
    expect(existsSync(path.join(mine, 'runtime', 'token-usage-session.json'))).toBe(true);
    expect(existsSync(stateDirUnderHome())).toBe(false);
  });
});
