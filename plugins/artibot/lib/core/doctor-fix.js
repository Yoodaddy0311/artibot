/**
 * Doctor self-healing layer — maps `/doctor` diagnostic failures to SAFE
 * automatic repairs for the "vibe coder" (non-developer) who hits a sudden
 * "it stopped working" wall and wants a one-shot recovery.
 *
 * Design contract (hard rules — every action obeys all of them):
 *   - 100% local — zero external network calls (DATA POLICY).
 *   - Never destructive: no delete, no overwrite-without-backup, no git ops.
 *     Corrupt JSON is BACKED UP to `<file>.broken-<ts>` before any rewrite.
 *   - Never touch user-owned settings (`~/.claude/settings.json`): hook
 *     registration gaps are surfaced as MANUAL guidance, never auto-applied.
 *   - dryRun defaults to TRUE — `runDoctorFix` only mutates the filesystem
 *     when the caller explicitly passes `{ dryRun: false }` (the `--fix` flag).
 *   - Never throws: each action is try-isolated so one failure cannot abort
 *     the rest of the repair pass.
 *   - DI-friendly: every filesystem / external surface is overridable via
 *     `deps` so tests stay hermetic.
 *
 * Public surface:
 *   - FIX_ACTIONS        — diagnostic code → { description, severity, fix }
 *   - runDoctorFix(diagnostics, opts?, deps?)
 *
 * @module lib/core/doctor-fix
 */

import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Severity ladder for repair actions. `auto` = applied under --fix;
 * `manual` = surfaced as guidance only (never auto-applied).
 * @readonly
 */
export const SEVERITY = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
});

/**
 * Build the default filesystem facade. Every method is overridable via the
 * `deps.fs` injection point so tests never touch the real disk.
 * @returns {object}
 */
function defaultFs() {
  return {
    existsSync: (p) => fsSync.existsSync(p),
    mkdirSync: (p, o) => fsSync.mkdirSync(p, o),
    readFileSync: (p, e) => fsSync.readFileSync(p, e),
    writeFileSync: (p, d, e) => fsSync.writeFileSync(p, d, e),
    renameSync: (a, b) => fsSync.renameSync(a, b),
    statSync: (p) => fsSync.statSync(p),
  };
}

/**
 * Compose the effective dependency facade from caller overrides.
 * @param {object} [deps]
 * @returns {{ fs: object, now: () => number, mirrorSync: (Function|null) }}
 */
function resolveDeps(deps = {}) {
  const base = deps && typeof deps === 'object' ? deps : {};
  return {
    fs: { ...defaultFs(), ...(base.fs || {}) },
    now: typeof base.now === 'function' ? base.now : Date.now,
    // Optional marketplace mirror re-sync hook. The repo has no public
    // `install_marketplace_mirror` export today, so absence is the norm:
    // callers (or future wiring) may inject one; otherwise we degrade to
    // manual guidance. Never required, never throws when absent.
    mirrorSync: typeof base.mirrorSync === 'function' ? base.mirrorSync : null,
    // Optional autopilot orphan-lock releaser, e.g. lock.releaseAllForSession
    // or a custom unlinker. Injected to keep this module decoupled from the
    // autopilot layer (core must not import upward).
    lockReleaser: typeof base.lockReleaser === 'function' ? base.lockReleaser : null,
  };
}

/**
 * Build a fix-result record. Pure helper.
 * @param {'fixed'|'skipped'|'manual'} outcome
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {{ outcome: string, code: string, message: string }}
 */
function record(outcome, code, message, extra = {}) {
  return { outcome, code, message, ...extra };
}

// ---------------------------------------------------------------------------
// Individual fix actions. Each `fix(ctx)` is pure-ish (all I/O via ctx.fs),
// returns a result record, and NEVER throws (callers also try-isolate).
// `ctx` shape: { target, fs, now, dryRun, mirrorSync, lockReleaser, detail }
// ---------------------------------------------------------------------------

/**
 * (a) Create a missing runtime/memory directory. Idempotent; mkdir recursive.
 * @param {object} ctx
 * @returns {object}
 */
function fixMissingDir(ctx) {
  const { target, fs, dryRun, code } = ctx;
  if (!target || typeof target !== 'string') {
    return record('skipped', code, 'no target directory supplied');
  }
  if (fs.existsSync(target)) {
    return record('skipped', code, `이미 존재함: ${target}`);
  }
  if (dryRun) {
    return record('fixed', code, `[dry-run] 디렉토리 생성 예정: ${target}`, { wouldCreate: target });
  }
  fs.mkdirSync(target, { recursive: true });
  return record('fixed', code, `디렉토리 생성됨: ${target}`, { created: target });
}

/**
 * Format a backup sibling path: `<file>.broken-<ts>`. Pure.
 * @param {string} target
 * @param {number} ts
 * @returns {string}
 */
function backupPathFor(target, ts) {
  return `${target}.broken-${ts}`;
}

/**
 * (b) Repair a corrupt JSON file: BACK UP the original to `.broken-<ts>`
 * (never delete it), then write the supplied default. If the file parses
 * cleanly already, this is a no-op skip.
 * @param {object} ctx
 * @returns {object}
 */
function fixBrokenJson(ctx) {
  const { target, fs, dryRun, code, defaultValue } = ctx;
  if (!target || typeof target !== 'string') {
    return record('skipped', code, 'no target file supplied');
  }
  if (!fs.existsSync(target)) {
    // Missing file is a different failure class — defer to dir/default flow.
    if (dryRun) {
      return record('fixed', code, `[dry-run] 기본값 파일 생성 예정: ${target}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, serializeDefault(defaultValue), 'utf-8');
    return record('fixed', code, `기본값으로 생성됨: ${target}`, { created: target });
  }
  // Probe parseability — only repair genuinely broken JSON.
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf-8');
    JSON.parse(raw);
    return record('skipped', code, `JSON 정상 — 수리 불필요: ${target}`);
  } catch {
    /* fall through: corrupt, repair it */
  }
  const backup = backupPathFor(target, ctx.now());
  if (dryRun) {
    return record('fixed', code,
      `[dry-run] 손상된 JSON 백업(${path.basename(backup)}) 후 기본값 재생성 예정: ${target}`,
      { wouldBackup: backup });
  }
  // Preserve the corrupt original first; only rewrite after the backup lands.
  fs.renameSync(target, backup);
  fs.writeFileSync(target, serializeDefault(defaultValue), 'utf-8');
  return record('fixed', code, `손상 JSON 백업 후 기본값 복구됨: ${target}`, {
    backup,
    restored: target,
  });
}

/**
 * Serialize a default JSON value with a trailing newline. Falls back to an
 * empty object when no default supplied.
 * @param {*} value
 * @returns {string}
 */
function serializeDefault(value) {
  const v = value === undefined ? {} : value;
  return JSON.stringify(v, null, 2) + '\n';
}

/**
 * (c) Re-sync the marketplace mirror. Reuses an injected mirror routine when
 * one is available; otherwise degrades to manual guidance (the repo exposes
 * no public mirror function today, and core must not reach upward to install
 * it). Never performs a network call itself.
 * @param {object} ctx
 * @returns {object}
 */
function fixMarketplaceMirror(ctx) {
  const { code, dryRun, mirrorSync } = ctx;
  if (typeof mirrorSync !== 'function') {
    return record('manual', code,
      '마켓플레이스 미러 재동기화 루틴을 찾을 수 없어요. ' +
      '`/setup`을 다시 실행하거나 플러그인을 재설치하면 미러가 복구됩니다.');
  }
  if (dryRun) {
    return record('fixed', code, '[dry-run] 마켓플레이스 미러 재동기화 예정');
  }
  // The injected routine owns its own error handling; we still guard.
  const out = mirrorSync(ctx);
  return record('fixed', code, '마켓플레이스 미러 재동기화 완료', { mirror: out ?? true });
}

/**
 * (d) Release an orphan autopilot lock. Reuses an injected lock releaser
 * (e.g. autopilot lock.releaseAllForSession) — core never imports the
 * autopilot layer directly. Absent releaser → manual guidance.
 * @param {object} ctx
 * @returns {object}
 */
function fixOrphanLock(ctx) {
  const { code, dryRun, lockReleaser, detail } = ctx;
  if (typeof lockReleaser !== 'function') {
    return record('manual', code,
      '잠긴 작업(lock)을 자동 해제할 수 없어요. ' +
      '오토파일럿 세션이 비정상 종료된 경우 `runtime/autopilot/locks/`의 ' +
      '오래된 .lock 파일을 확인해 주세요.');
  }
  if (dryRun) {
    return record('fixed', code, '[dry-run] orphan lock 해제 예정', { detail });
  }
  const released = lockReleaser(ctx);
  return record('fixed', code, 'orphan lock 해제됨', { released: released ?? true });
}

/**
 * (e) Hook registration gap — ALWAYS manual. We never edit the user's
 * `settings.json`. Instead we surface candidate settings paths so the user
 * (or the orchestrator) can wire it themselves.
 * @param {object} ctx
 * @returns {object}
 */
function adviseHookRegistration(ctx) {
  const { code, candidates } = ctx;
  const list = Array.isArray(candidates) && candidates.length
    ? candidates.join('\n  - ')
    : '~/.claude/settings.json';
  return record('manual', code,
    '훅(hook) 등록이 누락된 것 같아요. 사용자 settings는 자동으로 건드리지 않아요. ' +
    `아래 후보 경로에서 Artibot 훅 등록을 확인/추가해 주세요:\n  - ${list}`);
}

/**
 * Diagnostic-code → repair-action catalog.
 *
 * Keys are the stable failure codes a `/doctor` run emits. `fix(ctx)` returns
 * a result record and must never throw. `severity` distinguishes auto-repairs
 * (applied under --fix) from manual guidance (surfaced, never applied).
 * `description` is Korean, user-facing.
 *
 * @type {Record<string, { description: string, severity: string, fix: (ctx: object) => object }>}
 */
export const FIX_ACTIONS = Object.freeze({
  'missing-runtime-dir': {
    description: '런타임 디렉토리(runtime/)가 없어요 — 다시 만들어 드려요.',
    severity: SEVERITY.AUTO,
    fix: fixMissingDir,
  },
  'missing-memory-dir': {
    description: '메모리 저장소 디렉토리(memory/)가 없어요 — 다시 만들어 드려요.',
    severity: SEVERITY.AUTO,
    fix: fixMissingDir,
  },
  'missing-dir': {
    description: '필요한 디렉토리가 없어요 — 생성합니다.',
    severity: SEVERITY.AUTO,
    fix: fixMissingDir,
  },
  'broken-config-json': {
    description: '설정 파일(JSON)이 깨졌어요 — 원본을 백업하고 기본값으로 복구해요.',
    severity: SEVERITY.AUTO,
    fix: fixBrokenJson,
  },
  'broken-json': {
    description: 'JSON 파일이 손상됐어요 — 백업 후 기본값으로 복구해요.',
    severity: SEVERITY.AUTO,
    fix: fixBrokenJson,
  },
  'marketplace-mirror-stale': {
    description: '마켓플레이스 미러가 오래됐어요 — 재동기화를 시도해요.',
    severity: SEVERITY.AUTO,
    fix: fixMarketplaceMirror,
  },
  'orphan-lock': {
    description: '비정상 종료로 남은 잠금(lock)이 있어요 — 해제해요.',
    severity: SEVERITY.AUTO,
    fix: fixOrphanLock,
  },
  'hook-registration-missing': {
    description: '훅 등록이 누락됐어요 — 사용자 settings는 건드리지 않고 안내만 해요.',
    severity: SEVERITY.MANUAL,
    fix: adviseHookRegistration,
  },
});

/**
 * Normalize a single diagnostic entry into `{ code, ...payload }`.
 * Accepts either a bare code string or an object carrying a `code` plus any
 * action payload (target / defaultValue / candidates / detail).
 * @param {string|object} entry
 * @returns {object|null}
 */
function normalizeDiagnostic(entry) {
  if (typeof entry === 'string') return { code: entry };
  if (entry && typeof entry === 'object' && typeof entry.code === 'string') {
    return { ...entry };
  }
  return null;
}

/**
 * Apply the self-healing layer to a set of `/doctor` diagnostic failures.
 *
 * Safety posture: dryRun defaults to TRUE. Real repairs run only when the
 * caller passes `{ dryRun: false }` (the `--fix` flag). Each action is
 * try-isolated so one failure never aborts the rest. Unknown codes and
 * actions that classify themselves `manual` are routed accordingly.
 *
 * @param {Array<string|object>} diagnostics - Failed-check codes/payloads.
 * @param {{ dryRun?: boolean }} [opts] - `dryRun` defaults to true.
 * @param {{ fs?: object, now?: Function, mirrorSync?: Function, lockReleaser?: Function }} [deps]
 * @returns {{
 *   dryRun: boolean,
 *   fixed:   Array<object>,
 *   skipped: Array<object>,
 *   manual:  Array<object>,
 * }}
 */
export function runDoctorFix(diagnostics, opts = {}, deps = {}) {
  // dryRun is TRUE unless explicitly disabled — the core safety invariant.
  const dryRun = !(opts && opts.dryRun === false);
  const resolved = resolveDeps(deps);
  const list = Array.isArray(diagnostics) ? diagnostics : [];

  const fixed = [];
  const skipped = [];
  const manual = [];

  for (const entry of list) {
    const diag = normalizeDiagnostic(entry);
    if (!diag) {
      skipped.push(record('skipped', '(invalid)', '진단 항목 형식이 올바르지 않아요'));
      continue;
    }
    const action = FIX_ACTIONS[diag.code];
    if (!action) {
      skipped.push(record('skipped', diag.code, `매핑된 수리 액션이 없어요: ${diag.code}`));
      continue;
    }

    const ctx = {
      ...diag,
      fs: resolved.fs,
      now: resolved.now,
      mirrorSync: resolved.mirrorSync,
      lockReleaser: resolved.lockReleaser,
      dryRun,
    };

    let result;
    try {
      result = action.fix(ctx);
    } catch (err) {
      // try-isolate: a thrown action degrades to a skip, loop continues.
      skipped.push(record('skipped', diag.code,
        `수리 중 오류 (건너뜀): ${err?.message || 'unknown error'}`));
      continue;
    }

    if (!result || typeof result !== 'object') {
      skipped.push(record('skipped', diag.code, '수리 액션이 결과를 반환하지 않았어요'));
      continue;
    }

    if (result.outcome === 'manual') manual.push(result);
    else if (result.outcome === 'skipped') skipped.push(result);
    else fixed.push(result);
  }

  return { dryRun, fixed, skipped, manual };
}
