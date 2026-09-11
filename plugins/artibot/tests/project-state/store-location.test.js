/**
 * `lib/project-state/store-location.js` — the shared store/ledger location rule.
 *
 * ── Why this file exists separately from state-manager.test.js ──────────────
 * The four resolution cases below were already pinned in
 * `tests/project-state/state-manager.test.js` ("store location — decision F3"),
 * but against the `state-manager.js` re-export. That is the right target for a
 * *consumer* of the store and the wrong one for the rule itself: once
 * `lib/runtime/event-writer.js` also depends on the rule (ADR-011), a test that
 * only ever reaches it through the store's entry point cannot tell "the rule
 * moved" from "the rule broke". Both files keep their copy on purpose — the
 * original proves the re-export stays wired, this one proves the module.
 *
 * ── What the last two cases guard, and what they do not ────────────────────
 * `imports no node:fs` is a SOURCE-TEXT assertion, not a behavioural one. It
 * cannot see an fs call reached through a transitive import, so it is a cheap
 * pin on the one property that makes this module safe to import from L5: it
 * touches no disk. The layering itself is eslint's job
 * (`tests/firewall/layer-registration-coverage.test.js`).
 *
 * The identity (`===`) case is deliberately stricter than a value compare:
 * `STORE_DIR_NAME` is a short string, so a duplicated literal in both modules
 * would pass `toBe` on value while silently leaving two definitions to drift.
 * Comparing the function reference is what makes "re-export, not re-implement"
 * testable.
 *
 * @module tests/project-state/store-location.test
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FALLBACK_RELATIVE,
  resolveStoreLocation,
  STORE_DIR_NAME,
} from '../../lib/project-state/store-location.js';
import * as storeLocation from '../../lib/project-state/store-location.js';
import * as stateManager from '../../lib/project-state/state-manager.js';

const MODULE_PATH = fileURLToPath(
  new URL('../../lib/project-state/store-location.js', import.meta.url),
);

describe('resolveStoreLocation — decision F3, the shared location rule', () => {
  it('puts the store under an ABSOLUTE git common dir', () => {
    const out = resolveStoreLocation({ projectRoot: '/repo', gitCommonDir: '/repo/.git' });
    expect(out.source).toBe('git-common-dir');
    expect(out.dir).toBe(path.resolve('/repo/.git', STORE_DIR_NAME));
    expect(out.reason).toBeNull();
  });

  it('resolves a RELATIVE common dir against projectRoot', () => {
    // Measured on git 2.54.0.windows.1: `--git-common-dir` prints '.git' in a
    // main checkout. Treating it as absolute would put the store at the CWD.
    const out = resolveStoreLocation({ projectRoot: '/repo', gitCommonDir: '.git' });
    expect(out.source).toBe('git-common-dir');
    expect(out.dir).toBe(path.resolve('/repo/.git', STORE_DIR_NAME));
  });

  it('falls back to .artibot/runtime and STATES the reason when the port yields nothing', () => {
    const out = resolveStoreLocation({ projectRoot: '/repo', gitCommonDir: null });
    expect(out.source).toBe('project-root-fallback');
    expect(out.dir).toBe(path.join('/repo', FALLBACK_RELATIVE));
    expect(out.reason).toMatch(/per-worktree/);
  });

  it('throws for an empty projectRoot rather than resolving against the CWD', () => {
    expect(() => resolveStoreLocation({ projectRoot: '' })).toThrow(/projectRoot/);
  });
});

describe('module shape', () => {
  it('imports no node:fs — it must be safe to import from L5 with no disk cost', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/from\s+['"]node:fs['"]/);
    expect(source).not.toMatch(/require\(\s*['"](?:node:)?fs['"]\s*\)/);
  });

  it('is the SAME reference state-manager.js re-exports, not a second copy', () => {
    expect(stateManager.resolveStoreLocation).toBe(storeLocation.resolveStoreLocation);
    expect(stateManager.STORE_DIR_NAME).toBe(storeLocation.STORE_DIR_NAME);
    expect(stateManager.FALLBACK_RELATIVE).toBe(storeLocation.FALLBACK_RELATIVE);
  });
});
