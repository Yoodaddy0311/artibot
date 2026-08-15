#!/usr/bin/env node
/**
 * release-lock.js — Temporarily pause Artibot autopilot during a release window.
 *
 * During a release, autopilot's session-close auto-commit/push can fragment
 * the release commit. This tool backs up the current autopilot.enabled value
 * into a side-car lock file, forces enabled=false for the release window,
 * and restores the original value when released.
 *
 * CLI:
 *   node release-lock.js --acquire [--reason "cowork v0.4.0 release"]
 *   node release-lock.js --release
 *   node release-lock.js --status
 *
 * Exit codes:
 *   0 — success
 *   1 — general error (missing autopilot.json, JSON parse)
 *   2 — lock state conflict (acquire while already locked, release with no lock)
 *   3 — bad arguments
 *
 * Zero dependencies. Node 18+ built-ins only.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Autopilot state lives in the repository's common git directory, which is not
 * always `<cwd>/.git`. Deriving it from cwd failed two ways: release.js spawns
 * this script with cwd set to the plugin directory, which contains no `.git` at
 * all, and inside a linked worktree `.git` is a file rather than a directory.
 *
 * `--git-common-dir` answers both. It always names the main repository's git
 * directory, which is the correct home for state that pauses autopilot
 * repo-wide — a worktree must not keep a private copy. Git may return it
 * relative to cwd (`../../.git` from a subdirectory), so resolve it.
 */
function resolveGitDir() {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0 || !r.stdout.trim()) {
    console.error('[release-lock] Not inside a git repository.');
    console.error('  git rev-parse --git-common-dir failed; cannot locate autopilot state.');
    process.exit(1);
  }
  return path.resolve(r.stdout.trim());
}

const GIT_DIR = resolveGitDir();
const AUTOPILOT_PATH = path.join(GIT_DIR, 'autopilot.json');
const LOCK_PATH = path.join(GIT_DIR, 'autopilot.lock.json');

const args = process.argv.slice(2);

function parseArgs() {
  const result = { mode: null, reason: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--acquire') result.mode = 'acquire';
    else if (a === '--release') result.mode = 'release';
    else if (a === '--status') result.mode = 'status';
    else if (a === '--reason') {
      result.reason = args[i + 1] || null;
      i += 1;
    }
  }
  return result;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`[release-lock] Failed to parse ${file}: ${err.message}`);
    process.exit(1);
    // 도달하지 않는다. `process.exit()` 가 스택을 풀지 않는다는 사실을 정적
    // 분석은 알 수 없어, 이 줄이 없으면 catch 가지가 값 없이 함수 끝으로 흘러
    // consistent-return 위반이 된다. 종료 경로임을 코드로 명시해 둔다.
    //
    // 여기서 exit 하는 것 자체는 안전하다. 불변식: **readJson 호출은 모두 그
    // 함수가 상태를 쓰기 전에 끝난다.** 호출 지점은 5곳이고 전부 이를 만족한다
    // (줄번호는 썩으므로 심볼로 적는다):
    //
    //   requireAutopilot  — 유일한 읽기. 쓰기 없음
    //   cmdAcquire        — 락 파일 읽기 → requireAutopilot. 두 writeJson 보다 앞
    //   cmdRelease        — 락 파일 읽기 → requireAutopilot. writeJson·rmSync 보다 앞
    //   cmdStatus         — 2곳. 이 함수는 읽기 전용이라 쓸 상태가 아예 없다
    //
    // 그래서 이 종료는 락을 누수시키지 않는다. **상태를 쓴 뒤에 읽는 호출이 새로
    // 생기면 그때는 exit 이 아니라 throw 로 바꿔야 한다** — 그게 2026-08-15 D2 와
    // 같은 형태이고, 그 경우 이 주석의 불변식이 깨진 것이므로 함께 갱신하라.
    throw err;
  }
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function requireAutopilot() {
  if (!existsSync(AUTOPILOT_PATH)) {
    console.error(`[release-lock] autopilot.json not found at ${AUTOPILOT_PATH}`);
    console.error('[release-lock] Is this a git repo with Artibot autopilot configured?');
    process.exit(1);
  }
  return readJson(AUTOPILOT_PATH);
}

function cmdAcquire(reason) {
  if (existsSync(LOCK_PATH)) {
    const existing = readJson(LOCK_PATH);
    console.error('[release-lock] Lock already exists:');
    console.error(`  acquired at: ${existing.acquiredAt}`);
    console.error(`  reason:      ${existing.reason || '(not specified)'}`);
    console.error('[release-lock] Run --release first, or inspect .git/autopilot.lock.json manually.');
    process.exit(2);
  }

  const autopilot = requireAutopilot();
  const backup = {
    acquiredAt: new Date().toISOString(),
    reason: reason || 'release window',
    previousEnabled: autopilot.enabled === true,
    previousAutoPushOnStop: autopilot.autoPushOnStop === true,
    previousSquashWipOnClose: autopilot.squashWipOnClose === true,
  };

  writeJson(LOCK_PATH, backup);

  const next = {
    ...autopilot,
    enabled: false,
    autoPushOnStop: false,
    squashWipOnClose: false,
  };
  writeJson(AUTOPILOT_PATH, next);

  console.log('RELEASE LOCK ACQUIRED');
  console.log(`  reason:     ${backup.reason}`);
  console.log(`  backup:     ${LOCK_PATH}`);
  console.log(`  autopilot:  enabled=false, autoPushOnStop=false, squashWipOnClose=false`);
  console.log('');
  console.log('To restore autopilot after release:');
  console.log('  node plugins/artibot-cowork/scripts/release-lock.js --release');
}

function cmdRelease() {
  if (!existsSync(LOCK_PATH)) {
    console.error('[release-lock] No lock file found — nothing to release.');
    console.error(`  expected: ${LOCK_PATH}`);
    process.exit(2);
  }

  const backup = readJson(LOCK_PATH);
  const autopilot = requireAutopilot();

  const restored = {
    ...autopilot,
    enabled: backup.previousEnabled === true,
    autoPushOnStop: backup.previousAutoPushOnStop === true,
    squashWipOnClose: backup.previousSquashWipOnClose === true,
  };
  writeJson(AUTOPILOT_PATH, restored);

  rmSync(LOCK_PATH);

  console.log('RELEASE LOCK RELEASED');
  console.log(`  restored:   enabled=${restored.enabled}, autoPushOnStop=${restored.autoPushOnStop}, squashWipOnClose=${restored.squashWipOnClose}`);
  console.log(`  reason was: ${backup.reason || '(not specified)'}`);
  console.log(`  held for:   ${backup.acquiredAt} → ${new Date().toISOString()}`);
}

function cmdStatus() {
  const locked = existsSync(LOCK_PATH);
  const autopilot = existsSync(AUTOPILOT_PATH) ? readJson(AUTOPILOT_PATH) : null;

  console.log('Release lock status');
  console.log(`  lock file:  ${locked ? 'PRESENT' : 'absent'} (${LOCK_PATH})`);
  if (locked) {
    const backup = readJson(LOCK_PATH);
    console.log(`  acquired:   ${backup.acquiredAt}`);
    console.log(`  reason:     ${backup.reason || '(not specified)'}`);
    console.log(`  backup:     enabled=${backup.previousEnabled}, autoPushOnStop=${backup.previousAutoPushOnStop}`);
  }
  if (autopilot) {
    console.log(`  autopilot:  enabled=${autopilot.enabled}, autoPushOnStop=${autopilot.autoPushOnStop}, squashWipOnClose=${autopilot.squashWipOnClose}`);
  } else {
    console.log('  autopilot:  autopilot.json not found');
  }
}

function main() {
  const { mode, reason } = parseArgs();
  if (!mode) {
    console.error('Usage:');
    console.error('  node release-lock.js --acquire [--reason "cowork v0.4.0 release"]');
    console.error('  node release-lock.js --release');
    console.error('  node release-lock.js --status');
    process.exit(3);
  }
  if (mode === 'acquire') cmdAcquire(reason);
  else if (mode === 'release') cmdRelease();
  else if (mode === 'status') cmdStatus();
}

main();
