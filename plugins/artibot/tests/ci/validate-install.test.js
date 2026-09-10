/**
 * Tests for scripts/ci/validate-install.js — the release-gate install/update
 * integrity validator. Covers: the real repo passes parity, and synthetic
 * feature-parity drift / missing-file / broken-reference cases are caught.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PARITY_MATRIX,
  REQUIRED_FILES,
  runInstallChecks,
} from '../../scripts/ci/validate-install.js';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..', '..');
const tmpDirs = [];

function makeFixture({ omitPs1Cap = null, omitFile = null, updateRefs = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vi-install-'));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });

  // install.sh — include every sh marker.
  const sh = '#!/usr/bin/env bash\n'
    + PARITY_MATRIX.map((c) => `${c.sh}() { :; }`).join('\n') + '\n';
  // install.ps1 — include every ps1 marker except the omitted one.
  const ps1 = PARITY_MATRIX
    .filter((c) => c.ps1 !== omitPs1Cap)
    .map((c) => `function ${c.ps1} {}`).join('\n') + '\n';

  const updateBody = updateRefs
    ? '// references install.sh and install.ps1\nexport const x = 1;\n'
    : '// no installer references here\nexport const x = 1;\n';

  const files = {
    'install.sh': sh,
    'install.ps1': ps1,
    'scripts/update.js': updateBody,
    'scripts/update-platform.js': 'export const y = 2;\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    if (rel === omitFile) continue;
    writeFileSync(path.join(dir, rel), content, 'utf-8');
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('validate-install exports', () => {
  it('PARITY_MATRIX is non-empty and well-formed', () => {
    expect(Array.isArray(PARITY_MATRIX)).toBe(true);
    expect(PARITY_MATRIX.length).toBeGreaterThan(5);
    for (const cap of PARITY_MATRIX) {
      expect(typeof cap.name).toBe('string');
      expect(typeof cap.sh).toBe('string');
      expect(typeof cap.ps1).toBe('string');
    }
  });

  it('REQUIRED_FILES lists both installers and update entrypoints', () => {
    expect(REQUIRED_FILES).toContain('install.sh');
    expect(REQUIRED_FILES).toContain('install.ps1');
    expect(REQUIRED_FILES).toContain('scripts/update.js');
  });
});

describe('runInstallChecks — real repo', () => {
  it('passes with zero errors (install.sh ↔ install.ps1 in parity)', () => {
    const { errors } = runInstallChecks(PLUGIN_ROOT);
    expect(errors).toEqual([]);
  });
});

describe('runInstallChecks — synthetic drift detection', () => {
  it('flags an error when install.ps1 drops a capability install.sh has', () => {
    const dir = makeFixture({ omitPs1Cap: 'Save-SourcePath' });
    const { errors } = runInstallChecks(dir);
    expect(errors.some((e) => e.includes('install.ps1 missing') && e.includes('source-repo.json'))).toBe(true);
  });

  it('flags an error when a required file is missing', () => {
    const dir = makeFixture({ omitFile: 'install.ps1' });
    const { errors } = runInstallChecks(dir);
    expect(errors.some((e) => e.includes('Missing required file: install.ps1'))).toBe(true);
  });

  it('flags an error when update.js loses the installer references', () => {
    const dir = makeFixture({ updateRefs: false });
    const { errors } = runInstallChecks(dir);
    expect(errors.some((e) => e.includes('install.sh fallback'))).toBe(true);
    expect(errors.some((e) => e.includes('install.ps1'))).toBe(true);
  });

  it('passes a fully-parity fixture with no errors', () => {
    const dir = makeFixture();
    const { errors } = runInstallChecks(dir);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Native-install skip parity (2026-09-10). PARITY_MATRIX (scripts/ci/validate-
// install.js) is keyed by FUNCTION NAME only, so a skip branch added to one
// installer and not the other would still pass it. Pin the shared contract
// here by content: same detection marker, a force flag in each dialect, and
// the same user-visible skip line. Behaviour is covered by
// tests/scripts/install-native-detect.test.js (sh) and
// tests/scripts/install-ps1-native-detect.test.js (ps1); this block only
// guards the two files against drifting apart.
// ---------------------------------------------------------------------------
describe('install.sh ↔ install.ps1 — native plugin skip parity', () => {
  const sh = readFileSync(path.join(PLUGIN_ROOT, 'install.sh'), 'utf-8');
  const ps1 = readFileSync(path.join(PLUGIN_ROOT, 'install.ps1'), 'utf-8');

  it('both installers carry a native-install detector reading the marketplace cache root', () => {
    expect(sh).toMatch(/^detect_native_plugin_install\(\) \{/m);
    expect(ps1).toMatch(/^function Test-NativePluginInstall \{/m);
  });

  it('the cache-root constant is defined ONCE per installer and is the same path in both', () => {
    // sh:  ARTIBOT_PLUGIN_CACHE_ROOT="${CLAUDE_DIR}/plugins/cache/artibot/artibot"
    // ps1: $PluginCacheRoot = Join-Path $ClaudeDir 'plugins\cache\artibot\artibot'
    // Detector and cache mirror in each script must read that one constant —
    // a second literal is the drift the lead flagged (sh vs ps1 diverging).
    const shDecl = sh.match(/^ARTIBOT_PLUGIN_CACHE_ROOT="\$\{CLAUDE_DIR\}\/([^"]+)"/m);
    const ps1Decl = ps1.match(/^\$PluginCacheRoot = Join-Path \$ClaudeDir '([^']+)'/m);
    expect(shDecl, 'install.sh top-level ARTIBOT_PLUGIN_CACHE_ROOT missing').not.toBeNull();
    expect(ps1Decl, 'install.ps1 top-level $PluginCacheRoot missing').not.toBeNull();
    const shRel = shDecl[1];
    const ps1Rel = ps1Decl[1].replace(/\\/g, '/');
    expect(ps1Rel).toBe(shRel);
    // Same marker as lib/core/install-mode.js#detectInstallMode (plugins/cache).
    expect(shRel).toMatch(/^plugins\/cache\//);
    // Exactly one literal of the path per file (the declaration itself).
    expect(sh.split(shRel).length - 1).toBe(1);
    expect(ps1.split(ps1Decl[1]).length - 1).toBe(1);
    // PowerShell also accepts the forward-slash spelling — a second literal in
    // that form would slip past the backslash count above (review minor #1).
    expect(ps1.split(ps1Rel).length - 1).toBe(0);
  });

  it('both installers expose a force flag (--flat / -Flat) and the same skip line', () => {
    expect(sh).toMatch(/--flat/);
    expect(ps1).toMatch(/\[switch\]\$Flat\b/);
    expect(sh).toMatch(/native plugin detected at .* skipping flat copy of agents\/commands; use --flat to force/);
    expect(ps1).toMatch(/native plugin detected at .* skipping flat copy of agents\/commands; use -Flat to force/);
  });
});
