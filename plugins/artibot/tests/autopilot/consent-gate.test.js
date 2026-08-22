/**
 * ADR-004 autopilot consent gate.
 *
 * Two layers are covered here and they are not interchangeable:
 *   1. the resolver's policy matrix (pure, config injected), and
 *   2. the engine wiring, asserted on the FILESYSTEM — "returned blocked" is a
 *      weaker claim than "left nothing behind", and only the second one is what
 *      a kill-switch promises. Every negative FS assertion is preceded by a
 *      positive control proving the same fixture DOES create those files when
 *      the gate is open; without it a typo'd temp path would make the negative
 *      pass vacuously.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  buildBlockedResult,
  buildConsentReceipt,
  loadAutopilotConfig,
  OPERATION_GATES,
  resolveAutopilotConsent,
} from '../../lib/autopilot/consent-gate.js';

// ---------------------------------------------------------------------------
// 1. Resolver policy matrix (pure — config injected, no disk)
// ---------------------------------------------------------------------------

const OPEN = { suggest: { enabled: true }, execution: { enabled: true } };
const CLOSED = { suggest: { enabled: false }, execution: { enabled: false } };
const LEGACY_OFF = { enabled: false };
const EMPTY = {};

/** @param {object} config @param {string} operation @param {object} [extra] */
function ask(config, operation, extra = {}) {
  return resolveAutopilotConsent({ config, operation, warn: () => {}, ...extra });
}

describe('consent-gate / operation policy matrix', () => {
  // 5작전 × 게이트 상태. `always` 작전은 어떤 상태에서도 허용된다.
  const MATRIX = [
    // operation, config,     allowed
    ['start', OPEN, true],
    ['start', CLOSED, false],
    ['start', LEGACY_OFF, false],
    ['start', EMPTY, true],
    ['queue', OPEN, true],
    ['queue', CLOSED, false],
    ['queue', LEGACY_OFF, false],
    ['queue', EMPTY, true],
    ['resume', OPEN, true],
    ['resume', CLOSED, false],
    ['resume', LEGACY_OFF, false],
    ['resume', EMPTY, true],
    ['status', OPEN, true],
    ['status', CLOSED, true],
    ['status', LEGACY_OFF, true],
    ['abort', OPEN, true],
    ['abort', CLOSED, true],
    ['abort', LEGACY_OFF, true],
  ];

  it.each(MATRIX)('%s under %o → allowed=%s', (operation, config, allowed) => {
    expect(ask(config, operation).allowed).toBe(allowed);
  });

  it('keeps abort/status reachable precisely when execution is dead', () => {
    // 꺼진 오토파일럿을 멈출 수 없으면 그건 kill-switch 가 아니라 데드락이다.
    expect(ask(CLOSED, 'start').allowed).toBe(false);
    for (const op of ['status', 'list', 'abort', 'tail', 'replay', 'diff']) {
      expect(ask(CLOSED, op)).toMatchObject({ allowed: true, gate: 'always' });
    }
  });

  it('fails closed on an unknown operation instead of defaulting to allow', () => {
    const r = ask(OPEN, 'staart');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('unknown-operation:staart');
    expect(r.source).toBe('fail-closed');
  });

  it('fails closed on a missing operation', () => {
    expect(resolveAutopilotConsent({ config: OPEN, warn: () => {} }).allowed).toBe(false);
  });

  it('every operation in the table resolves to a known gate', () => {
    for (const [op, gate] of Object.entries(OPERATION_GATES)) {
      expect(['suggest', 'execution', 'always']).toContain(gate);
      expect(ask(OPEN, op).gate).toBe(gate);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Legacy mapping + precedence
// ---------------------------------------------------------------------------

describe('consent-gate / legacy autopilot.enabled mapping', () => {
  it('maps legacy false to BOTH gates, not suggest alone (ADR-004 plan-critic C3)', () => {
    expect(ask(LEGACY_OFF, 'suggest')).toMatchObject({ allowed: false, legacyMapped: true });
    expect(ask(LEGACY_OFF, 'start')).toMatchObject({ allowed: false, legacyMapped: true });
  });

  it('emits a stderr WARN naming both gates when the legacy mapping fires', () => {
    const warn = vi.fn();
    const r = resolveAutopilotConsent({ config: LEGACY_OFF, operation: 'start', warn });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).toContain('autopilot.suggest.enabled:false');
    expect(msg).toContain('autopilot.execution.enabled:false');
    expect(r.warning).toBe(msg);
  });

  it('does NOT warn when the gate was set explicitly (no ambiguity to report)', () => {
    const warn = vi.fn();
    resolveAutopilotConsent({ config: CLOSED, operation: 'start', warn });
    resolveAutopilotConsent({ config: OPEN, operation: 'start', warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('explicit gate wins over the legacy key — both directions', () => {
    // 이 리포의 출하 형태: 제안은 끄고 실행은 켠다. 레거시 false 가 함께 있어도
    // execution 은 살아 있어야 한다 — 아니면 ADR-004 이 막으려던 자기 DoS 다.
    const shipped = { enabled: false, suggest: { enabled: false }, execution: { enabled: true } };
    expect(ask(shipped, 'start')).toMatchObject({ allowed: true, source: 'explicit' });
    expect(ask(shipped, 'suggest')).toMatchObject({ allowed: false, source: 'explicit' });

    const inverted = { enabled: true, execution: { enabled: false } };
    expect(ask(inverted, 'start')).toMatchObject({ allowed: false, source: 'explicit' });
  });

  it('defaults to enabled when neither the pair nor the legacy key is present', () => {
    expect(ask(EMPTY, 'start')).toMatchObject({ allowed: true, source: 'default' });
    // null config is normalised to {} rather than crashing or failing closed.
    expect(ask(null, 'suggest')).toMatchObject({ allowed: true, source: 'default' });
  });

  it('ignores non-boolean gate values and falls through to the legacy/default rung', () => {
    expect(ask({ execution: { enabled: 'false' } }, 'start')).toMatchObject({ source: 'default' });
    expect(ask({ enabled: false, execution: { enabled: 'true' } }, 'start'))
      .toMatchObject({ allowed: false, source: 'legacy' });
  });
});

// ---------------------------------------------------------------------------
// 3. Override — call argument only (negative control)
// ---------------------------------------------------------------------------

describe('consent-gate / override is a call argument only', () => {
  it('reopens a closed gate and issues a consent receipt', () => {
    const r = ask(CLOSED, 'start', { override: true });
    expect(r.allowed).toBe(true);
    expect(r.source).toBe('override');
    expect(r.receipt).toMatchObject({ overridden: true, operation: 'start', gate: 'execution' });
    expect(Date.parse(r.receipt.at)).not.toBeNaN();
  });

  it('issues NO receipt when the gate was open anyway', () => {
    expect(ask(OPEN, 'start', { override: true }).receipt).toBeNull();
  });

  // NEGATIVE CONTROL — config/env 로 심은 override 는 무효여야 한다.
  it('ignores an override planted in config', () => {
    for (const planted of [
      { ...CLOSED, override: true },
      { ...CLOSED, consentOverride: true },
      { ...CLOSED, execution: { enabled: false, override: true } },
    ]) {
      expect(ask(planted, 'start').allowed).toBe(false);
    }
  });

  it('ignores an override planted in the environment', () => {
    const KEYS = ['ARTIBOT_AUTOPILOT_OVERRIDE', 'AUTOPILOT_OVERRIDE', 'ARTIBOT_CONSENT_OVERRIDE'];
    const saved = KEYS.map((k) => [k, process.env[k]]);
    try {
      for (const k of KEYS) process.env[k] = '1';
      expect(ask(CLOSED, 'start').allowed).toBe(false);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('only a strict true overrides — truthy values do not', () => {
    for (const v of [1, 'true', 'yes', {}]) {
      expect(ask(CLOSED, 'start', { override: v }).allowed).toBe(false);
    }
  });
});

describe('consent-gate / result shaping', () => {
  it('buildBlockedResult is loud, not a silent no-op', () => {
    const consent = ask(CLOSED, 'start');
    const blocked = buildBlockedResult(consent, null);
    expect(blocked).toMatchObject({ blocked: true, phase: 'BLOCKED' });
    expect(blocked.instruction.type).toBe('pause');
    expect(blocked.reason).toBeTruthy();
    expect(blocked.instruction.remedy).toContain('autopilot.execution.enabled');
  });

  it('buildConsentReceipt is additive-only (no schema version field)', () => {
    const receipt = buildConsentReceipt({ operation: 'start', gate: 'execution', source: 'legacy' });
    expect(Object.keys(receipt).sort())
      .toEqual(['at', 'configSource', 'gate', 'operation', 'overridden']);
    expect(receipt).not.toHaveProperty('schemaVersion');
    expect(receipt).not.toHaveProperty('version');
  });
});

// ---------------------------------------------------------------------------
// 4. Engine wiring — filesystem side-effect assertions
// ---------------------------------------------------------------------------

let ROOT = '';
let ARTIFACTS = '';

/** Write the plugin-root config the resolver + session store will read. */
function writeConfig(autopilot) {
  writeFileSync(
    path.join(ROOT, 'artibot.config.json'),
    JSON.stringify({ autopilot }, null, 2),
    'utf-8',
  );
}

/** Every file created anywhere under the faked plugin root. */
function artifactsUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'artibot.config.json') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...artifactsUnder(p));
    else out.push(p);
  }
  return out;
}

vi.mock('../../lib/core/platform.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getPluginRoot: () => process.env.__CONSENT_TEST_ROOT };
});

const { startAutopilot } = await import('../../lib/autopilot/engine.js');

beforeAll(() => {
  ROOT = mkdtempSync(path.join(os.tmpdir(), 'artibot-consent-root-'));
  ARTIFACTS = mkdtempSync(path.join(os.tmpdir(), 'artibot-consent-art-'));
  mkdirSync(path.join(ROOT, 'runtime'), { recursive: true });
  process.env.__CONSENT_TEST_ROOT = ROOT;
});

afterAll(() => {
  delete process.env.__CONSENT_TEST_ROOT;
  for (const d of [ROOT, ARTIFACTS]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

beforeEach(() => {
  for (const e of readdirSync(ROOT)) {
    if (e === 'artibot.config.json') continue;
    rmSync(path.join(ROOT, e), { recursive: true, force: true });
  }
});

afterEach(() => { vi.restoreAllMocks(); });

describe('engine wiring / execution gate leaves zero side effects', () => {
  const task = 'consent gate fixture task';

  // POSITIVE CONTROL FIRST — 게이트가 열린 경로에서 세션/락 파일이 실제로 생기는지
  // 먼저 증명한다. 이게 없으면 아래 음성 단언은 "경로를 잘못 봤다"와 구별되지 않는다.
  it('positive control: an open gate really does create session artifacts', async () => {
    writeConfig({ execution: { enabled: true } });
    expect(artifactsUnder(ROOT)).toHaveLength(0);

    const res = await startAutopilot({ task, options: { projectRoot: ARTIFACTS } });
    expect(res.blocked).toBeUndefined();
    expect(res.sessionId).toBeTruthy();

    const created = artifactsUnder(ROOT);
    expect(created.length).toBeGreaterThan(0);
    expect(created.some((p) => p.includes(res.sessionId))).toBe(true);
  });

  it('legacy autopilot.enabled:false creates NO session and NO lock', async () => {
    writeConfig({ enabled: false });
    expect(artifactsUnder(ROOT)).toHaveLength(0);

    const res = await startAutopilot({ task, options: { projectRoot: ARTIFACTS } });

    expect(res.blocked).toBe(true);
    expect(res.phase).toBe('BLOCKED');
    expect(res.instruction.type).toBe('pause');
    expect(res.sessionId).toBeNull();
    // 파일시스템 단언 — 반환값이 아니라 디스크가 진실원이다.
    expect(artifactsUnder(ROOT)).toEqual([]);
  });

  it('explicit execution.enabled:false blocks the same way', async () => {
    writeConfig({ execution: { enabled: false } });
    const res = await startAutopilot({ task, options: { projectRoot: ARTIFACTS } });
    expect(res.blocked).toBe(true);
    expect(artifactsUnder(ROOT)).toEqual([]);
  });

  it('a config-planted override does not unblock start (negative control)', async () => {
    writeConfig({ execution: { enabled: false }, override: true, consentOverride: true });
    const res = await startAutopilot({ task, options: { projectRoot: ARTIFACTS } });
    expect(res.blocked).toBe(true);
    expect(artifactsUnder(ROOT)).toEqual([]);
  });

  it('the call-argument override unblocks and stamps a receipt on the session', async () => {
    writeConfig({ execution: { enabled: false } });
    const res = await startAutopilot({
      task, options: { projectRoot: ARTIFACTS }, consentOverride: true,
    });
    expect(res.blocked).toBeUndefined();
    expect(res.sessionId).toBeTruthy();
    expect(artifactsUnder(ROOT).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 손상 config — 게이트가 열리는 것 자체는 의도된 설계지만, 조용히 열리면
  // kill-switch 를 켜둔 사용자가 그 사실을 알 길이 없다.
  // -------------------------------------------------------------------------

  it('a malformed config opens the gate but SAYS SO on the warn channel', () => {
    writeFileSync(path.join(ROOT, 'artibot.config.json'), '{ "autopilot": { ', 'utf-8');
    const warn = vi.fn();

    // config 인자를 생략해야 디스크 로더 경로를 탄다.
    const r = resolveAutopilotConsent({ operation: 'start', warn });

    expect(r.allowed).toBe(true);
    expect(r.source).toBe('default');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).toContain('artibot.config.json');
    expect(msg).toContain('OPEN');
    // 사용자가 취해야 할 행동이 문장에 있어야 한다 — 진단만 있는 경고는 소음이다.
    expect(msg).toMatch(/kill-switch is not in effect/);
  });

  it('loadAutopilotConfig returns {} and warns on malformed JSON', () => {
    writeFileSync(path.join(ROOT, 'artibot.config.json'), 'not json at all', 'utf-8');
    const warn = vi.fn();
    expect(loadAutopilotConfig(warn)).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // NEGATIVE CONTROL — 파일 부재는 손상이 아니다. 여기서 경고하면 설정 파일이
  // 없는 리포마다 매 호출 소음이 나고, 정작 중요한 경고가 묻힌다.
  it('is silent when the config file is simply absent', () => {
    rmSync(path.join(ROOT, 'artibot.config.json'), { force: true });
    const warn = vi.fn();
    expect(loadAutopilotConfig(warn)).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    expect(resolveAutopilotConsent({ operation: 'start', warn }).allowed).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the shipped split (suggest off, execution on) still starts', async () => {
    writeConfig({ enabled: false, suggest: { enabled: false }, execution: { enabled: true } });
    const res = await startAutopilot({ task, options: { projectRoot: ARTIFACTS } });
    expect(res.blocked).toBeUndefined();
    expect(res.sessionId).toBeTruthy();
  });
});
