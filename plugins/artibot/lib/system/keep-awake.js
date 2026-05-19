/**
 * Cross-platform keep-awake.
 *
 * Spawns a long-lived child process at user privilege to prevent the OS
 * from entering sleep while a long-running task (e.g. /autopilot) is
 * active. Windows uses SetThreadExecutionState via a PowerShell loop;
 * macOS uses `caffeinate -i`; Linux uses `systemd-inhibit` (with an
 * `xset s off` fallback). All errors are non-fatal — if the platform
 * helper is missing, a no-op handle is returned and a warning is logged.
 *
 * Public API:
 *   - acquireKeepAwake({ reason, keepDisplay }) → Handle
 *   - isKeepAwakeSupported() → boolean (cached)
 *   - KeepAwakeError (only used for programmer-error / typed throws)
 *
 * Handle shape: { active, since, platform, reason, release(): Promise<void> }
 *
 * @module lib/system/keep-awake
 */

import { spawn, spawnSync } from 'node:child_process';
import { platform as osPlatform } from 'node:os';

/** Typed error for predictable consumer handling. Never thrown for missing-helper cases. */
export class KeepAwakeError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'KeepAwakeError';
    if (code) this.code = code;
  }
}

/**
 * Refcounted registry — at most one OS-level child per process.
 * Multiple acquireKeepAwake() calls reuse the same child; the child is
 * killed only when refcount returns to zero.
 * @type {{ handle: object|null, child: import('node:child_process').ChildProcess|null, refs: number }}
 */
const REGISTRY = { handle: null, child: null, refs: 0 };

/** Memoized binary-presence probe per binary name. */
const SUPPORT_CACHE = new Map();
let EXIT_HOOKS_INSTALLED = false;

/** Best-effort logger — writes to stderr (no console.* to keep lint clean). */
function warn(message) {
  try { process.stderr.write(`[keep-awake] ${message}\n`); } catch { /* never throw from warn */ }
}

/**
 * Probe whether a binary is on PATH. Cached.
 * @param {string} bin
 * @returns {boolean}
 */
function hasBinary(bin) {
  if (SUPPORT_CACHE.has(bin)) return SUPPORT_CACHE.get(bin);
  const probeCmd = process.platform === 'win32' ? 'where' : 'which';
  let ok;
  try {
    const r = spawnSync(probeCmd, [bin], { stdio: 'ignore' });
    ok = r.status === 0;
  } catch {
    ok = false;
  }
  SUPPORT_CACHE.set(bin, ok);
  return ok;
}

/**
 * Best-effort presence check — does the current platform have a usable
 * keep-awake helper available? Windows is always true (PowerShell ships
 * with the OS); macOS requires `caffeinate`; Linux requires either
 * `systemd-inhibit` or `xset`.
 * @returns {boolean}
 */
export function isKeepAwakeSupported() {
  const p = osPlatform();
  if (p === 'win32') return hasBinary('powershell') || hasBinary('pwsh');
  if (p === 'darwin') return hasBinary('caffeinate');
  if (p === 'linux') return hasBinary('systemd-inhibit') || hasBinary('xset');
  return false;
}

/** Build the PowerShell script that flips ES_CONTINUOUS+ES_SYSTEM_REQUIRED for the child's lifetime. */
function buildPowershellScript(keepDisplay) {
  // ES_CONTINUOUS=0x80000000 | ES_SYSTEM_REQUIRED=0x00000001 | ES_AWAYMODE_REQUIRED=0x00000040
  // ES_DISPLAY_REQUIRED=0x00000002 (when keepDisplay)
  const displayBit = keepDisplay ? '0x00000002' : '0x00000000';
  // PowerShell single-quoted strings disable backtick escaping; embedded
  // double-quotes inside the C# DllImport attribute are literal here.
  const csharp = "using System;using System.Runtime.InteropServices;"
    + "public class ArtibotPower { [DllImport(`\"kernel32.dll`\")] "
    + "public static extern uint SetThreadExecutionState(uint esFlags); }";
  return [
    `Add-Type -TypeDefinition '${csharp}'`,
    `[ArtibotPower]::SetThreadExecutionState([uint32]('0x80000000' -bor '0x00000001' -bor ${displayBit} -bor '0x00000040')) | Out-Null`,
    'while ($true) { Start-Sleep -Seconds 30 }',
  ].join('; ');
}

/**
 * Spawn the platform-specific child. Returns the ChildProcess on success,
 * or null when the helper is missing (caller falls back to a no-op handle).
 * @param {{ reason: string, keepDisplay: boolean }} opts
 * @returns {{ child: import('node:child_process').ChildProcess|null, platform: string, fallback?: string }}
 */
function spawnPlatformChild({ reason, keepDisplay }) {
  const p = osPlatform();
  if (p === 'win32') {
    const ps = hasBinary('pwsh') ? 'pwsh' : (hasBinary('powershell') ? 'powershell' : null);
    if (!ps) return { child: null, platform: p };
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', buildPowershellScript(keepDisplay)], {
      stdio: 'ignore', detached: false, windowsHide: true,
    });
    return { child, platform: p };
  }
  if (p === 'darwin') {
    if (!hasBinary('caffeinate')) return { child: null, platform: p };
    const args = keepDisplay ? ['-d', '-i'] : ['-i'];
    const child = spawn('caffeinate', args, { stdio: 'ignore', detached: false });
    return { child, platform: p };
  }
  if (p === 'linux') {
    if (hasBinary('systemd-inhibit')) {
      const what = keepDisplay ? 'sleep:idle:handle-lid-switch' : 'sleep:idle';
      const child = spawn('systemd-inhibit', [
        `--who=artibot`, `--why=${reason}`, '--mode=block', `--what=${what}`,
        'sleep', 'infinity',
      ], { stdio: 'ignore', detached: false });
      return { child, platform: p };
    }
    if (hasBinary('xset')) {
      warn('systemd-inhibit unavailable; falling back to xset (display-only)');
      const child = spawn('xset', ['s', 'off'], { stdio: 'ignore', detached: false });
      return { child, platform: p, fallback: 'xset' };
    }
    return { child: null, platform: p };
  }
  return { child: null, platform: p };
}

/** Install one-time process-exit handlers that kill any orphan child. */
function installExitHooks() {
  if (EXIT_HOOKS_INSTALLED) return;
  EXIT_HOOKS_INSTALLED = true;
  const cleanup = () => {
    if (REGISTRY.child && !REGISTRY.child.killed) {
      try { REGISTRY.child.kill('SIGTERM'); } catch { /* best-effort */ }
    }
    REGISTRY.refs = 0;
    REGISTRY.child = null;
    REGISTRY.handle = null;
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

/**
 * Build a no-op handle (used when the platform has no helper or refcounted reuse).
 * @param {{ active: boolean, platform: string, reason: string|null, releaseFn: () => Promise<void> }} fields
 */
function buildHandle({ active, platform, reason, releaseFn }) {
  return Object.freeze({
    active,
    since: new Date().toISOString(),
    platform,
    reason,
    release: releaseFn,
  });
}

/**
 * Acquire a keep-awake lease. Returns a handle whose `.release()` decrements
 * the refcount; the underlying child is killed only at refcount 0.
 *
 * Idempotent: calling this multiple times on the same process reuses the
 * existing child. Never throws on missing-helper — returns an inactive handle
 * with `active=false, reason='unsupported'` and logs a warning instead.
 *
 * @param {{ reason?: string, keepDisplay?: boolean }} [opts]
 * @returns {Promise<{ active: boolean, since: string, platform: string, reason: string|null, release: () => Promise<void> }>}
 */
export async function acquireKeepAwake(opts = {}) {
  const reason = typeof opts.reason === 'string' && opts.reason.length > 0 ? opts.reason : 'artibot-autopilot';
  const keepDisplay = opts.keepDisplay === true;
  installExitHooks();

  // Refcount reuse — return a new handle wired to the same child.
  if (REGISTRY.child && !REGISTRY.child.killed) {
    REGISTRY.refs += 1;
    return buildHandle({
      active: true,
      platform: REGISTRY.handle?.platform || osPlatform(),
      reason,
      releaseFn: makeReleaseFn(),
    });
  }

  const { child, platform, fallback } = spawnPlatformChild({ reason, keepDisplay });
  if (!child) {
    warn(`keep-awake unsupported on platform=${platform}; running without sleep prevention`);
    return buildHandle({
      active: false,
      platform,
      reason: 'unsupported',
      releaseFn: async () => { /* no-op */ },
    });
  }

  // If the helper dies unexpectedly (e.g. systemd-inhibit denied), clear the
  // registry so the next acquire re-probes; do not throw.
  child.once('exit', (code) => {
    if (REGISTRY.child === child) {
      REGISTRY.child = null;
      REGISTRY.handle = null;
      REGISTRY.refs = 0;
      if (code !== 0 && code !== null) warn(`keep-awake child exited unexpectedly: code=${code}`);
    }
  });

  REGISTRY.child = child;
  REGISTRY.refs = 1;
  const handle = buildHandle({
    active: true,
    platform,
    reason: fallback ? `${reason} (fallback=${fallback})` : reason,
    releaseFn: makeReleaseFn(),
  });
  REGISTRY.handle = handle;
  return handle;
}

/** Build a release function that decrements refcount and kills the child at zero. */
function makeReleaseFn() {
  let released = false;
  return async function release() {
    if (released) return;
    released = true;
    if (REGISTRY.refs <= 0) return;
    REGISTRY.refs -= 1;
    if (REGISTRY.refs > 0) return;
    const child = REGISTRY.child;
    REGISTRY.child = null;
    REGISTRY.handle = null;
    if (!child || child.killed) return;
    try { child.kill('SIGTERM'); } catch { /* best-effort */ }
  };
}

/** Test-only: force-reset the module's internal state. Not exported via barrel. */
export function _resetForTests() {
  if (REGISTRY.child && !REGISTRY.child.killed) {
    try { REGISTRY.child.kill('SIGTERM'); } catch { /* ignore */ }
  }
  REGISTRY.child = null;
  REGISTRY.handle = null;
  REGISTRY.refs = 0;
  SUPPORT_CACHE.clear();
}
