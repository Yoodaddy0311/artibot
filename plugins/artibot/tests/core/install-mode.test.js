/**
 * Unit tests for lib/core/install-mode.js — detectInstallMode (B3/B4).
 *
 * Uses tmpdir fixtures for the legacy flat-install payload so the result is
 * deterministic regardless of the host machine's real ~/.claude state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectInstallMode, NATIVE_UPDATE_HINT } from '../../lib/core/install-mode.js';

let home;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'artibot-install-mode-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The marketplace cache dir for a given version. */
function cacheRoot(version = '4.29.0') {
  return path.join(home, '.claude', 'plugins', 'cache', 'artibot', 'artibot', version);
}

/** Create a flat legacy payload (install.sh) under ~/.claude/artibot. */
function writeFlatPayload() {
  const flat = path.join(home, '.claude', 'artibot');
  mkdirSync(flat, { recursive: true });
  writeFileSync(path.join(flat, 'install.sh'), '#!/bin/sh\n', 'utf-8');
}

describe('detectInstallMode', () => {
  it('classifies NATIVE when plugin root is under the marketplace cache and no flat payload exists', () => {
    const r = detectInstallMode({ pluginRoot: cacheRoot(), home, env: {} });
    expect(r.mode).toBe('native');
    expect(r.native).toBe(true);
    expect(r.legacy).toBe(false);
  });

  it('classifies NATIVE from CLAUDE_PLUGIN_ROOT env even when pluginRoot is empty', () => {
    const r = detectInstallMode({ pluginRoot: '', home, env: { CLAUDE_PLUGIN_ROOT: cacheRoot() } });
    expect(r.mode).toBe('native');
  });

  it('classifies LEGACY when a flat install payload exists and plugin root is a source checkout', () => {
    writeFlatPayload();
    const r = detectInstallMode({ pluginRoot: '/src/artibot/plugins/artibot', home, env: {} });
    expect(r.mode).toBe('legacy');
    expect(r.native).toBe(false);
    expect(r.legacy).toBe(true);
  });

  it('classifies AMBIGUOUS (both) when cache root AND flat payload are present', () => {
    writeFlatPayload();
    const r = detectInstallMode({ pluginRoot: cacheRoot(), home, env: {} });
    expect(r.mode).toBe('ambiguous');
    expect(r.native).toBe(true);
    expect(r.legacy).toBe(true);
    expect(r.reason).toMatch(/both/i);
  });

  it('classifies AMBIGUOUS (neither) when no signal is present', () => {
    const r = detectInstallMode({ pluginRoot: '/src/artibot/plugins/artibot', home, env: {} });
    expect(r.mode).toBe('ambiguous');
    expect(r.native).toBe(false);
    expect(r.legacy).toBe(false);
    expect(r.reason).toMatch(/neither/i);
  });

  it('detects legacy via hooks/hooks.json payload (not just install.sh)', () => {
    const flat = path.join(home, '.claude', 'artibot', 'hooks');
    mkdirSync(flat, { recursive: true });
    writeFileSync(path.join(flat, 'hooks.json'), '{}', 'utf-8');
    const r = detectInstallMode({ pluginRoot: '/src/x/plugins/artibot', home, env: {} });
    expect(r.mode).toBe('legacy');
  });

  it('does NOT treat a data-only ~/.claude/artibot dir as legacy (no payload files)', () => {
    // Only a data file (backup metadata) — this exists under native installs too.
    const flat = path.join(home, '.claude', 'artibot');
    mkdirSync(flat, { recursive: true });
    writeFileSync(path.join(flat, 'update-backup.json'), '{}', 'utf-8');
    const r = detectInstallMode({ pluginRoot: cacheRoot(), home, env: {} });
    expect(r.legacy).toBe(false);
    expect(r.mode).toBe('native');
  });

  it('normalizes Windows-style backslash paths', () => {
    const winCache = cacheRoot().replace(/\//g, '\\');
    const r = detectInstallMode({ pluginRoot: winCache, home, env: {} });
    expect(r.native).toBe(true);
  });

  it('is defensive against missing home (no throw, ambiguous)', () => {
    const r = detectInstallMode({ pluginRoot: '/whatever', home: '', env: {} });
    expect(r.mode).toBe('ambiguous');
    expect(r.native).toBe(false);
    expect(r.legacy).toBe(false);
  });

  it('exposes the native update hint constant', () => {
    expect(NATIVE_UPDATE_HINT).toBe('/plugin marketplace update artibot');
  });
});
