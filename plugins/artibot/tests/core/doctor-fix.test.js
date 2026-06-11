/**
 * Tests for the doctor self-healing layer (lib/core/doctor-fix.js).
 *
 * Verifies the SAFE-only repair contract:
 *   (a) missing directory creation
 *   (b) corrupt JSON → backup (.broken-<ts>) + default regeneration
 *   (c) dryRun=true (the default) performs ZERO filesystem mutation
 *   (d) one throwing action is try-isolated — remaining actions still run
 *   (e) hook-registration gaps classify as `manual` (settings untouched)
 *
 * Fixtures use a per-test tempdir so nothing touches the real repo.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  FIX_ACTIONS,
  SEVERITY,
  runDoctorFix,
} from '../../lib/core/doctor-fix.js';

// ---------------------------------------------------------------------------
// Sandbox helpers
// ---------------------------------------------------------------------------

const sandboxes = [];

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artibot-doctorfix-'));
  sandboxes.push(dir);
  return dir;
}

afterEach(() => {
  while (sandboxes.length) {
    const dir = sandboxes.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// FIX_ACTIONS catalog
// ---------------------------------------------------------------------------

describe('FIX_ACTIONS catalog', () => {
  it('should expose Korean descriptions and a fix fn for every action', () => {
    for (const [code, action] of Object.entries(FIX_ACTIONS)) {
      expect(typeof action.description, code).toBe('string');
      expect(action.description.length, code).toBeGreaterThan(0);
      expect(typeof action.fix, code).toBe('function');
      expect([SEVERITY.AUTO, SEVERITY.MANUAL]).toContain(action.severity);
    }
  });

  it('should be frozen (immutable catalog)', () => {
    expect(Object.isFrozen(FIX_ACTIONS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (a) Missing directory creation
// ---------------------------------------------------------------------------

describe('runDoctorFix — (a) missing directory', () => {
  it('should create a missing runtime directory under --fix', () => {
    const root = makeSandbox();
    const target = path.join(root, 'runtime');
    expect(fs.existsSync(target)).toBe(false);

    const out = runDoctorFix(
      [{ code: 'missing-runtime-dir', target }],
      { dryRun: false },
    );

    expect(fs.existsSync(target)).toBe(true);
    expect(out.fixed).toHaveLength(1);
    expect(out.fixed[0].code).toBe('missing-runtime-dir');
    expect(out.fixed[0].created).toBe(target);
  });

  it('should skip when the directory already exists', () => {
    const root = makeSandbox();
    const target = path.join(root, 'memory');
    fs.mkdirSync(target);

    const out = runDoctorFix(
      [{ code: 'missing-memory-dir', target }],
      { dryRun: false },
    );

    expect(out.fixed).toHaveLength(0);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].message).toContain('이미 존재');
  });
});

// ---------------------------------------------------------------------------
// (b) Corrupt JSON → backup + default
// ---------------------------------------------------------------------------

describe('runDoctorFix — (b) corrupt JSON repair', () => {
  it('should back up corrupt JSON to .broken-<ts> and write the default', () => {
    const root = makeSandbox();
    const target = path.join(root, 'config.json');
    fs.writeFileSync(target, '{ this is : not valid json ', 'utf-8');

    const fixedTs = 1700000000000;
    const out = runDoctorFix(
      [{ code: 'broken-config-json', target, defaultValue: { version: '0.0.0' } }],
      { dryRun: false },
      { now: () => fixedTs },
    );

    // backup preserves the original corrupt bytes — never deleted
    const backup = `${target}.broken-${fixedTs}`;
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.readFileSync(backup, 'utf-8')).toContain('not valid json');

    // target now parses and equals the supplied default
    const restored = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(restored).toEqual({ version: '0.0.0' });

    expect(out.fixed).toHaveLength(1);
    expect(out.fixed[0].backup).toBe(backup);
  });

  it('should NOT touch a JSON file that already parses cleanly', () => {
    const root = makeSandbox();
    const target = path.join(root, 'config.json');
    const original = JSON.stringify({ ok: true }, null, 2);
    fs.writeFileSync(target, original, 'utf-8');

    const out = runDoctorFix(
      [{ code: 'broken-json', target, defaultValue: {} }],
      { dryRun: false },
    );

    expect(fs.readFileSync(target, 'utf-8')).toBe(original);
    expect(out.skipped).toHaveLength(1);
    expect(out.fixed).toHaveLength(0);
  });

  it('should create the file from default when target is missing', () => {
    const root = makeSandbox();
    const target = path.join(root, 'nested', 'config.json');

    const out = runDoctorFix(
      [{ code: 'broken-config-json', target, defaultValue: { a: 1 } }],
      { dryRun: false },
    );

    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({ a: 1 });
    expect(out.fixed[0].created).toBe(target);
  });
});

// ---------------------------------------------------------------------------
// (c) dryRun default — zero filesystem mutation
// ---------------------------------------------------------------------------

describe('runDoctorFix — (c) dryRun is the default and mutates nothing', () => {
  it('should default to dryRun=true and NOT create directories', () => {
    const root = makeSandbox();
    const target = path.join(root, 'runtime');

    const out = runDoctorFix([{ code: 'missing-runtime-dir', target }]);

    expect(out.dryRun).toBe(true);
    expect(fs.existsSync(target)).toBe(false); // no mutation
    expect(out.fixed).toHaveLength(1);
    expect(out.fixed[0].message).toContain('[dry-run]');
    expect(out.fixed[0].wouldCreate).toBe(target);
  });

  it('should NOT back up or rewrite corrupt JSON in dryRun', () => {
    const root = makeSandbox();
    const target = path.join(root, 'config.json');
    const corrupt = '{ broken ';
    fs.writeFileSync(target, corrupt, 'utf-8');

    const out = runDoctorFix(
      [{ code: 'broken-config-json', target, defaultValue: {} }],
      { dryRun: true },
      { now: () => 123 },
    );

    // original untouched, no backup written
    expect(fs.readFileSync(target, 'utf-8')).toBe(corrupt);
    expect(fs.existsSync(`${target}.broken-123`)).toBe(false);
    expect(out.fixed[0].message).toContain('[dry-run]');
  });
});

// ---------------------------------------------------------------------------
// (d) try-isolation — one throwing action does not abort the pass
// ---------------------------------------------------------------------------

describe('runDoctorFix — (d) try-isolation', () => {
  it('should isolate a throwing fs op and still process later diagnostics', () => {
    const root = makeSandbox();
    const goodTarget = path.join(root, 'runtime');

    // fs facade whose mkdirSync throws ONLY for the first (poison) target.
    const poison = path.join(root, 'poison');
    const realFs = fs;
    const throwingFs = {
      existsSync: (p) => realFs.existsSync(p),
      mkdirSync: (p, o) => {
        if (p === poison) throw new Error('boom');
        return realFs.mkdirSync(p, o);
      },
      readFileSync: (p, e) => realFs.readFileSync(p, e),
      writeFileSync: (p, d, e) => realFs.writeFileSync(p, d, e),
      renameSync: (a, b) => realFs.renameSync(a, b),
      statSync: (p) => realFs.statSync(p),
    };

    const out = runDoctorFix(
      [
        { code: 'missing-dir', target: poison },
        { code: 'missing-runtime-dir', target: goodTarget },
      ],
      { dryRun: false },
      { fs: throwingFs },
    );

    // poison degraded to a skip; good target still created
    expect(out.skipped.some((s) => s.message.includes('boom'))).toBe(true);
    expect(fs.existsSync(goodTarget)).toBe(true);
    expect(out.fixed.some((f) => f.created === goodTarget)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (e) manual classification — hooks never auto-edit settings
// ---------------------------------------------------------------------------

describe('runDoctorFix — (e) manual classification', () => {
  it('should route hook-registration gaps to manual with candidate paths', () => {
    const candidates = ['~/.claude/settings.json', '~/.claude/settings.local.json'];
    const out = runDoctorFix(
      [{ code: 'hook-registration-missing', candidates }],
      { dryRun: false },
    );

    expect(out.fixed).toHaveLength(0);
    expect(out.manual).toHaveLength(1);
    expect(out.manual[0].code).toBe('hook-registration-missing');
    expect(out.manual[0].message).toContain('settings.json');
  });

  it('should classify marketplace mirror as manual when no syncer is injected', () => {
    const out = runDoctorFix(
      [{ code: 'marketplace-mirror-stale' }],
      { dryRun: false },
    );
    expect(out.manual).toHaveLength(1);
    expect(out.manual[0].code).toBe('marketplace-mirror-stale');
  });

  it('should call an injected mirrorSync under --fix', () => {
    let called = false;
    const out = runDoctorFix(
      [{ code: 'marketplace-mirror-stale' }],
      { dryRun: false },
      { mirrorSync: () => { called = true; return 'synced'; } },
    );
    expect(called).toBe(true);
    expect(out.fixed).toHaveLength(1);
    expect(out.fixed[0].mirror).toBe('synced');
  });

  it('should classify orphan-lock as manual without an injected releaser', () => {
    const out = runDoctorFix(
      [{ code: 'orphan-lock' }],
      { dryRun: false },
    );
    expect(out.manual).toHaveLength(1);
  });

  it('should invoke an injected lockReleaser under --fix', () => {
    const out = runDoctorFix(
      [{ code: 'orphan-lock', detail: 'feat-x' }],
      { dryRun: false },
      { lockReleaser: () => ['feat-x'] },
    );
    expect(out.fixed).toHaveLength(1);
    expect(out.fixed[0].released).toEqual(['feat-x']);
  });
});

// ---------------------------------------------------------------------------
// Input hardening
// ---------------------------------------------------------------------------

describe('runDoctorFix — input hardening', () => {
  it('should never throw on non-array diagnostics', () => {
    expect(() => runDoctorFix(null)).not.toThrow();
    expect(() => runDoctorFix(undefined)).not.toThrow();
    expect(() => runDoctorFix('nope')).not.toThrow();
    const out = runDoctorFix(null);
    expect(out).toEqual({ dryRun: true, fixed: [], skipped: [], manual: [] });
  });

  it('should skip unknown diagnostic codes', () => {
    const out = runDoctorFix([{ code: 'totally-unknown' }], { dryRun: false });
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].message).toContain('매핑된 수리 액션이 없어요');
  });

  it('should skip malformed diagnostic entries', () => {
    const out = runDoctorFix([42, null, { noCode: true }], { dryRun: false });
    expect(out.skipped).toHaveLength(3);
  });

  it('should accept a bare code string as shorthand', () => {
    const out = runDoctorFix(['marketplace-mirror-stale'], { dryRun: false });
    expect(out.manual).toHaveLength(1);
  });
});
