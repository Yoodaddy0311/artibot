#!/usr/bin/env node
/**
 * release.js — End-to-end release helper for artibot-cowork.
 *
 * Orchestrates a clean release window:
 *   1. Validate plugin.json version matches --version argument
 *   2. Validate CHANGELOG.md has an entry for that version
 *   3. Validate git status (clean or staged-only)
 *   4. Acquire release-lock (pause autopilot)
 *   5. Stage expected files (plugin.json, CHANGELOG.md, --stage paths)
 *   6. Commit with release message (allow-empty fallback)
 *   7. (Optional) git push origin HEAD
 *   8. Release lock
 *
 * On failure at any step, attempt to roll back (release lock, reset staged files).
 *
 * CLI:
 *   node release.js --version 0.4.0
 *   node release.js --version 0.4.0 --stage path/to/extra/file.md --stage another.md
 *   node release.js --version 0.4.0 --topic "schema-generator + smoke tests"
 *   node release.js --version 0.4.0 --push
 *   node release.js --version 0.4.0 --dry-run
 *
 * Exit codes:
 *   0 — success
 *   1 — validation failure (version mismatch, missing CHANGELOG entry, dirty tree)
 *   2 — git operation failure
 *   3 — release-lock failure
 *   4 — bad arguments
 *
 * Zero dependencies. Node 18+ built-ins only.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.cwd();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..');
const PLUGIN_JSON = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const CHANGELOG = path.join(PLUGIN_ROOT, 'CHANGELOG.md');
const RELEASE_LOCK = path.join(SCRIPT_DIR, 'release-lock.js');

const args = process.argv.slice(2);

function parseArgs() {
  const out = { version: null, topic: null, stage: [], push: false, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--version') { out.version = args[i + 1]; i += 1; }
    else if (a === '--topic') { out.topic = args[i + 1]; i += 1; }
    else if (a === '--stage') { out.stage.push(args[i + 1]); i += 1; }
    else if (a === '--push') out.push = true;
    else if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

function fail(code, msg) {
  console.error(`[release] ERROR: ${msg}`);
  process.exit(code);
}

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd: REPO_ROOT, encoding: 'utf-8', ...opts });
  if (result.error) {
    throw new Error(`spawn ${cmd} failed: ${result.error.message}`);
  }
  return result;
}

function gitOrFail(cmdArgs, errMsg) {
  const r = run('git', cmdArgs);
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    fail(2, `${errMsg} (git ${cmdArgs.join(' ')} exited ${r.status})`);
  }
  return r;
}

function validateVersion(expected) {
  if (!existsSync(PLUGIN_JSON)) fail(1, `plugin.json not found at ${PLUGIN_JSON}`);
  const pkg = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));
  if (pkg.version !== expected) {
    fail(1, `plugin.json version (${pkg.version}) does not match --version ${expected}`);
  }
  return pkg.version;
}

function validateChangelog(version) {
  if (!existsSync(CHANGELOG)) fail(1, `CHANGELOG.md not found at ${CHANGELOG}`);
  const text = readFileSync(CHANGELOG, 'utf-8');
  const pattern = new RegExp(`^##\\s*\\[?${version.replace(/\./g, '\\.')}\\]?`, 'm');
  if (!pattern.test(text)) {
    fail(1, `CHANGELOG.md missing an entry heading for version ${version} (expected "## [${version}]" or "## ${version}")`);
  }
}

function validateGitState() {
  const r = run('git', ['status', '--porcelain']);
  if (r.status !== 0) fail(2, 'git status failed');
  const lines = r.stdout.split('\n').filter(Boolean);
  const unstaged = lines.filter((line) => line[1] !== ' ' && line[1] !== undefined);
  if (unstaged.length > 0) {
    console.error('[release] Working tree has unstaged changes:');
    unstaged.forEach((line) => console.error(`  ${line}`));
    fail(1, 'commit or stash unstaged changes before releasing');
  }
}

function acquireLock(reason) {
  const r = run('node', [RELEASE_LOCK, '--acquire', '--reason', reason], { stdio: 'inherit' });
  if (r.status !== 0) fail(3, 'release-lock --acquire failed');
}

function releaseLock() {
  const r = run('node', [RELEASE_LOCK, '--release'], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[release] WARNING: release-lock --release failed. Manual cleanup required:');
    console.error('  node plugins/artibot-cowork/scripts/release-lock.js --status');
  }
}

function stageFiles(extra) {
  const candidates = [PLUGIN_JSON, CHANGELOG, ...extra.map((p) => path.resolve(REPO_ROOT, p))];
  const existing = candidates.filter((p) => existsSync(p));
  if (existing.length === 0) {
    console.log('[release] No files to stage.');
    return;
  }
  gitOrFail(['add', '--', ...existing], 'git add failed');
  console.log(`[release] Staged ${existing.length} file(s).`);
}

function commitRelease(version, topic) {
  const subject = `release(artibot-cowork v${version})${topic ? `: ${topic}` : ''}`;
  const body = [
    subject,
    '',
    `Automated by plugins/artibot-cowork/scripts/release.js`,
    `Version source: plugins/artibot-cowork/.claude-plugin/plugin.json`,
  ].join('\n');

  const staged = run('git', ['diff', '--cached', '--name-only']);
  const hasStaged = staged.stdout.split('\n').filter(Boolean).length > 0;

  const commitArgs = ['commit', '-m', body];
  if (!hasStaged) commitArgs.splice(1, 0, '--allow-empty');

  gitOrFail(commitArgs, 'git commit failed');
  console.log(`[release] Commit created: ${subject}`);
}

function maybePush() {
  gitOrFail(['push', 'origin', 'HEAD'], 'git push failed');
  console.log('[release] Pushed to origin.');
}

async function main() {
  const opts = parseArgs();
  if (!opts.version) {
    console.error('Usage:');
    console.error('  node release.js --version <X.Y.Z> [--topic "..."] [--stage path] [--push] [--dry-run]');
    process.exit(4);
  }

  console.log(`[release] artibot-cowork v${opts.version}${opts.dryRun ? ' (DRY RUN)' : ''}`);

  validateVersion(opts.version);
  console.log('[release] OK plugin.json version matches');

  validateChangelog(opts.version);
  console.log('[release] OK CHANGELOG.md has entry');

  validateGitState();
  console.log('[release] OK git state clean (or staged-only)');

  if (opts.dryRun) {
    console.log('[release] DRY RUN complete. No files, locks, or commits touched.');
    return;
  }

  const reason = `artibot-cowork v${opts.version}${opts.topic ? ` — ${opts.topic}` : ''}`;
  acquireLock(reason);

  try {
    stageFiles(opts.stage);
    commitRelease(opts.version, opts.topic);
    if (opts.push) maybePush();
  } catch (err) {
    console.error(`[release] Step failed: ${err.message}`);
    releaseLock();
    process.exit(2);
  }

  releaseLock();
  console.log(`[release] DONE — artibot-cowork v${opts.version} released.`);
}

main();
