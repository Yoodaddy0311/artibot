/**
 * session-start.js#appendKillSwitchStatus — the SessionStart kill-switch banner
 * says only what the production gate actually does (2026-11-22).
 *
 * The production gate (lib/learning/self-control-gates.js#resolveSelfControlGates)
 * stops a feature on `ago.selfControl.masterEnabled === false` and on the
 * PER-FEATURE state; it never reads the emergency state file. Lane D measured
 * (copy): with the emergency file unreadable, the banner said self-control was
 * "safely paused" while the gate answered `proceed: true`. And a trip whose
 * master-switch write failed (kill-switch.js#recordEmergencyFailure retries it on
 * the next failure) was announced as a pause that had not happened either.
 *
 * The rule pinned below holds IN THE SIX SCENARIOS TESTED (unreadable × master on/off,
 * tripped × master off / retry pending / no retry, nothing tripped): the banner claims a
 * pause ('일시 중지') exactly when the real gate stops the feature. The gate runs for real
 * against the same config object — the real kill-switch module, the per-feature state in a
 * temp dir — with only the first-run guard stubbed (it would otherwise put the feature in
 * observe mode, which is not what this checks).
 *
 * NOT covered, and false today (lane B 2026-11-22): a trip whose cooldown EXPIRED leaves
 * `masterEnabled: false` behind (it is never restored automatically), so the gate keeps
 * stopping while the banner — which reports tripped states only — says nothing. Making the
 * banner report that state is backlog. Nor is a feature that tripped on its own (per-feature
 * state) reported here; the pause line's recovery advice covers it below.
 *
 * Real files only: the unreadable case is a DIRECTORY at the state path (EISDIR).
 * Every path is in a temp dir; the module is imported from the real plugin root.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendKillSwitchStatus } from '../../scripts/hooks/session-start.js';
import {
  describeKillSwitchStatus, getKillSwitchState, killSwitchBannerLines, recordFailure,
} from '../../lib/learning/kill-switch.js';
import { featureBannerLine } from '../../lib/learning/kill-switch-banner.js';
import { resolveSelfControlGates } from '../../lib/learning/self-control-gates.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAUSE = '일시 중지';
const RETRY = '다음 실패';
const FEATURE_LINE = '[artibot:kill-switch-feature';

let tmpDir;
let statePath;
let featurePath;
let stderr;

/** @param {{ masterEnabled?: boolean }} [opts] */
const config = ({ masterEnabled } = {}) => ({
  ago: {
    selfControl: {
      ...(masterEnabled === undefined ? {} : { masterEnabled }),
      killSwitch: { statePath: featurePath },
      emergencyKillSwitch: { enabled: true, maxFailuresPerHour: 3, cooldownHours: 24, statePath },
    },
  },
});

/**
 * Does the banner say `feature` is stopped? A pause line that is not a per-feature line
 * covers every feature; a per-feature line covers the features it names.
 */
function claimsStop(lines, feature) {
  return lines.some((l) => {
    if (!l.includes(PAUSE)) return false;
    if (!l.startsWith(FEATURE_LINE)) return true;
    const names = (l.match(/기능: (.+?)\. 다시 열려면/)?.[1] ?? '').split(', ');
    return names.includes(feature);
  });
}

/** The banner lines and the real gate's answer for the same config. */
async function bannerAndGate(cfg, feature = 'auto-commit') {
  const lines = [];
  await appendKillSwitchStatus(PLUGIN_ROOT, cfg, lines);
  const gate = await resolveSelfControlGates(feature, cfg, {
    pluginRoot: tmpDir,
    firstRunGuard: { shouldObserveOnly: async () => ({ shouldObserve: false }), bumpRunCounter: async () => {} },
  });
  return { lines, gate, claimsPause: claimsStop(lines, feature) };
}

/** A tripped emergency state; `extra` adds e.g. `masterDisabled`. */
function writeTripped(extra = {}) {
  const now = Date.now();
  writeFileSync(statePath, JSON.stringify({
    failures: [0, 1, 2].map((i) => ({ feature: `f${i}`, error: null, timestamp: new Date(now - i * 1000).toISOString() })),
    tripped: true,
    trippedAt: new Date(now).toISOString(),
    cooldownUntil: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    ...extra,
  }));
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'artibot-ss-ks-banner-'));
  statePath = path.join(tmpDir, 'runtime', 'kill-switch-state.json');
  featurePath = path.join(tmpDir, 'runtime', 'kill-switch.json');
  mkdirSync(path.dirname(statePath), { recursive: true });
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderr.mockRestore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('appendKillSwitchStatus — claims a pause only when the gate stops', () => {
  it('unreadable state file: says the state cannot be checked, names the file, claims no pause', async () => {
    mkdirSync(statePath); // a directory where the file should be: EISDIR

    const { lines, gate, claimsPause } = await bannerAndGate(config({ masterEnabled: true }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('상태를 확인할 수 없습니다');
    expect(lines[0]).toContain(statePath);
    expect(gate.proceed).toBe(true);
    expect(claimsPause).toBe(!gate.proceed);
  });

  it('unreadable state file with the master switch off: cannot check, but the pause is real and said', async () => {
    mkdirSync(statePath);

    const { lines, gate, claimsPause } = await bannerAndGate(config({ masterEnabled: false }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('상태를 확인할 수 없습니다');
    expect(gate.proceed).toBe(false);
    expect(claimsPause).toBe(!gate.proceed);
  });

  it('tripped with the master switch off: the pause wording, and the gate does stop', async () => {
    writeTripped({ masterDisabled: true });

    const { lines, gate, claimsPause } = await bannerAndGate(config({ masterEnabled: false }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('연속 실패');
    expect(gate.proceed).toBe(false);
    expect(claimsPause).toBe(!gate.proceed);
  });

  it('tripped, but the master-switch write failed: says so and that the next failure retries it', async () => {
    writeTripped({ masterDisabled: false });

    const { lines, gate, claimsPause } = await bannerAndGate(config({ masterEnabled: true }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('연속 실패');
    expect(lines[0]).toContain(RETRY);
    expect(gate.proceed).toBe(true);
    expect(claimsPause).toBe(!gate.proceed);
  });

  it('tripped with the master switch on and no retry pending: no pause, no retry promise', async () => {
    writeTripped(); // no masterDisabled: written before the field existed, never retried

    const { lines, gate, claimsPause } = await bannerAndGate(config({ masterEnabled: true }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(RETRY);
    expect(gate.proceed).toBe(true);
    expect(claimsPause).toBe(!gate.proceed);
  });

  it('no state file: no banner line, and the gate does not stop', async () => {
    const { lines, gate } = await bannerAndGate(config({ masterEnabled: true }));
    expect(lines).toEqual([]);
    expect(gate.proceed).toBe(true);
  });
});

// Until 2026-11-22 the pause banner said "/artibot:reset-kill-switch로 재활성하세요" — no
// such command exists (commands/ has none, and nothing outside kill-switch.js calls
// resetKillSwitch). The banner now gives the recovery that does exist, and these two
// tests keep it that way: every command it names must exist, and doing what it says
// must actually reopen the real gate.
describe('describeKillSwitchStatus — its recovery advice is real', () => {
  const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');

  /** One line per branch of the banner (emergency and per-feature) that produces a line. */
  function everyBannerLine() {
    const tripped = { tripped: true, failuresPast1h: 3, cooldownUntil: null };
    const unreadable = { tripped: true, failuresPast1h: null, cooldownUntil: null, statePath: '/x/kill-switch-state.json' };
    const on = { ago: { selfControl: { masterEnabled: true } } };
    const off = { ago: { selfControl: { masterEnabled: false } } };
    const opts = { pluginRoot: tmpDir };
    return [
      describeKillSwitchStatus(unreadable, on, opts),
      describeKillSwitchStatus(unreadable, off, opts),
      describeKillSwitchStatus(tripped, off, opts),
      describeKillSwitchStatus({ ...tripped, masterRetryPending: true }, on, opts),
      describeKillSwitchStatus(tripped, on, opts),
      featureBannerLine({ names: ['auto-commit'], readError: null, statePath: '/x/kill-switch.json' }),
      featureBannerLine({ names: [], readError: new Error('EBUSY'), statePath: '/x/kill-switch.json' }),
    ];
  }

  it('names no slash command that does not exist (and covers every branch)', () => {
    const lines = everyBannerLine();
    expect(new Set(lines).size).toBe(7); // seven distinct branches, none null
    const named = lines.flatMap((l) => [...l.matchAll(/\/artibot:([a-z0-9-]+)/g)].map((m) => m[1]));
    const missing = named.filter((name) => !existsSync(path.join(COMMANDS_DIR, `${name}.md`)));
    expect(missing).toEqual([]);
  });

  /** Trip the emergency switch for real under `tmpDir` with three failures of `features`. */
  async function tripFor(features) {
    writeFileSync(path.join(tmpDir, 'artibot.config.json'), JSON.stringify({ ago: { selfControl: { masterEnabled: true } } }));
    const cfg = { ago: { selfControl: { emergencyKillSwitch: { enabled: true, maxFailuresPerHour: 3 } } } };
    for (const feature of features) await recordFailure({ feature }, cfg, { pluginRoot: tmpDir });
  }

  /** The config the runners load (`<pluginRoot>/artibot.config.json`), emergency switch on. */
  function loadedConfig() {
    const cfg = JSON.parse(readFileSync(path.join(tmpDir, 'artibot.config.json'), 'utf-8'));
    cfg.ago.selfControl.emergencyKillSwitch = { enabled: true, maxFailuresPerHour: 3 };
    return cfg;
  }

  const gate = (cfg) => resolveSelfControlGates('auto-commit', cfg, {
    pluginRoot: tmpDir,
    firstRunGuard: { shouldObserveOnly: async () => ({ shouldObserve: false }), bumpRunCounter: async () => {} },
  });

  async function pauseBanner() {
    const cfg = loadedConfig();
    return describeKillSwitchStatus(await getKillSwitchState(cfg, { pluginRoot: tmpDir }), cfg, { pluginRoot: tmpDir });
  }

  const setMaster = (on) => {
    const file = path.join(tmpDir, 'artibot.config.json');
    const cfg = JSON.parse(readFileSync(file, 'utf-8'));
    cfg.ago.selfControl.masterEnabled = on;
    writeFileSync(file, JSON.stringify(cfg));
  };

  it('failures spread over features: setting masterEnabled back to true, as the banner says, reopens the gate', async () => {
    await tripFor(['f1', 'f2', 'f3']);
    expect((await gate(loadedConfig())).proceed).toBe(false);
    const line = await pauseBanner();
    expect(line).toContain(PAUSE);
    expect(line).toContain(path.join(tmpDir, 'artibot.config.json'));
    expect(line).toContain('ago.selfControl.masterEnabled');

    setMaster(true);

    expect((await gate(loadedConfig())).proceed).toBe(true);
  });

  it('a feature that tripped on its own also needs its entry removed, as the banner says, to reopen', async () => {
    await tripFor(['auto-commit', 'auto-commit', 'auto-commit']);
    const v1Path = path.join(tmpDir, 'runtime', 'kill-switch.json');
    const line = await pauseBanner();
    expect(line).toContain(v1Path);

    setMaster(true);
    expect((await gate(loadedConfig())).proceed).toBe(false); // master alone is not enough

    const v1 = JSON.parse(readFileSync(v1Path, 'utf-8'));
    delete v1.features['auto-commit'];
    writeFileSync(v1Path, JSON.stringify(v1));

    expect((await gate(loadedConfig())).proceed).toBe(true);
  });
});

// Lane B 2026-11-22. Probe F: three auto-commit failures two hours apart never reach the
// emergency threshold (3 per hour) but do reach the per-feature one (3 per 24h). That
// feature's gate then stays closed for good — `trippedAt` never expires and nothing
// resets it — and the banner said nothing. The banner now names such features.
describe('appendKillSwitchStatus — a feature that tripped on its own is named', () => {
  const H = 60 * 60 * 1000;

  it('probe F: per-feature trip only — the banner names the feature, and only that feature\'s gate is closed', async () => {
    const cfg = config({ masterEnabled: true });
    const now = Date.now();
    for (const t of [now - 4 * H, now - 2 * H, now]) await recordFailure({ feature: 'auto-commit' }, cfg, { pluginRoot: tmpDir, now: t });
    // A second feature ON FILE but below its threshold (1 of 3): no trippedAt, gate open. Without it the
    // file held only the tripped feature, so "every entry" and "tripped entries" were the same set and a
    // banner listing every entry passed (lane B mutant `namesAll`, 2026-11-22).
    await recordFailure({ feature: 'auto-pr' }, cfg, { pluginRoot: tmpDir, now: now - 3 * H });
    expect((await getKillSwitchState(cfg, { pluginRoot: tmpDir })).tripped).toBe(false);
    expect(JSON.parse(readFileSync(featurePath, 'utf-8')).features['auto-pr']).toMatchObject({ trippedAt: null });

    const tripped = await bannerAndGate(cfg, 'auto-commit');
    const below = await bannerAndGate(cfg, 'auto-pr');
    const other = await bannerAndGate(cfg, 'other-feature');

    expect(tripped.gate.proceed).toBe(false);
    expect(tripped.claimsPause).toBe(!tripped.gate.proceed);
    expect(below.gate.proceed).toBe(true);
    expect(below.claimsPause).toBe(!below.gate.proceed);
    expect(other.gate.proceed).toBe(true);
    expect(other.claimsPause).toBe(!other.gate.proceed);
    expect(tripped.lines).toHaveLength(1);
    expect(tripped.lines[0].match(/기능: (.+?)\. 다시 열려면/)?.[1].split(', ')).toEqual(['auto-commit']);
    expect(tripped.lines[0]).not.toContain('auto-pr');
    expect(tripped.lines[0]).toContain(`\`${featurePath}\`에서`);
  });

  it('per-feature state unreadable: every feature gate fails closed, and the banner says so', async () => {
    mkdirSync(featurePath); // EISDIR

    const { lines, gate, claimsPause } = await bannerAndGate(config({ masterEnabled: true }));

    expect(gate.proceed).toBe(false);
    expect(claimsPause).toBe(!gate.proceed);
    expect(lines.join('\n')).toContain(`\`${featurePath}\``);
  });
});

// Lane B LOW #4: a Korean particle glued to an absolute path blurs where the path ends.
// Paths are wrapped in backticks; checked with a plugin root holding Hangul and a space.
describe('banner paths are wrapped in backticks', () => {
  it('keeps the path boundary clear under a Hangul + space plugin root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'artibot-배너 경로-'));
    try {
      const cfg = { ago: { selfControl: { masterEnabled: false, emergencyKillSwitch: { enabled: true } } } };
      const state = { tripped: true, failuresPast1h: 3, cooldownUntil: null };
      const configFile = path.join(root, 'artibot.config.json');
      const featureFile = path.join(root, 'runtime', 'kill-switch.json');

      const pauseLine = describeKillSwitchStatus(state, cfg, { pluginRoot: root });
      expect(pauseLine).toContain(`\`${configFile}\`의`);
      expect(pauseLine).toContain(`\`${featureFile}\`에서`);

      mkdirSync(path.dirname(featureFile), { recursive: true });
      writeFileSync(featureFile, JSON.stringify({ features: { 'auto-commit': { failures: [], trippedAt: '2026-11-22T00:00:00.000Z' } } }));
      const lines = await killSwitchBannerLines(cfg, { pluginRoot: root });
      expect(lines.find((l) => l.startsWith(FEATURE_LINE))).toContain(`\`${featureFile}\`에서`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
