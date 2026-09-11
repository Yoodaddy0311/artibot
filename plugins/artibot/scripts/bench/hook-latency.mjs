#!/usr/bin/env node
/**
 * Hook latency bench runner — measures what each registered hook slot costs.
 *
 * WHY THIS EXISTS
 *
 * `hooks/hooks.json` declares a timeout per slot (in SECONDS — see that file's
 * `:3` description header) and the dispatchers fan each slot out into N child
 * Node processes (`scripts/hooks/_dispatcher-utils.js#spawnHook`). Both numbers
 * are declarations, not observations: nothing in the repository measures how
 * long a slot actually takes, nor how many children it actually spawns. A slot
 * that quietly grew to 80% of its declared budget looks identical, in every
 * green test, to one sitting at 5%. This runner turns both into numbers.
 *
 * It is a MEASURING INSTRUMENT ONLY. It never edits a hook, a dispatcher, or a
 * budget. A slot that overruns its budget is reported, not fixed — the repair
 * is a separate, human-approved decision.
 *
 * WHAT THIS TOOL CANNOT SEE (read before quoting any number it prints)
 *
 *   1. Host IPC latency. The wall clock starts immediately before `spawn()` and
 *      stops on the child's `exit` event. Claude Code's own overhead — matching
 *      the hook entry, serializing the payload, reading the response, and
 *      whatever it does between slots — is outside this window. The real
 *      user-visible stall is this number PLUS an unmeasured host cost.
 *   2. Real payload size. Payloads here are synthetic and small. A real
 *      transcript path points at a file that exists and can be megabytes; a
 *      real `tool_input` can carry a large `content` string. `readPayload()`
 *      parses the whole of stdin, so a real payload is strictly more work than
 *      a synthetic one. Direction of the bias is known: this UNDER-reports.
 *   3. Concurrent-session contention. One bench process runs one slot at a
 *      time on an otherwise-live machine. Real sessions overlap: several
 *      windows can hit SessionStart or PostToolUse at once and contend for CPU
 *      and for the same on-disk stores. Not modelled.
 *   4. Network hooks. `ARTIBOT_SWARM_DISABLE` and `ARTIBOT_HTTP_NOTIFY_DISABLE`
 *      are set for every run, exactly as the dispatcher test suites set them.
 *      `swarm-sync` (15s budget) and `http-notify` (8s budget) therefore return
 *      early here and contribute close to nothing. The SessionEnd and
 *      SessionStart numbers below are LOWER BOUNDS for that reason, and the two
 *      largest per-hook budgets in those slots are the ones being suppressed.
 *   5. Sandbox repository is not the artibot repository. The sandbox cwd is a
 *      throwaway `git init` with one commit and NO remote, so
 *      `isAutopilotAllowed()` reads an empty remote URL and returns false
 *      (`lib/autopilot/repo-identity.js#isAutopilotAllowed` ->
 *      `#isRepoInAllowlist`, which returns false on an empty url), and
 *      `isArtibotRepo()` finds no `plugins/artibot/CLAUDE.md`. So
 *      `git-autopilot-setup.js` returns at its `isAutopilotAllowed(repoRoot) ||
 *      isArtibotRepo(repoRoot)` gate, never writes `.git/autopilot.json`, and
 *      `git-autopilot-session.js#loadConfig` then finds no config and returns
 *      too. That is deliberate — it is what keeps the bench off the real
 *      repository and off the network — but it means every git-autopilot hook
 *      is measured on its EARLY-RETURN path, not its working path.
 *   6. A tiny, freshly-committed `bench.txt` is what PostToolUse:Write is
 *      pointed at. Language-specific gates (`quality-gate.js` and friends) do
 *      much less on a 1-byte `.txt` than on a real source edit.
 *   7. Non-Node children. The child probe counts Node processes only, via
 *      `NODE_OPTIONS=--import`. A hook that shells out to `git` spawns a
 *      process this instrument does not see.
 *   8. First-run effects. Each slot gets a FRESH sandbox home, so caches that a
 *      long-lived home would already hold are cold. Warmup runs absorb some of
 *      this; they are reported separately rather than discarded silently.
 *   9. Who wrote a string into a store. A store that logs human input can
 *      contain any string a human can type, including this tool's own naming
 *      conventions: `bash-risk-guard` records a blocked command verbatim, so
 *      one operator pasting a path like `…/artibot-bench-cwd-XYZ/bench.txt`
 *      puts that text in the ledger with no bench process involved. Measured
 *      twice, 2026-09-11. The leak verdict therefore matches only values this
 *      run generated (random suffixes, recorded at generation time) and never
 *      a naming pattern — see benchLeakCounts().
 *
 * ISOLATION
 *
 * Every child runs with HOME/USERPROFILE and cwd redirected into throwaway
 * temp directories, and with the same four disable flags the dispatcher test
 * suites use, plus a fifth env that REDIRECTS rather than disables:
 * `ARTIBOT_USER_PROFILE_PATH`. It exists because moving HOME is not enough for
 * that one store — `artibot.config.json`'s `ux.profilePath` is
 * plugin-root-relative, and `CLAUDE_PLUGIN_ROOT` below deliberately points at
 * the real checkout, so the skill-level profile resolved under the developer's
 * live tree no matter where HOME pointed. Measured 2026-09-11 before the fix:
 * one `--slot all --n 3 --warmup 1` run grew the real
 * `runtime/user-profile.json` from 2,433 to 2,988 B, and all 25 signals in it
 * were the bench's own fixture prompt. A redirect is used instead of a
 * `*_DISABLE` flag on purpose: disabling would skip the write and shorten the
 * very UserPromptSubmit latency this tool reports. This is the convention
 * established by
 * `tests/dispatcher/sessionstart-dispatcher.test.js` and
 * `tests/dispatcher/sessionend-dispatcher.test.js` after measured incidents in
 * which test fixtures reached the developer's real learning store and the real
 * `.git/autopilot.json`. `tests/firewall/dispatcher-cwd-sandbox-required.test.js`
 * does not scan `scripts/`, so nothing forces the convention here — this file
 * follows it voluntarily, and verifies the result with the guard snapshots.
 *
 * WRITERS MODES (`--writers`)
 *
 * The guards answer two different questions and only one of them is about this
 * process. "Did anything change in a guarded store" is the strongest check
 * available, and on a machine with a second Claude session open it is also
 * structurally unpassable: that session writes `<repo>/.artibot/runtime/` and
 * `<home>/.artibot/` through its own hooks whenever it feels like it, so a
 * strict run becomes a report on the operator's other window. Measured
 * 2026-09-11, the worktree ledger grew 2,744 -> 8,254 -> 12,755 bytes across
 * twenty minutes in which this bench wrote nothing to it.
 *
 * So there are two modes and the default is the strict one:
 *
 *   strict (default)  Any change to a `tree` guard is exit 2. A clean strict
 *                     run is only obtainable on an idle machine, and that is
 *                     precisely what makes it worth having: it is the only
 *                     result that rules out an unattributable write.
 *   tolerate          A change carrying NONE of this run's generated values is
 *                     reported as `CHANGED (unattributed …)` at exit 0, with
 *                     the rows that appeared (`unattributedRows`: file, session
 *                     id, timestamp, event) as the evidence. A generated value
 *                     is still a LEAK at exit 2 in either mode.
 *
 * WHAT TOLERATE CANNOT SEE. It clears a change on the absence of a fingerprint,
 * and a leak does not have to carry one. A hook that bumps a counter, appends a
 * row keyed only by tool name, or rewrites a summary file derived from bench
 * activity leaves nothing with a random suffix in it — tolerate reads that as
 * another session's traffic and passes. Strict would fail it. That is the whole
 * trade: tolerate buys reproducibility on a busy machine with sensitivity to
 * fingerprint-free writes, so `strictWouldFail` rides along on every report and
 * a tolerated pass must never be quoted as if it were a strict one.
 *
 * TWO LAYERS, TWO POLICIES, ON PURPOSE. The CLI REJECTS an unrecognized mode:
 * `parseArgs` throws and the process exits 1 (measured: `--writers lenient` ->
 * exit 1, one stderr line naming the accepted values). The library NORMALIZES
 * one: `compareGuards(before, after, options)` treats anything that is not the
 * string `tolerate` — absent, misspelled, undefined — as `strict`. An operator
 * who types a mode has an intent that a typo would silently betray, so the
 * command surface demands an exact word; a caller that omits the option wants
 * the default, and the default must be the safe end of the range. The
 * asymmetry is the point, not an oversight: neither layer can be made to
 * silently run in the weaker mode.
 *
 * One deliberate divergence from those suites: the sandbox cwd IS a git
 * repository here, where theirs is not. They use a non-git cwd to make the
 * git-autopilot hooks structurally unable to act. A latency bench that skipped
 * every git code path would measure the wrong thing, so this file restores the
 * repository and relies on the allowlist gate above (item 5) for safety —
 * a throwaway repo with no remote is not in `DEFAULT_ALLOWLIST`.
 *
 * @module scripts/bench/hook-latency
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isMainEntry } from '../hooks/_main-entry.js';
import { loadDispatchTable } from '../../lib/dispatcher/dispatch-table-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** plugins/artibot/scripts/bench -> plugins/artibot */
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

/** cwd at process start, captured before any sandbox chdir-equivalent. */
const INVOCATION_CWD = process.cwd();

/** Upper bound on files walked per guard path, so a pathological tree cannot hang the run. */
const GUARD_FILE_LIMIT = 20000;

/**
 * Upper bound on per-file entries carried in a guard's before/after listing.
 * The digest covers every file regardless; only the human-readable listing is
 * capped, and a capped listing says so via `entriesTruncated`.
 */
const GUARD_ENTRY_LIMIT = 200;

/**
 * Upper bound on rows reported per guard by `--writers tolerate`, and on the
 * per-file row tail kept in a snapshot to produce them.
 */
const ROW_TAIL_LIMIT = 20;

/** Guard judgement modes. See the WRITERS MODES section of the module header. */
const WRITERS_MODES = ['strict', 'tolerate'];

/** Session-id prefix. Fixed on purpose — see makeSessionId(). */
const BENCH_PREFIX = 'bench-';

/** Sandbox directory-name prefix. Also a leak marker — see benchLeakCounts(). */
const SANDBOX_PREFIX = 'artibot-bench-';

/** Synthetic agent id used by the SubagentStart / SubagentStop payloads. */
const BENCH_AGENT_ID = 'bench-agent';

/**
 * Naming PATTERNS this bench uses but did not invent. Counted and reported,
 * never used to fail a run — see benchLeakCounts() for the two measured false
 * positives that put them on this side of the line.
 *
 * `BENCH_AGENT_ID` belongs here for the same reason the prefixes do: the bench
 * uses that literal but did not mint it, so any process could have written it.
 */
const INFORMATIONAL_MARKERS = [SANDBOX_PREFIX, BENCH_PREFIX, BENCH_AGENT_ID];

/**
 * Values THIS process generated, which nothing else can have produced.
 *
 * Populated at creation time — by makeSessionId() for ids and createSandbox()
 * for directories — rather than reconstructed afterwards: a value that was
 * generated but not recorded here is a blind spot in the leak scan, and
 * reconstruction would mean re-deriving random suffixes, which is not possible.
 * Same discipline as the enumerated id list in
 * `tests/dispatcher/sessionend-dispatcher.test.js`.
 *
 * This set, and only this set, decides the leak verdict.
 */
const EMITTED_SESSION_IDS = new Set();

/** Sandbox directory names generated by this process. See recordSandboxPaths(). */
const EMITTED_SANDBOX_NAMES = new Set();

/**
 * Record every spelling of a sandbox directory that could appear in a store.
 *
 * Three spellings, because a path does not survive serialization intact:
 *   - the native path, as `mkdtemp` returned it (backslashes on Windows);
 *   - the forward-slash form, which hooks and JSON payloads frequently carry;
 *   - the bare basename, which is separator-free and therefore immune to both.
 *
 * The basename is the load-bearing one. A backslash path embedded in a JSONL
 * row is written `C:\\<dir>\\…`, so a substring search for the native spelling
 * misses it entirely, and a search for the forward-slash spelling misses the
 * native one. The basename carries mkdtemp's random 6-character suffix, so it
 * is both unique to this run and spelling-independent.
 *
 * @param {string[]} dirs absolute sandbox directories
 * @returns {void}
 */
function recordSandboxPaths(dirs) {
  for (const dir of dirs) {
    EMITTED_SANDBOX_NAMES.add(dir);
    EMITTED_SANDBOX_NAMES.add(dir.split(path.sep).join('/'));
    EMITTED_SANDBOX_NAMES.add(path.basename(dir));
  }
}

/**
 * The values whose appearance in a real store fails the run.
 *
 * Every member carries a random suffix minted by this process, so nothing else
 * can have produced one. No fixed literal is admitted here — not
 * `BENCH_AGENT_ID`, not the sandbox prefix — because a fixed literal is exactly
 * what a passer-by can type, which is the failure mode that produced two
 * measured false alarms.
 *
 * @returns {string[]}
 */
function exactLeakMarkers() {
  return [...EMITTED_SESSION_IDS, ...EMITTED_SANDBOX_NAMES];
}

/**
 * Source of the child-counting probe, written into the sandbox home and
 * injected with `NODE_OPTIONS=--import`.
 *
 * This works because `spawnHook` passes `env: { ...process.env }`
 * (`scripts/hooks/_dispatcher-utils.js#spawnHook`) and the UserPromptSubmit
 * dispatcher's own `spawn` passes no `env` at all
 * (`_userprompt-dispatcher.js#runGitAutopilotSave`), so both inherit
 * NODE_OPTIONS. Verified there is no code that strips it: a repo-wide grep for
 * `NODE_OPTIONS` across .js/.mjs/.json outside node_modules returns 0 matches
 * (measured 2026-09-11).
 *
 * The probe appends one line and does nothing else. It is NEVER present during
 * a timing run — `--import` costs a module load in every child, which is
 * exactly the quantity being measured.
 */
const PID_PROBE_SOURCE = [
  "import { appendFileSync } from 'node:fs';",
  "import path from 'node:path';",
  '',
  '// Bench child probe. One append per Node process, then out of the way.',
  'try {',
  '  const log = process.env.ARTIBOT_BENCH_PIDLOG;',
  '  if (log) {',
  "    const [, mainScript] = process.argv;",
  "    const script = path.basename(mainScript || '(none)');",
  "    appendFileSync(log, process.pid + '\\t' + process.ppid + '\\t' + script + '\\n');",
  '  }',
  '} catch { /* a probe must never break the process it is measuring */ }',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Declared budgets, read from hooks.json rather than copied into this file.
// ---------------------------------------------------------------------------

/**
 * Map every hooks.json registration to its declared timeout in MILLISECONDS.
 *
 * The key is the command tail after `scripts/hooks/`, arguments included, e.g.
 * `subagent-handler.js start` — because that same script is registered twice
 * with different arguments and the two are different slots.
 *
 * `timeout` in hooks.json is in seconds (that file's own `description` says so
 * at `:3`); the multiplication below is the only place that conversion lives.
 *
 * @returns {Record<string, number>}
 */
function readDeclaredBudgets() {
  const raw = readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  const out = {};
  for (const entries of Object.values(parsed.hooks || {})) {
    for (const entry of entries || []) {
      for (const hook of entry.hooks || []) {
        const marker = '/scripts/hooks/';
        const at = String(hook.command || '').indexOf(marker);
        if (at < 0) continue;
        const key = String(hook.command).slice(at + marker.length).trim();
        if (typeof hook.timeout === 'number') out[key] = hook.timeout * 1000;
      }
    }
  }
  return out;
}

const DECLARED_BUDGETS = readDeclaredBudgets();

/**
 * Declared budget for one command tail, or null when hooks.json does not
 * register it. Null is reported as `n/a` rather than guessed.
 *
 * @param {string} commandTail e.g. "pre-write.js" or "subagent-handler.js start"
 * @returns {number|null}
 */
function budgetFor(commandTail) {
  const value = DECLARED_BUDGETS[commandTail];
  return typeof value === 'number' ? value : null;
}

/**
 * How many child processes a dispatcher slot is CONFIGURED to spawn, read from
 * `hooks/dispatch-table.json` through the same loader the dispatchers use so
 * the two cannot drift.
 *
 * `toolName` applies to PostToolUse only, whose dispatcher filters handlers by
 * their `tools` array before spawning anything
 * (`scripts/hooks/_posttooluse-dispatcher.js#selectHooks`).
 *
 * @param {string} slotName dispatch-table slot key
 * @param {string} [toolName]
 * @returns {number}
 */
function staticChildCount(slotName, toolName) {
  const handlers = loadDispatchTable(slotName);
  if (!toolName) return handlers.length;
  return handlers.filter(
    (h) => Array.isArray(h.tools) && (h.tools.includes('*') || h.tools.includes(toolName)),
  ).length;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

/**
 * Synthetic session id for a bench run.
 *
 * The `bench-` prefix is load-bearing, not decorative. Existing fixture suites
 * claim the prefixes `end-test` and `stop-test`, and their leak checks look for
 * exactly those; a bench id that collided with one would trip a suite that has
 * nothing to do with this file. It is also what the `.claude/artibot` guard
 * scans for, since that store is written by the live session concurrently and
 * cannot be compared byte-for-byte.
 *
 * @param {string} slotName
 * @returns {string}
 */
function makeSessionId(slotName) {
  const slug = slotName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  const id = `${BENCH_PREFIX}${slug}-${Math.random().toString(36).slice(2, 10)}`;
  EMITTED_SESSION_IDS.add(id);
  return id;
}

/**
 * Fields every hook payload carries.
 *
 * `transcript_path` deliberately names a file that does NOT exist: creating a
 * realistic transcript would be a second, uncontrolled variable, and hooks that
 * read it are expected to tolerate absence.
 *
 * @param {string} slotName
 * @param {string} eventName hook_event_name as the host spells it
 * @param {{cwd: string}} sandbox
 * @returns {object}
 */
function basePayload(slotName, eventName, sandbox) {
  return {
    session_id: makeSessionId(slotName),
    transcript_path: path.join(sandbox.cwd, 'transcript.jsonl'),
    cwd: sandbox.cwd,
    hook_event_name: eventName,
  };
}

/**
 * PreToolUse/PostToolUse payload for a Write against the sandbox's committed
 * `bench.txt`.
 *
 * @param {string} slotName
 * @param {string} eventName
 * @param {{cwd: string}} sandbox
 * @returns {object}
 */
function writeToolPayload(slotName, eventName, sandbox) {
  return {
    ...basePayload(slotName, eventName, sandbox),
    tool_name: 'Write',
    tool_input: { file_path: path.join(sandbox.cwd, 'bench.txt'), content: 'x' },
  };
}

/**
 * Bash-tool payload. The command is `echo bench` and must stay harmless: a
 * risky-looking string here would be scanned by the risk guards under
 * measurement and would also trip the guards of the session running this file.
 *
 * @param {string} slotName
 * @param {string} eventName
 * @param {{cwd: string}} sandbox
 * @returns {object}
 */
function bashToolPayload(slotName, eventName, sandbox) {
  return {
    ...basePayload(slotName, eventName, sandbox),
    tool_name: 'Bash',
    tool_input: { command: 'echo bench' },
  };
}

// ---------------------------------------------------------------------------
// Slot registry
// ---------------------------------------------------------------------------

/**
 * Every measurable slot.
 *
 * `kind` distinguishes the two shapes hooks.json registers:
 *   - `dispatcher` — one registered command that fans out to N children.
 *   - `direct`     — the hook script itself is the registered command.
 *
 * `staticChildren` is the CONFIGURED child count (0 for direct hooks); the
 * probe run measures the actual count and the report prints both side by side.
 *
 * @type {Record<string, {kind: string, script: string, args: string[],
 *   budgetMs: number|null, staticChildren: number, payload: (sb: object) => object}>}
 */
export const SLOTS = buildSlots();

/**
 * Build the slot registry. A function rather than a literal so the dispatch
 * table and hooks.json are read once, at import, and a drift between them
 * surfaces immediately instead of mid-run.
 *
 * @returns {Record<string, object>}
 */
function buildSlots() {
  /**
   * @param {string} kind
   * @param {string} script PLUGIN_ROOT-relative
   * @param {string[]} args
   * @param {number|null} budgetMs
   * @param {number} staticChildren
   * @param {(sb: object) => object} payload
   * @returns {object}
   */
  const slot = (kind, script, args, budgetMs, staticChildren, payload) => ({
    kind, script, args, budgetMs, staticChildren, payload,
  });

  const dispatcher = (file) => `scripts/hooks/${file}`;
  const direct = (file) => `scripts/hooks/${file}`;

  const slots = {
    SessionStart: slot(
      'dispatcher', dispatcher('_sessionstart-dispatcher.js'), [],
      budgetFor('_sessionstart-dispatcher.js'), staticChildCount('SessionStart'),
      (sb) => ({ ...basePayload('SessionStart', 'SessionStart', sb), source: 'startup' }),
    ),
    UserPromptSubmit: slot(
      // The UserPromptSubmit dispatcher imports its 7 handlers in-process
      // (dispatch-table.json marks the slot `in-process-import`); the only
      // child it spawns is git-autopilot-save, hence staticChildren = 1.
      'dispatcher', dispatcher('_userprompt-dispatcher.js'), [],
      budgetFor('_userprompt-dispatcher.js'), 1,
      (sb) => ({ ...basePayload('UserPromptSubmit', 'UserPromptSubmit', sb), prompt: 'bench prompt' }),
    ),
    'PostToolUse:Write': slot(
      'dispatcher', dispatcher('_posttooluse-dispatcher.js'), [],
      budgetFor('_posttooluse-dispatcher.js'), staticChildCount('PostToolUse', 'Write'),
      (sb) => ({
        ...writeToolPayload('PostToolUse:Write', 'PostToolUse', sb),
        tool_response: { success: true },
      }),
    ),
    'PostToolUse:Bash': slot(
      'dispatcher', dispatcher('_posttooluse-dispatcher.js'), [],
      budgetFor('_posttooluse-dispatcher.js'), staticChildCount('PostToolUse', 'Bash'),
      (sb) => ({
        ...bashToolPayload('PostToolUse:Bash', 'PostToolUse', sb),
        tool_response: { stdout: 'bench\n', exitCode: 0 },
      }),
    ),
    Stop: slot(
      'dispatcher', dispatcher('_stop-dispatcher.js'), [],
      budgetFor('_stop-dispatcher.js'), staticChildCount('Stop'),
      (sb) => ({ ...basePayload('Stop', 'Stop', sb), stop_hook_active: false }),
    ),
    SessionEnd: slot(
      'dispatcher', dispatcher('_sessionend-dispatcher.js'), [],
      budgetFor('_sessionend-dispatcher.js'), staticChildCount('SessionEnd'),
      (sb) => ({ ...basePayload('SessionEnd', 'SessionEnd', sb), reason: 'other' }),
    ),
    SubagentStop: slot(
      'dispatcher', dispatcher('_subagentstop-dispatcher.js'), [],
      budgetFor('_subagentstop-dispatcher.js'), staticChildCount('SubagentStop'),
      (sb) => ({
        ...basePayload('SubagentStop', 'SubagentStop', sb),
        agent_id: BENCH_AGENT_ID,
        agent_type: 'general-purpose',
      }),
    ),
    'PreToolUse:pre-write': slot(
      'direct', direct('pre-write.js'), [], budgetFor('pre-write.js'), 0,
      (sb) => writeToolPayload('PreToolUse:pre-write', 'PreToolUse', sb),
    ),
    'PreToolUse:pre-write-guard': slot(
      'direct', direct('pre-write-guard.js'), [], budgetFor('pre-write-guard.js'), 0,
      (sb) => writeToolPayload('PreToolUse:pre-write-guard', 'PreToolUse', sb),
    ),
    'PreToolUse:pre-write-checkpoint': slot(
      'direct', direct('pre-write-checkpoint.js'), [], budgetFor('pre-write-checkpoint.js'), 0,
      (sb) => writeToolPayload('PreToolUse:pre-write-checkpoint', 'PreToolUse', sb),
    ),
    'PreToolUse:autopilot-guard': slot(
      'direct', direct('git-autopilot-guard.js'), [], budgetFor('git-autopilot-guard.js'), 0,
      (sb) => writeToolPayload('PreToolUse:autopilot-guard', 'PreToolUse', sb),
    ),
    'PreToolUse:pre-bash': slot(
      'direct', direct('pre-bash.js'), [], budgetFor('pre-bash.js'), 0,
      (sb) => bashToolPayload('PreToolUse:pre-bash', 'PreToolUse', sb),
    ),
    'PreToolUse:bash-risk-guard': slot(
      'direct', direct('bash-risk-guard.js'), [], budgetFor('bash-risk-guard.js'), 0,
      (sb) => bashToolPayload('PreToolUse:bash-risk-guard', 'PreToolUse', sb),
    ),
    'PreToolUse:route-observe-pre': slot(
      'direct', direct('route-observe-pre.js'), [], budgetFor('route-observe-pre.js'), 0,
      (sb) => ({
        ...basePayload('PreToolUse:route-observe-pre', 'PreToolUse', sb),
        tool_name: 'Agent',
        tool_input: { subagent_type: 'general-purpose', description: 'bench probe', prompt: 'bench prompt' },
      }),
    ),
    'PreToolUse:webfetch-cache-pre': slot(
      // `url` is example.com and never fetched by this hook: a scan of
      // webfetch-cache-pre.js for fetch(/node:http(s)/axios finds 0 matches
      // (measured 2026-09-11). It reads a local cache only.
      'direct', direct('webfetch-cache-pre.js'), [], budgetFor('webfetch-cache-pre.js'), 0,
      (sb) => ({
        ...basePayload('PreToolUse:webfetch-cache-pre', 'PreToolUse', sb),
        tool_name: 'WebFetch',
        tool_input: { url: 'https://example.com/bench', prompt: 'bench prompt' },
      }),
    ),
    PreCompact: slot(
      'direct', direct('pre-compact.js'), [], budgetFor('pre-compact.js'), 0,
      (sb) => ({
        ...basePayload('PreCompact', 'PreCompact', sb),
        trigger: 'manual',
        custom_instructions: '',
      }),
    ),
    PostCompact: slot(
      'direct', direct('post-compact-rehydrate.js'), [], budgetFor('post-compact-rehydrate.js'), 0,
      (sb) => ({
        ...basePayload('PostCompact', 'PostCompact', sb),
        trigger: 'manual',
      }),
    ),
    'SubagentStart:subagent-handler': slot(
      'direct', direct('subagent-handler.js'), ['start'],
      budgetFor('subagent-handler.js start'), 0,
      (sb) => ({
        ...basePayload('SubagentStart:subagent-handler', 'SubagentStart', sb),
        agent_id: BENCH_AGENT_ID,
        agent_type: 'general-purpose',
      }),
    ),
    'SubagentStart:workflow-status': slot(
      'direct', direct('workflow-status.js'), ['teammate-update'],
      budgetFor('workflow-status.js teammate-update'), 0,
      (sb) => ({
        ...basePayload('SubagentStart:workflow-status', 'SubagentStart', sb),
        agent_id: BENCH_AGENT_ID,
        agent_type: 'general-purpose',
      }),
    ),
  };

  return slots;
}

/**
 * Look a slot up by name, with a listing in the error rather than `undefined`
 * three frames later.
 *
 * @param {string} slotName
 * @returns {object}
 */
function requireSlot(slotName) {
  const slot = SLOTS[slotName];
  if (!slot) {
    throw new Error(
      `unknown slot "${slotName}". Known slots:\n  ${Object.keys(SLOTS).join('\n  ')}`,
    );
  }
  return slot;
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/**
 * Create a throwaway home + working directory for one slot's runs.
 *
 * The working directory is a real git repository with exactly one commit and
 * no remote. `-c user.name` / `-c user.email` are mandatory, not tidiness:
 * HOME and USERPROFILE are about to point at an empty sandbox, so the global
 * gitconfig that normally supplies an identity is unreadable and `commit`
 * would fail with "Please tell me who you are".
 *
 * `GIT_CONFIG_NOSYSTEM` and `GIT_TERMINAL_PROMPT=0` keep the system-level
 * config and any credential prompt out of the sandbox as well.
 *
 * @returns {{home: string, cwd: string, cleanup: () => string[]}}
 */
export function createSandbox() {
  // Both names are built from SANDBOX_PREFIX so the informational marker cannot
  // drift away from the directory names it counts.
  const home = mkdtempSync(path.join(os.tmpdir(), `${SANDBOX_PREFIX}home-`));
  const cwd = mkdtempSync(path.join(os.tmpdir(), `${SANDBOX_PREFIX}cwd-`));
  // Register before anything can be written with these paths in it.
  recordSandboxPaths([home, cwd]);

  writeFileSync(path.join(cwd, 'README.md'), 'artibot hook-latency bench sandbox\n', 'utf-8');
  writeFileSync(path.join(cwd, 'bench.txt'), 'x', 'utf-8');

  const gitEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const identity = ['-c', 'user.name=artibot-bench', '-c', 'user.email=bench@artibot.invalid'];
  const run = (args) => {
    execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore', windowsHide: true });
  };

  run(['init', '-q']);
  run([...identity, 'add', 'README.md', 'bench.txt']);
  run([...identity, 'commit', '-q', '-m', 'bench sandbox init']);

  return {
    home,
    cwd,
    /**
     * Remove both directories and REPORT what survived.
     *
     * Returning the survivors rather than swallowing the error, because a
     * swallowed error is indistinguishable from success. Measured 2026-09-11,
     * shortly after a 19-slot sweep: one `artibot-bench-cwd-*` was still on
     * disk with its `.git`, `README.md` and `bench.txt` intact, and its paired
     * home directory was present but empty. Re-checked a few minutes later,
     * both were gone with no further action — the signature of a Windows
     * deferred delete, where a handle held by a just-exited child keeps the
     * directory listed until the last reference closes.
     *
     * So the observed case resolved itself and this is NOT a demonstrated
     * permanent leak. The retries and the survivor list are here because the
     * distinction cannot be drawn from inside the old code path: EBUSY that
     * clears in 200ms and EPERM that never clears both looked like silent
     * success. A tool meant to be run repeatedly should say which one it hit.
     *
     * @returns {string[]} paths that could not be removed
     */
    cleanup() {
      const survivors = [];
      for (const dir of [home, cwd]) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch { /* recorded below rather than rethrown — cleanup never fails a run */ }
        if (existsSync(dir)) survivors.push(dir);
      }
      return survivors;
    },
  };
}

/**
 * Environment for a measured child. Mirrors the four disable flags and the two
 * home redirections that every dispatcher test suite sets (see the module
 * header), plus `CLAUDE_PLUGIN_ROOT` so the child resolves this checkout.
 *
 * @param {{home: string}} sandbox
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
function hookEnv(sandbox, extra) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    // getHomeDir() reads USERPROFILE then HOME — both must move or the real
    // learning store receives the bench fixtures.
    USERPROFILE: sandbox.home,
    HOME: sandbox.home,
    // Redirect, not a disable: `ux.profilePath` is plugin-root-relative, so
    // the two lines above do NOT move this store. See ISOLATION in the header.
    ARTIBOT_USER_PROFILE_PATH: path.join(sandbox.home, '.claude', 'artibot', 'user-profile.json'),
    ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: '1',
    ARTIBOT_RUNTIME_MEMORY_DISABLE: '1',
    ARTIBOT_SWARM_DISABLE: '1',
    ARTIBOT_HTTP_NOTIFY_DISABLE: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Count non-empty stderr lines.
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((line) => line.length > 0).length;
}

/**
 * Run one slot exactly once and time it.
 *
 * The clock starts immediately before `spawn()` and stops on `exit`. The
 * promise settles on `close` instead, one tick later, because stdout can still
 * be draining at `exit` and the byte count would otherwise be short — but the
 * reported `ms` is the exit-event value, never the close-event one.
 *
 * @param {string} slotName
 * @param {{home: string, cwd: string}} sandbox
 * @param {{env?: Record<string,string>, killAfterMs?: number}} [opts]
 * @returns {Promise<{ms: number, exitCode: number|null, stdoutBytes: number,
 *   stderrLines: number, timedOut: boolean}>}
 */
export async function runOnce(slotName, sandbox, opts = {}) {
  const slot = requireSlot(slotName);
  const scriptPath = path.join(PLUGIN_ROOT, slot.script);
  const payload = slot.payload(sandbox);
  const env = hookEnv(sandbox, opts.env);
  // Twice the declared budget: a child that outlives that is hung, and the
  // bench must report it rather than hang with it.
  const killAfterMs = opts.killAfterMs || Math.max(30000, (slot.budgetMs || 30000) * 2);

  return new Promise((resolve) => {
    let stdoutBytes = 0;
    let stderrText = '';
    let exitMs = null;
    let exitCode = null;
    let timedOut = false;
    let settled = false;

    const started = performance.now();
    const child = spawn(process.execPath, [scriptPath, ...slot.args], {
      cwd: sandbox.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }, killAfterMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ms: exitMs === null ? performance.now() - started : exitMs,
        exitCode,
        stdoutBytes,
        stderrLines: countLines(stderrText),
        timedOut,
      });
    };

    child.on('error', () => { finish(); });
    child.on('exit', (code) => {
      exitMs = performance.now() - started;
      exitCode = code;
    });
    child.on('close', () => { finish(); });

    if (child.stdout) child.stdout.on('data', (chunk) => { stdoutBytes += chunk.length; });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf-8'); });

    try {
      child.stdin.end(JSON.stringify(payload));
    } catch { /* exit/close handlers still settle the promise */ }
  });
}

/**
 * Percentile by the nearest-rank method on an ascending copy.
 * p95 of n=20 is sorted[18]; p95 of n=5 is sorted[4].
 *
 * @param {number[]} sorted ascending
 * @param {number} q 0..1
 * @returns {number}
 */
function percentile(sorted, q) {
  const index = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[index];
}

/** @param {number} value @returns {number} value rounded to 2 decimals */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Descriptive statistics for a sample array, in milliseconds.
 *
 * @param {number[]} samples
 * @returns {{p50: number|null, p95: number|null, max: number|null, min: number|null, mean: number|null}}
 */
export function summarize(samples) {
  const list = (samples || []).filter((value) => typeof value === 'number');
  if (list.length === 0) return { p50: null, p95: null, max: null, min: null, mean: null };
  const sorted = [...list].sort((a, b) => a - b);
  const total = sorted.reduce((acc, value) => acc + value, 0);
  return {
    p50: round2(percentile(sorted, 0.5)),
    p95: round2(percentile(sorted, 0.95)),
    max: round2(sorted[sorted.length - 1]),
    min: round2(sorted[0]),
    mean: round2(total / sorted.length),
  };
}

/**
 * Count the Node processes one slot invocation actually creates.
 *
 * A SEPARATE run from the timed ones, because `--import` adds a module load to
 * every child and would inflate exactly the number being measured.
 *
 * `measured` is distinct pids minus one — the dispatcher (or the direct hook)
 * logs itself too, and it is not its own child. A direct hook that spawns
 * nothing therefore measures 0, matching its `staticChildren`.
 *
 * @param {string} slotName
 * @param {{home: string, cwd: string}} sandbox
 * @returns {Promise<{measured: number|null, staticCount: number, scripts: string[],
 *   rows: Array<{pid: number, ppid: number, script: string}>, rootPid: number|null,
 *   grandchildren: number|null, note: string|null}>}
 */
async function probeChildren(slotName, sandbox) {
  const slot = requireSlot(slotName);
  const probePath = path.join(sandbox.home, 'pid-probe.mjs');
  const pidLog = path.join(sandbox.home, `pidlog-${makeSessionId(slotName)}.tsv`);
  writeFileSync(probePath, PID_PROBE_SOURCE, 'utf-8');
  writeFileSync(pidLog, '', 'utf-8');

  const href = pathToFileURL(probePath).href;
  const importArg = href.includes(' ') ? `"${href}"` : href;
  const result = await runOnce(slotName, sandbox, {
    env: { NODE_OPTIONS: `--import ${importArg}`, ARTIBOT_BENCH_PIDLOG: pidLog },
  });

  let raw = '';
  try {
    raw = readFileSync(pidLog, 'utf-8');
  } catch { /* handled by the emptiness check below */ }

  const rows = new Map();
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    if (!rows.has(parts[0])) {
      rows.set(parts[0], { pid: Number(parts[0]), ppid: Number(parts[1]), script: parts[2] });
    }
  }

  if (rows.size === 0) {
    return {
      measured: null,
      staticCount: slot.staticChildren,
      scripts: [],
      rows: [],
      rootPid: null,
      grandchildren: null,
      note: `probe produced no rows (probe-run exit ${result.exitCode}); NODE_OPTIONS injection did not take`,
    };
  }

  // The ppid column is what proves the probe reached PAST the first level.
  // The row whose parent is this bench process is the registered command
  // itself; rows whose parent is that pid are the hooks the dispatcher spawned,
  // i.e. grandchildren of the bench. Without this the child COUNT alone could
  // not distinguish "the probe saw the whole tree" from "the probe saw one
  // level and the count happened to match".
  const all = [...rows.values()];
  const root = all.find((row) => row.ppid === process.pid) || null;
  const grandchildren = root ? all.filter((row) => row.ppid === root.pid).length : null;

  return {
    measured: rows.size - 1,
    staticCount: slot.staticChildren,
    scripts: [...new Set(all.map((row) => row.script))].sort(),
    rows: all.sort((a, b) => a.pid - b.pid),
    rootPid: root ? root.pid : null,
    grandchildren,
    note: null,
  };
}

/**
 * Benchmark one slot: warmup runs, then N measured runs, then one child probe.
 *
 * Warmup samples are excluded from every statistic but are RETURNED, not
 * discarded — a first run far above the rest is a real property of the slot
 * (cold module cache, cold sandbox home) and hiding it would misrepresent what
 * a user's first prompt costs.
 *
 * @param {string} slotName
 * @param {{n?: number, warmup?: number, sandbox: object, probe?: boolean}} options
 * @returns {Promise<object>}
 */
export async function benchSlot(slotName, options) {
  const { n = 20, warmup = 2, sandbox, probe = true } = options || {};
  const slot = requireSlot(slotName);

  const warmupMs = [];
  for (let i = 0; i < warmup; i += 1) {
    const run = await runOnce(slotName, sandbox);
    warmupMs.push(round2(run.ms));
  }

  const samples = [];
  const stdoutBytes = [];
  const exitCodes = [];
  const stderrLines = [];
  let timeouts = 0;
  for (let i = 0; i < n; i += 1) {
    const run = await runOnce(slotName, sandbox);
    samples.push(round2(run.ms));
    stdoutBytes.push(run.stdoutBytes);
    exitCodes.push(run.exitCode);
    stderrLines.push(run.stderrLines);
    if (run.timedOut) timeouts += 1;
  }

  const stats = summarize(samples);
  const children = probe ? await probeChildren(slotName, sandbox) : null;

  return {
    slot: slotName,
    kind: slot.kind,
    script: slot.script,
    args: slot.args,
    n,
    warmup,
    warmupMs,
    samples,
    ...stats,
    stdoutBytes,
    exitCodes,
    stderrLines,
    timeouts,
    children,
    budgetMs: slot.budgetMs,
    headroomMs: slot.budgetMs === null || stats.p95 === null
      ? null
      : round2(slot.budgetMs - stats.p95),
  };
}

// ---------------------------------------------------------------------------
// Guards — proof that a bench run did not touch a real store
// ---------------------------------------------------------------------------

/**
 * The guards prove ABSENCE OF CHANGE, and they are fail-closed on purpose: any
 * byte difference in a `tree` path between the before and after snapshots is
 * reported as a violation and exits 2.
 *
 * That direction of error is deliberate but it is not free. The guarded stores
 * are LIVE — a Claude session running in another window writes
 * `<repo>/.artibot/runtime/ledger.jsonl` and `<home>/.artibot/` through its own
 * hooks, on its own schedule. If one does so while this bench is running, the
 * guard fails and blames this process for a write it did not make. The verdict
 * to draw from a FAIL is therefore "something wrote here, find out what",
 * never "the bench is broken, loosen the guard". Re-run with the other session
 * idle to separate the two.
 *
 * Measured example of how fast this moves: the worktree checked out at
 * `.claude/worktrees/split-artibot-hook-latency-bench` had no
 * `.artibot/runtime` at 2026-09-10T15:08Z (00:08 KST) and had
 * `.artibot/runtime/ledger.jsonl` (2744 bytes) at 15:22Z (00:22 KST), written
 * by the live session's own hooks with nothing to do with this file.
 */

/**
 * Normalize a guard spec. A bare string means a byte-identity tree check.
 *
 * @param {string|{path: string, mode?: string}} spec
 * @returns {{path: string, mode: string}}
 */
function normalizeGuardSpec(spec) {
  if (typeof spec === 'string') return { path: spec, mode: 'tree' };
  return { path: spec.path, mode: spec.mode || 'tree' };
}

/**
 * Every regular file under `root`, breadth-unspecified, symlinks skipped.
 * Symlinks are skipped rather than followed because following one can leave
 * the guarded subtree entirely, which would make the digest depend on
 * something the guard does not claim to cover.
 *
 * @param {string} root
 * @param {number} limit
 * @returns {string[]}
 */
function walkFiles(root, limit) {
  const files = [];
  const stack = [root];
  while (stack.length > 0 && files.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

/**
 * sha256 of one file's contents, or null when unreadable.
 * @param {string} file
 * @returns {string|null}
 */
function fileDigest(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Digest of a whole tree: every file's relative path, size and content hash,
 * sorted, then hashed. Sorting is what makes the digest independent of
 * directory-read order.
 *
 * @param {string} root
 * @returns {string}
 */
function treeDigest(root) {
  const files = walkFiles(root, GUARD_FILE_LIMIT).sort();
  const lines = files.map((file) => {
    let size = -1;
    try { size = statSync(file).size; } catch { /* recorded as -1 */ }
    return `${path.relative(root, file)}|${size}|${fileDigest(file)}`;
  });
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  return `tree:${files.length}f:${digest}`;
}

/**
 * Count this bench's fingerprints per file under a tree.
 *
 * Used instead of a byte digest for `<home>/.claude/artibot`, which the LIVE
 * Claude session running this bench is writing to concurrently — a digest there
 * changes for reasons that have nothing to do with this process, so byte
 * identity is not a claim that can be made. What CAN be checked is the
 * narrower, sufficient property: nothing this bench authored appears in the
 * real store.
 *
 * THE VERDICT AXIS IS "DID THIS RUN GENERATE IT", NOT "DOES IT LOOK LIKE US".
 * Two measured false positives, on two successive attempts, both from
 * pattern-matching a string this bench uses but did not invent:
 *
 *   1. Bare `bench-` substring, 2026-09-10T15:33Z (00:33 KST). The checkout is a worktree
 *      named `split-artibot-hook-latency-bench`, so the live session's routing
 *      rows carry agent ids like
 *      `split-artibot-hook-latency-bench-019GEYNS-runner`. Every one contains
 *      `bench-`. Direct greps of all three flagged files for sandbox directory
 *      names and for the session-id shape returned 0: the bench had written
 *      nothing, and the detector was matching a directory name the operator
 *      chose.
 *   2. `artibot-bench-` prefix, reported by a sibling teammate at 00:38 KST.
 *      Another session typed a shell command containing the literal
 *      `C:/Temp/artibot-bench-cwd-XYZ12/bench.txt`; `bash-risk-guard` blocked
 *      it and logged the command VERBATIM as a `human.asked` ledger row. The
 *      row's `session_id` was that interactive session's, not a bench id. So a
 *      real store gained the marker without any bench process running. Any
 *      fixed string is reachable this way — a store that records human input
 *      can contain anything a human can type.
 *
 * Both were the same mistake at different resolutions — matching a NAMING
 * PATTERN and reading the match as an event — so the fix is not a third,
 * cleverer pattern. The verdict now rests on values this process generated and
 * recorded at generation time:
 *
 *   - every emitted `bench-<slot>-<rand>` session id;
 *   - every spelling of the mkdtemp sandbox directories (see
 *     recordSandboxPaths).
 *
 * Both carry a random suffix, so a file cannot contain one unless this run put
 * it there. Sensitivity is unchanged by the narrowing: a leaked sandbox path
 * necessarily contains the generated basename, so every real escape the prefix
 * would have caught is still caught, while a passer-by's text is not.
 *
 * The prefixes survive as INFORMATIONAL counts, reported next to the verdict
 * and never part of it. They are still worth seeing — a stale `artibot-bench-`
 * says something about this tool's history in that store — but a count anyone
 * can raise is not evidence about this process.
 *
 * `BENCH_AGENT_ID` sits on the informational side too. It is a fixed literal
 * the bench uses but did not mint, so it is the same shape of evidence as a
 * prefix, and no fixed literal decides a verdict here.
 *
 * SELF-CHECK CONTROLS. A detector is worth only its false-negative rate, so the
 * matrix below is run against this function rather than assumed. Measured
 * approx. 2026-09-10T15:56Z (00:56 KST) — the run immediately preceded the
 * suite that started at 00:57:41, which is the closest timestamp recorded:
 *
 *   clean  another session's typed command carrying `…/artibot-bench-cwd-XYZ12/
 *          bench.txt`, logged verbatim as a `human.asked` row   <- the sibling
 *          teammate's reported false positive
 *   clean  a routing row naming the worktree
 *          `split-artibot-hook-latency-bench-019GEYNS-runner`
 *   clean  a store gaining a literal `bench-agent`
 *   LEAK   a session id this process emitted
 *   LEAK   the basename of a sandbox this process created
 *
 * And three more for `--writers tolerate`, measured approx. 2026-09-10T16:03Z
 * (01:03 KST) — again bounded by the suite that started at 01:04:36:
 *
 *   exit 0  an unrelated row appended to a `tree` store -> `CHANGED
 *           (unattributed …)`, violation false, strictWouldFail TRUE, and one
 *           entry in `unattributedRows` naming the writing session
 *   exit 2  a row carrying a generated value -> `LEAK`, violation true, in
 *           tolerate exactly as in strict
 *   exit 0  no change at all -> `unchanged`, strictWouldFail false, no rows
 *
 * The executable form lives in `tests/bench/hook-latency.test.js`, owned by
 * another teammate. Each clean case above must ALSO show a non-zero
 * `informational` count: "not a violation" and "not visible" are different
 * claims, and only the first one is being made.
 *
 * @param {string} root
 * @returns {{exact: Record<string, {count: number, markers: string[]}>,
 *   informational: Record<string, {count: number, markers: string[]}>}}
 */
function benchLeakCounts(root) {
  const exact = {};
  const informational = {};
  const rows = {};
  const exactMarkers = exactLeakMarkers();
  for (const file of guardFileList(root)) {
    if (!/\.(?:jsonl?|ndjson)$/i.test(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    const relative = path.relative(root, file);
    const exactHit = tallyMarkers(text, exactMarkers);
    if (exactHit) exact[relative] = exactHit;
    const prefixHit = tallyMarkers(text, INFORMATIONAL_MARKERS);
    if (prefixHit) informational[relative] = prefixHit;
    rows[relative] = indexRows(text);
  }
  return { exact, informational, rows };
}

/**
 * Line count plus identifying metadata for the last few rows of a JSONL store.
 *
 * The tail, not the whole file: this exists so `--writers tolerate` can say WHO
 * wrote the rows that appeared during a run, and the cap on that report is
 * ROW_TAIL_LIMIT anyway. Keeping whole-file row metadata in every snapshot
 * would grow with the ledger for no gain.
 *
 * Only three fields are lifted out. `session_id` is the one that attributes a
 * row to a writer; `ts`/`timestamp` says when; `event` says what. Everything
 * else in a row is another subsystem's business and may be large.
 *
 * @param {string} text whole file contents
 * @returns {{lines: number, tail: Array<{session_id: string|null, ts: string|null, event: string|null}>}}
 */
function indexRows(text) {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const tail = lines.slice(-ROW_TAIL_LIMIT).map((line) => {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return { session_id: null, ts: null, event: null }; }
    if (!parsed || typeof parsed !== 'object') {
      return { session_id: null, ts: null, event: null };
    }
    return {
      session_id: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      ts: parsed.ts || parsed.timestamp || null,
      event: parsed.event || null,
    };
  });
  return { lines: lines.length, tail };
}

/**
 * Count how many of `markers` appear in `text`, and which.
 * @param {string} text
 * @param {string[]} markers
 * @returns {{count: number, markers: string[]}|null} null when nothing matched
 */
function tallyMarkers(text, markers) {
  const found = [];
  let count = 0;
  for (const marker of markers) {
    const hits = text.split(marker).length - 1;
    if (hits > 0) {
      count += hits;
      found.push(marker);
    }
  }
  return count > 0 ? { count, markers: found } : null;
}

/**
 * Every file a guard path covers: the tree's files when it is a directory, the
 * path itself when it is a single file. Directories and single files are both
 * legal guard targets (`--guard` takes either), so every consumer needs this
 * distinction and none of them should re-derive it.
 *
 * @param {string} target
 * @returns {string[]} absolute paths
 */
function guardFileList(target) {
  let isDir;
  try { isDir = statSync(target).isDirectory(); } catch { return []; }
  if (!isDir) return [target];
  return walkFiles(target, GUARD_FILE_LIMIT).sort();
}

/**
 * Per-file path + size listing for a guard path, carried in the report
 * alongside the digest verdict.
 *
 * The digest answers "did anything change"; it cannot answer "what". For a
 * store that a live session writes to concurrently, "what" is the whole
 * question — an empty directory gaining one ledger file is a different event
 * from an existing ledger growing by 300 bytes, and the digest renders both as
 * the same opaque hash change. So the listing ships in the JSON and the reader
 * decides.
 *
 * Sizes are the metric rather than hashes: a size is comparable at a glance
 * across the before/after pair, and content hashes are already folded into the
 * digest that sits next to it.
 *
 * @param {string} target
 * @param {number} limit maximum entries before truncation
 * @returns {Array<{path: string, size: number}>}
 */
function guardEntries(target, limit) {
  const files = guardFileList(target);
  const base = files.length === 1 && files[0] === target ? path.dirname(target) : target;
  return files.slice(0, limit).map((file) => {
    let size = -1;
    try { size = statSync(file).size; } catch { /* unreadable -> -1, still listed */ }
    return { path: path.relative(base, file), size };
  });
}

/**
 * Snapshot one guard path.
 * @param {{path: string, mode: string}} spec
 * @returns {object}
 */
function snapshotOne(spec) {
  if (!existsSync(spec.path)) {
    return { path: spec.path, mode: spec.mode, state: 'absent', leaks: null, entries: [] };
  }
  if (spec.mode === 'leak-scan') {
    return {
      path: spec.path,
      mode: spec.mode,
      state: 'scanned',
      leaks: benchLeakCounts(spec.path),
      entries: [],
    };
  }
  let isDir = false;
  try { isDir = statSync(spec.path).isDirectory(); } catch { /* treated as a file */ }
  const state = isDir ? treeDigest(spec.path) : `file:${fileDigest(spec.path)}`;
  // Scanned for EVERY mode, not just the ones that can fail on it. `observe`
  // needs it because a concurrent writer must not fail the run while a bench
  // fingerprint still must; `tree` needs it because `--writers tolerate` asks
  // the same question of a tree; `informational` needs it so the report can say
  // whether a change there was ours. The scan is a read of the jsonl files the
  // digest already opened, so making it unconditional costs a second pass over
  // text that is in page cache, and removes a mode-dependent blind spot.
  const leaks = benchLeakCounts(spec.path);
  return {
    path: spec.path,
    mode: spec.mode,
    state,
    leaks,
    entries: guardEntries(spec.path, GUARD_ENTRY_LIMIT),
  };
}

/**
 * Snapshot every guard path. Call once before the runs and once after.
 *
 * @param {Array<string|{path: string, mode?: string}>} paths
 * @returns {Promise<object[]>}
 */
export async function snapshotGuards(paths) {
  return (paths || []).map((spec) => snapshotOne(normalizeGuardSpec(spec)));
}

/**
 * Verdict for one leak-scan guard: does any file hold a value THIS run
 * generated?
 *
 * Presence, not growth — the body says the same thing at greater length. An
 * earlier revision of this function subtracted the before counts from the after
 * counts, and this comment still described that behaviour after the body had
 * moved on. Growth was the right rule while the markers included fixed literals
 * that a store could legitimately already contain; it became the wrong one once
 * every marker carried a random suffix minted by this process, because such a
 * value cannot pre-exist and a hook that wrote it just before the first
 * snapshot is the same leak as one that wrote it between the two.
 *
 * The informational counts on the side are still compared by growth. That is
 * not an inconsistency: those markers are naming patterns anyone can produce,
 * so for them "already there" and "appeared" really are different facts.
 *
 * @param {object} before
 * @param {object} after
 * @returns {{verdict: string, violation: boolean, informational: string}}
 */
function compareLeakScan(before, after) {
  const afterExact = after.leaks?.exact || {};
  const files = Object.keys(afterExact);
  const informational = summarizeInformational(before, after);

  // PRESENCE, not growth. Every exact marker carries a random suffix this
  // process minted, so a store holding one is a leak whether or not it appeared
  // during the observation window — a hook that wrote it between the two
  // snapshots and a hook that wrote it a moment before the first one are the
  // same event. Subtracting before from after, as an earlier revision did,
  // would call the second case clean.
  if (files.length > 0) {
    const detail = files
      .map((file) => `${file} [${(afterExact[file].markers || []).join(' ')}]`)
      .join(', ');
    return {
      verdict: `LEAK: values generated by this run appeared in ${detail}`,
      violation: true,
      informational,
    };
  }
  return {
    verdict: `clean (0 of ${exactLeakMarkers().length} generated values found)`,
    violation: false,
    informational,
  };
}

/**
 * Human-readable note about the prefix markers, which are counted but never
 * decide the verdict. A growth here is worth SEEING — it may be a stale
 * artifact of an earlier run, or another session quoting one of these strings —
 * and is worth nothing as evidence about this run.
 *
 * @param {object} before
 * @param {object} after
 * @returns {string}
 */
function summarizeInformational(before, after) {
  const beforeCounts = before.leaks?.informational || {};
  const afterCounts = after.leaks?.informational || {};
  const grew = Object.keys(afterCounts).filter(
    (file) => (afterCounts[file]?.count || 0) > (beforeCounts[file]?.count || 0),
  );
  const total = Object.values(afterCounts).reduce((sum, hit) => sum + hit.count, 0);
  if (grew.length === 0) return `prefix markers: ${total} occurrence(s), no growth`;
  return `prefix markers: ${total} occurrence(s), grew in ${grew.join(', ')} (not attributable to this run)`;
}

/**
 * Compare two guard snapshots.
 *
 * Four modes, four meanings:
 *   - `tree`          — byte identity required; a change is a violation.
 *   - `leak-scan`     — only a value THIS run generated is a violation (an
 *     emitted session id or a sandbox directory it created). Prefix markers
 *     are counted and reported but never decide the verdict.
 *   - `informational` — reported, never a violation. Used for
 *     `plugins/artibot/runtime/`, which is gitignored and which
 *     CLAUDE_PLUGIN_ROOT legitimately points every child at. It cannot dirty
 *     git, so failing on it would be a false alarm; hiding it would lose the
 *     signal that hooks write there.
 *   - `observe`       — digest change is RECORDED with a before/after file
 *     listing and is not a violation, but an attributable `bench-` leak still
 *     is. Reserved for a store that the live session writes to on its own
 *     schedule while the bench runs, where a digest change carries no
 *     attribution and failing on it would only teach the reader to distrust
 *     the guard. This is a narrowing of one claim, not a relaxation of the
 *     gate: byte identity was never provable there, and the property that IS
 *     provable — no bench fingerprint reached the store — stays fail-closed.
 *     The listing is what makes the recorded change actionable instead of an
 *     opaque hash delta, which is why it is required rather than optional.
 *
 * Orthogonal to all four is the WRITERS MODE, which only ever affects `tree`
 * and `observe` and only when nothing attributable was found — see
 * `tolerateVerdict()` and the module header. `strict` is the default and
 * reproduces the behaviour above exactly; the parameter is optional so an
 * existing two-argument call is unchanged.
 *
 * @param {object[]} before
 * @param {object[]} after
 * @param {{writers?: string}} [options]
 * @returns {Array<{path: string, mode: string, before: string, after: string, verdict: string, violation: boolean}>}
 */
export function compareGuards(before, after, options = {}) {
  const writers = options.writers === 'tolerate' ? 'tolerate' : 'strict';
  return (before || []).map((prev, index) => finalize(
    compareOne(prev, (after || [])[index], writers),
  ));
}

/**
 * Normalize one comparison result.
 *
 * `strictWouldFail` must be a boolean on EVERY guard so the run-level
 * aggregation is a plain `.some()` rather than a search for undefined, and any
 * violation implies it — strict fails on everything tolerate does and more.
 *
 * `skipped` follows the same rule for the same reason. It marks a guard that
 * was NOT evaluated because its target does not exist, which is a third
 * outcome and not a quiet pass: a spec naming a store that a not-yet-landed
 * change will create would otherwise read as `[ok]` forever, and the guard
 * would be falsely green on exactly the run it was added for.
 *
 * @param {object} result
 * @returns {object}
 */
function finalize(result) {
  return {
    ...result,
    strictWouldFail: Boolean(result.violation || result.strictWouldFail),
    skipped: Boolean(result.skipped),
  };
}

/**
 * Compare a single before/after guard pair.
 *
 * @param {object} prev
 * @param {object|undefined} afterEntry
 * @param {string} writers 'strict' | 'tolerate'
 * @returns {object}
 */
function compareOne(prev, afterEntry, writers) {
  const next = afterEntry
    || { state: 'missing-snapshot', mode: prev.mode, leaks: null, entries: [] };
  const shape = {
    path: prev.path,
    mode: prev.mode,
    before: prev.state,
    after: next.state,
    entries: {
      before: prev.entries || [],
      after: next.entries || [],
    },
    entriesTruncated:
      (prev.entries || []).length >= GUARD_ENTRY_LIMIT
      || (next.entries || []).length >= GUARD_ENTRY_LIMIT,
    // Size of the exact-match set the leak verdict was decided against. A
    // reader can tell "clean because nothing leaked" from "clean because the
    // set was empty and nothing could have matched".
    exactMarkerCount: exactLeakMarkers().length,
  };

  if (prev.mode === 'leak-scan') return { ...shape, ...compareLeakScan(prev, next) };

  // Every remaining mode fails on an attributable leak FIRST, before the
  // digest is consulted. A value this run generated, sitting in a guarded
  // store, is a violation in either writers mode and whatever else changed.
  const leak = compareLeakScan(prev, next);
  if (leak.violation) return { ...shape, ...leak };

  if (prev.state === 'absent' && next.state === 'absent') {
    return {
      ...shape, verdict: 'absent/absent', violation: false, skipped: true,
    };
  }
  if (prev.state === next.state) return { ...shape, verdict: 'unchanged', violation: false };
  if (prev.mode === 'informational') {
    return { ...shape, verdict: 'CHANGED (informational — gitignored runtime dir)', violation: false };
  }
  if (prev.mode === 'observe') {
    return {
      ...shape,
      verdict: 'CHANGED (observe — recorded, not a failure; compare entries)',
      violation: false,
      // `observe` never failed under strict either, so strictWouldFail stays
      // false here — but the row evidence is just as useful, so tolerate
      // attaches it rather than reserving it for the modes that changed
      // verdict.
      ...(writers === 'tolerate' ? { unattributedRows: newRowsBetween(prev, next) } : {}),
    };
  }
  if (writers === 'tolerate') return { ...shape, ...tolerateVerdict(prev, next) };
  return { ...shape, verdict: 'CHANGED', violation: true };
}

/**
 * The `tree` verdict under `--writers tolerate`.
 *
 * Reached only after the exact-marker check has already come back empty, so
 * the change in front of us is UNATTRIBUTED: something wrote to a guarded store
 * and it was demonstrably not this run. On a machine with a second Claude
 * session open that is the normal case, and failing on it makes the guard a
 * report on the operator's other window rather than on the bench.
 *
 * The verdict says `strict would FAIL` in its own text, and `strictWouldFail`
 * carries the same fact as a boolean, because a tolerated run is a WEAKER
 * result than a strict one and must not read like an equal one.
 *
 * @param {object} prev
 * @param {object} next
 * @returns {{verdict: string, violation: boolean, strictWouldFail: boolean,
 *   unattributedRows: Array<object>, informational: string}}
 */
function tolerateVerdict(prev, next) {
  return {
    verdict: `CHANGED (unattributed — 0 of ${exactLeakMarkers().length} generated values; strict would FAIL)`,
    violation: false,
    strictWouldFail: true,
    unattributedRows: newRowsBetween(prev, next),
    informational: summarizeInformational(prev, next),
  };
}

/**
 * Identify the rows that appeared in a guarded store between two snapshots.
 *
 * This is the evidence a tolerated verdict rests on: without it "something else
 * wrote here" is an assertion, and with it the reader can see whose session id
 * and which event. A row whose `session_id` is some other session's is the
 * whole argument for tolerating the change.
 *
 * Session ids are truncated to 8 characters. They are identifiers, not secrets,
 * but a full one is long enough to make the table unreadable and short enough
 * at 8 to distinguish the two or three sessions that could plausibly be running.
 *
 * @param {object} prev
 * @param {object} next
 * @returns {Array<{file: string, session_id: string|null, ts: string|null, event: string|null}>}
 */
function newRowsBetween(prev, next) {
  const beforeRows = prev.leaks?.rows || {};
  const afterRows = next.leaks?.rows || {};
  const out = [];
  for (const [file, index] of Object.entries(afterRows)) {
    if (out.length >= ROW_TAIL_LIMIT) break;
    const added = index.lines - (beforeRows[file]?.lines || 0);
    if (added <= 0) continue;
    // The tail holds at most ROW_TAIL_LIMIT rows, so a burst larger than that
    // is reported partially. Taking the LAST `added` of the tail keeps the most
    // recent, which are the ones written during the window.
    const rows = index.tail.slice(-Math.min(added, ROW_TAIL_LIMIT));
    for (const row of rows) {
      if (out.length >= ROW_TAIL_LIMIT) break;
      out.push({
        file,
        session_id: row.session_id ? row.session_id.slice(0, 8) : null,
        ts: row.ts,
        event: row.event,
      });
    }
  }
  return out;
}

/**
 * Run a read-only git command from a given directory. Empty string on failure.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function gitRead(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * The default guard set.
 *
 * Four entries, for four different blast radii:
 *   1. `<USERPROFILE>/.artibot` — the real ledger and decision store.
 *   2. `<invocation repo>/.artibot/runtime` — this checkout's runtime ledger.
 *      `observe` mode, NOT `tree`. This is the store the session running the
 *      bench writes to through its own hooks, on its own schedule: measured
 *      2026-09-11, the directory did not exist at 00:08 and held a 2,744-byte
 *      `ledger.jsonl` at 00:12, written by the live session with nothing to do
 *      with this file. A byte-identity claim there would be a claim about
 *      another process's timing, so the mode records the before/after file
 *      listing instead and keeps only the attributable check (a bench fingerprint in
 *      the ledger) fail-closed.
 *   3. `<main worktree>/.artibot/runtime` — the primary checkout's store, and
 *      a DIFFERENT directory from #2, not the same one seen from elsewhere: a
 *      linked worktree has its own. Stays `tree`, fail-closed. The bench never
 *      runs with a cwd inside it, so a change there is unexplained by
 *      construction and should stop the run.
 *   4. `<USERPROFILE>/.claude/artibot` — leak-scan only; see benchLeakCounts().
 *      Byte identity is not claimed for this store either, and specifically not
 *      for `daily-experiences.json`, which the live session appends to.
 *   5. `<git common dir>/artibot/ledger.jsonl` — a FILE, `tree`, fail-closed.
 *      Specs 1-4 all name paths outside the git dir, so a ledger relocated
 *      under the common dir would have been unguarded and `--guard` would have
 *      been falsely green on it. At the time this spec was added the file did
 *      not exist (`lib/runtime/event-writer.js#DEFAULT_LEDGER_REL` is still
 *      `.artibot/runtime/ledger.jsonl`, joined to a project root by
 *      `#ledgerFilePath`); it is listed anyway so the guard is in place on the
 *      run that first creates it. Until then it reports SKIP, not ok.
 *
 * Plus `<PLUGIN_ROOT>/runtime`, informational.
 *
 * A spec whose target is absent both before and after is SKIPPED, not passed:
 * `absent/absent`, `skipped: true`, rendered `[SKIP]`, never a strict failure.
 *
 * @returns {Array<{path: string, mode: string}>}
 */
export function defaultGuardSpecs() {
  const userProfile = process.env.USERPROFILE || os.homedir();
  const specs = [
    { path: path.join(userProfile, '.artibot'), mode: 'tree' },
    { path: path.join(userProfile, '.claude', 'artibot'), mode: 'leak-scan' },
    { path: path.join(PLUGIN_ROOT, 'runtime'), mode: 'informational' },
  ];

  const repoRoot = gitRead(['rev-parse', '--show-toplevel'], INVOCATION_CWD);
  if (repoRoot) specs.push({ path: path.join(repoRoot, '.artibot', 'runtime'), mode: 'observe' });

  const commonDir = gitRead(['rev-parse', '--path-format=absolute', '--git-common-dir'], INVOCATION_CWD);
  if (commonDir) {
    const resolvedCommonDir = path.resolve(commonDir);
    const mainRoot = path.dirname(resolvedCommonDir);
    const candidate = path.join(mainRoot, '.artibot', 'runtime');
    if (!specs.some((spec) => spec.path === candidate)) {
      specs.push({ path: candidate, mode: 'tree' });
    }
    // Every spec above names a path OUTSIDE the git dir, so a ledger that
    // lives under the common dir had no guard at all. Listed unconditionally
    // rather than behind an `existsSync`: the spec must be present on the run
    // that first creates the file, and `snapshotOne` already reports a missing
    // target as `absent` (-> SKIP), so naming it early costs one skipped row
    // and closes the window where the guard would silently not exist.
    // A file, not a directory — `snapshotOne` digests it as `file:<hash>` and
    // `guardEntries` lists a single-file target relative to its parent.
    const ledger = path.join(resolvedCommonDir, 'artibot', 'ledger.jsonl');
    if (!specs.some((spec) => spec.path === ledger)) {
      specs.push({ path: ledger, mode: 'tree' });
    }
  }

  return specs;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Machine + build context for the report envelope.
 * @returns {object}
 */
function collectEnvironment() {
  const cpuList = os.cpus() || [];
  let pluginVersion = null;
  try {
    pluginVersion = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf-8'),
    ).version;
  } catch { /* reported as null */ }

  return {
    measuredAt: new Date().toISOString(),
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    cpu: cpuList[0] ? cpuList[0].model : null,
    cores: cpuList.length,
    node: process.version,
    pluginVersion,
    headSha: gitRead(['rev-parse', 'HEAD'], PLUGIN_ROOT) || null,
    pluginRoot: PLUGIN_ROOT,
  };
}

/** @param {number|null} value @param {number} width @returns {string} */
function cell(value, width) {
  const text = value === null || value === undefined ? 'n/a' : String(value);
  return text.padStart(width);
}

/**
 * Print a guard's before/after file listing.
 *
 * Printed for `observe` always, and for any other mode only when the digest
 * moved — an unchanged tree's listing is noise, while an observe listing is
 * the substance of what that mode reports rather than a detail of it.
 *
 * @param {object} guard one entry from compareGuards()
 * @returns {void}
 */
function printGuardEntries(guard) {
  const changed = guard.before !== guard.after;
  if (guard.mode !== 'observe' && !changed) return;
  const before = guard.entries.before || [];
  const after = guard.entries.after || [];
  const format = (list) => (list.length === 0
    ? '(empty)'
    : list.map((entry) => `${entry.path} ${entry.size}B`).join(', '));
  console.log(`         before: ${format(before)}`);
  console.log(`         after:  ${format(after)}`);
  if (guard.entriesTruncated) {
    console.log(`         (listing capped at ${GUARD_ENTRY_LIMIT} entries; digest covers all files)`);
  }
}

/**
 * Print the rows that appeared in a guarded store during the run.
 *
 * Printed in the table and not only in the JSON, because the tolerated verdict
 * is the one a reader is most likely to accept without checking: "something
 * else wrote here" has to arrive with the session ids attached, or it is a
 * claim rather than a finding.
 *
 * @param {object} guard
 * @returns {void}
 */
function printUnattributedRows(guard) {
  const rows = guard.unattributedRows || [];
  if (rows.length === 0) return;
  console.log(`         rows added during the run (${rows.length}, cap ${ROW_TAIL_LIMIT}):`);
  for (const row of rows) {
    const sid = row.session_id || '(no session_id)';
    const ts = row.ts || '(no ts)';
    const event = row.event || '(no event)';
    console.log(`           ${row.file}  session=${sid}  ts=${ts}  event=${event}`);
  }
}

/**
 * Human-readable report.
 * @param {object} report
 * @returns {void}
 */
function printHuman(report) {
  const { environment: env, results, guards } = report;
  console.log('HOOK LATENCY BENCH');
  console.log('==================');
  console.log(`measured   ${env.measuredAt}`);
  console.log(`node       ${env.node} | artibot ${env.pluginVersion} | HEAD ${String(env.headSha).slice(0, 8)}`);
  console.log(`machine    ${env.os} | ${env.cores} cores | ${env.cpu}`);
  console.log(`runs       n=${report.n}, warmup=${report.warmup} (warmup excluded from stats)`);
  // The same flag means different news in the two modes. Under `tolerate` it
  // is the whole point of the line: the run passed, and a stricter check would
  // not have. Under `strict` a would-fail IS the failure, already spelled out
  // on the guard lines below, so `mode: strict | strict would FAIL` read as a
  // stutter — it is labelled as the violation it is instead.
  let writersNote = '';
  if (report.strictWouldFail) {
    writersNote = report.writersMode === 'tolerate' ? '  |  strict would FAIL' : '  |  violation';
  }
  console.log(`writers    mode: ${report.writersMode}${writersNote}`);
  console.log('');

  const header = [
    'SLOT'.padEnd(32), cell('p50', 9), cell('p95', 9), cell('max', 9), cell('min', 9),
    cell('budget', 9), cell('headroom', 10), '  children  exit',
  ].join('');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const row of results) {
    const kids = row.children
      ? `${row.children.measured === null ? '?' : row.children.measured}/${row.children.staticCount}`
      : '-';
    const exits = [...new Set(row.exitCodes)].join(',');
    console.log([
      row.slot.padEnd(32), cell(row.p50, 9), cell(row.p95, 9), cell(row.max, 9), cell(row.min, 9),
      cell(row.budgetMs, 9), cell(row.headroomMs, 10), `  ${kids.padEnd(9)} ${exits}`,
    ].join(''));
  }

  const overruns = results.filter((r) => r.headroomMs !== null && r.headroomMs < 0);
  const drifted = results.filter(
    (r) => r.children && r.children.measured !== null && r.children.measured !== r.children.staticCount,
  );
  const probeFailures = results.filter((r) => r.children && r.children.note);

  console.log('');
  console.log('GUARDS');
  console.log('------');
  for (const guard of guards) {
    // Three-way, not two: `SKIP` says the target was absent and nothing was
    // checked. Collapsing that into `ok` would let a spec for a store that
    // does not exist yet report as a passing guard.
    let label = 'ok';
    if (guard.violation) label = 'FAIL';
    else if (guard.skipped) label = 'SKIP';
    console.log(`  [${label}] ${guard.mode.padEnd(13)} ${guard.verdict}`);
    console.log(`         ${guard.path}`);
    if (guard.strictWouldFail && !guard.violation) {
      console.log('         strict would FAIL — this guard passed only under --writers tolerate');
    }
    if (guard.informational) console.log(`         ${guard.informational}`);
    printUnattributedRows(guard);
    printGuardEntries(guard);
  }

  console.log('');
  console.log('NOTES');
  console.log('-----');
  console.log(`  budget overruns (p95 > declared): ${overruns.length === 0 ? 'none' : overruns.map((r) => r.slot).join(', ')}`);
  console.log(`  child-count drift vs dispatch-table: ${drifted.length === 0 ? 'none' : drifted.map((r) => `${r.slot} (${r.children.measured} vs ${r.children.staticCount})`).join(', ')}`);
  const withGrandchildren = results.filter((r) => r.children && r.children.grandchildren > 0);
  console.log(`  probe reached grandchildren (dispatcher -> hook children) in ${withGrandchildren.length} slot(s): ${withGrandchildren.map((r) => `${r.slot}=${r.children.grandchildren}`).join(', ') || 'none'}`);
  for (const row of probeFailures) console.log(`  probe unmeasured: ${row.slot} — ${row.children.note}`);
  const leftovers = report.sandboxLeftovers || [];
  console.log(`  sandbox dirs not removed: ${leftovers.length === 0 ? 'none' : leftovers.join(', ')}`);
  console.log('  not covered by this tool: host IPC latency, real payload size, concurrent sessions,');
  console.log('  network hooks (swarm-sync / http-notify are DISABLED here), and git-autopilot working paths');
  console.log('  (the sandbox repo has no remote, so those hooks return at their allowlist gate).');
  console.log('  a guard FAIL can also mean a CONCURRENT session wrote to that store — the guards are');
  console.log('  fail-closed, so investigate the writer before doubting the run.');
}

/**
 * Usage text.
 * @returns {void}
 */
function printUsage() {
  console.log(`Usage: node scripts/bench/hook-latency.mjs [options]

  --slot <name|all>   slot to measure (default: all)
  --n <count>         measured runs per slot (default: 20)
  --warmup <count>    warmup runs per slot, excluded from stats (default: 2)
  --json              emit one JSON object on stdout instead of a table
  --guard <path>      extra path to byte-compare before/after (repeatable)
  --writers <mode>    strict (default) | tolerate
                      strict:   any change to a guarded store is exit 2. Only
                                reachable on an otherwise-idle machine, and the
                                strongest evidence available.
                      tolerate: a change with none of this run's generated
                                values in it is reported, not failed, with the
                                rows that appeared. A value this run generated
                                is still exit 2 in either mode.
  --no-probe          skip the child-counting probe run
  --help              this text

Exit codes: 0 ok, 1 error, 2 guard violation.

Slots:
  ${Object.keys(SLOTS).join('\n  ')}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse argv. Throws on anything unrecognized rather than silently ignoring it —
 * a typo'd flag that is quietly dropped produces a number measured under
 * different conditions than the operator believes.
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const opts = {
    slot: 'all', n: 20, warmup: 2, json: false, guards: [], probe: true, help: false,
    writers: 'strict',
  };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--slot') { opts.slot = next; index += 2; continue; }
    if (arg === '--n') { opts.n = Number(next); index += 2; continue; }
    if (arg === '--warmup') { opts.warmup = Number(next); index += 2; continue; }
    if (arg === '--guard') { opts.guards.push(next); index += 2; continue; }
    if (arg === '--writers') { opts.writers = next; index += 2; continue; }
    if (arg === '--json') { opts.json = true; index += 1; continue; }
    if (arg === '--no-probe') { opts.probe = false; index += 1; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; index += 1; continue; }
    throw new Error(`unrecognized argument "${arg}" (try --help)`);
  }
  if (!Number.isFinite(opts.n) || opts.n < 1) throw new Error('--n must be a positive integer');
  if (!Number.isFinite(opts.warmup) || opts.warmup < 0) throw new Error('--warmup must be >= 0');
  if (!opts.slot) throw new Error('--slot requires a value');
  if (!WRITERS_MODES.includes(opts.writers)) {
    throw new Error(`--writers must be one of ${WRITERS_MODES.join('|')} (got "${opts.writers}")`);
  }
  return opts;
}

/**
 * Measure every requested slot, each in its own fresh sandbox.
 *
 * A fresh sandbox per slot rather than one shared sandbox: sharing would let
 * SessionStart's writes into the sandbox home change what Stop and SessionEnd
 * then find, so a slot's number would depend on which slots ran before it.
 *
 * @param {string[]} slotNames
 * @param {object} opts
 * @returns {Promise<object[]>}
 */
async function measureSlots(slotNames, opts, leftovers) {
  const results = [];
  for (const slotName of slotNames) {
    const sandbox = createSandbox();
    try {
      results.push(await benchSlot(slotName, {
        n: opts.n, warmup: opts.warmup, sandbox, probe: opts.probe,
      }));
    } finally {
      leftovers.push(...(sandbox.cleanup() || []));
    }
  }
  return results;
}

/**
 * Entry point.
 * @returns {Promise<number>} process exit code
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printUsage();
    return 0;
  }

  const slotNames = opts.slot === 'all' ? Object.keys(SLOTS) : [opts.slot];
  for (const name of slotNames) requireSlot(name);

  const guardSpecs = [
    ...defaultGuardSpecs(),
    ...opts.guards.map((p) => ({ path: path.resolve(INVOCATION_CWD, p), mode: 'tree' })),
  ];

  const before = await snapshotGuards(guardSpecs);
  const sandboxLeftovers = [];
  const results = await measureSlots(slotNames, opts, sandboxLeftovers);
  const after = await snapshotGuards(guardSpecs);
  const guards = compareGuards(before, after, { writers: opts.writers });
  const violated = guards.some((guard) => guard.violation);

  const report = {
    tool: 'hook-latency',
    environment: collectEnvironment(),
    n: opts.n,
    warmup: opts.warmup,
    writersMode: opts.writers,
    // True when at least one before/after pair WOULD fail under strict — which
    // covers two different runs: any actual violation, and a change that
    // `tolerate` downgraded to a pass.
    //
    // Not "passed only because of tolerate", which was the earlier wording and
    // is false on a strict run that failed: there the flag is true and nothing
    // passed at all. The flag answers "would the strongest available check have
    // failed here", so a clean tolerate run carrying it is a weaker result than
    // one without, and a failing strict run carrying it is simply consistent.
    strictWouldFail: guards.some((guard) => guard.strictWouldFail),
    declaredBudgetsMs: DECLARED_BUDGETS,
    results,
    guards,
    guardViolation: violated,
    sandboxLeftovers,
  };

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);

  return violated ? 2 : 0;
}

if (isMainEntry(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`[hook-latency] ${err.message}`);
      process.exitCode = 1;
    });
}
