/**
 * Tests for scripts/ci/validate-install.js — the release-gate install/update
 * integrity validator. Covers: the real repo passes parity, and synthetic
 * feature-parity drift / missing-file / broken-reference cases are caught.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
