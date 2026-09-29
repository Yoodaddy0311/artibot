/**
 * Shared fixtures for the CA-08 read-order guard tests. **A library, not a
 * test** — the file name has no `.test.` so vitest's `include` does not collect
 * it (same arrangement as `tests/firewall/citation-resolution.js`).
 *
 * WHY REAL SERIALIZERS AND A REAL STORE. The guard judges files the runtime
 * writes and a store the runtime keeps. A hand-written `plan.md` would pin the
 * tests to a format the writer could drift away from; every artifact here is
 * rendered by the real `serializePlanMd` / `serializeReviewMd` /
 * `serializeOutcomeMd`, and the store is seeded through `createStateStore`.
 *
 * WHY SENTINELS. `PLAN_MARK` and `OUTCOME_MARK` exist only inside a rendered
 * body, never in a reason line, so "the body is not in stdout" is an assertion
 * about a string that IS in the file on disk.
 *
 * @module tests/checkpoint/read-order-guard-fixtures
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';

import { serializeOutcomeMd } from '../../lib/mission/outcome-artifact.js';
import { serializePlanMd } from '../../lib/planning/plan-artifact.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { serializeReviewMd } from '../../lib/review/review-artifact.js';

export const MISSION = 'M-20260929-001';
export const TS = '2026-09-29T00:00:00.000Z';
export const ACTOR = { type: 'agent', id: 'fixture' };

/** Repo-relative path of a mission artifact, as the CLI prints it. */
export const REL = (name) => `.artibot/missions/${MISSION}/${name}`;

/** Unique strings that exist ONLY inside a fixture's rendered body. */
export const PLAN_MARK = 'PLAN-BODY-SENTINEL-7f3a91';
export const OUTCOME_MARK = 'OUTCOME-BODY-SENTINEL-c20d55';

/** Headings and section names that exist only in the rendered bodies. */
export const BODY_FRAGMENTS = ['# Plan', 'Work decomposition', '# Review', '## Verdict', '# Outcome', 'Accepted Result'];

/** A config that switches the guard on. */
export const ON = Object.freeze({ runtime: { resume: { staleGuard: true } } });

/** @type {string[]} */
const created = [];

/**
 * Temp dir with Windows 8.3 short names collapsed, so printed paths compare.
 *
 * @param {string} prefix - Directory name prefix.
 * @returns {string} Canonical absolute path.
 */
export function tempDir(prefix) {
  const canonicalise = realpathSync.native || realpathSync;
  const dir = canonicalise(mkdtempSync(path.join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

/** Remove every temp dir this module handed out. Call from `afterAll`. */
export function cleanupTempDirs() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Render a `plan.md`.
 *
 * @param {{revision?: number, intent?: number, marker?: string, lines?: string[]|null}} [spec] - Overrides.
 * @returns {string} File text.
 */
export function planText({ revision = 5, intent = 3, marker = PLAN_MARK, lines = null } = {}) {
  return serializePlanMd({
    missionId: MISSION,
    revision,
    basedOn: { intentRevision: intent },
    actor: ACTOR,
    ts: TS,
    sections: { decomposition: lines ?? marker },
  });
}

/**
 * Render a `review.md`. `plan: null` omits the plan edge entirely.
 *
 * @param {{revision?: number, intent?: number, plan?: number|null}} [spec] - Overrides.
 * @returns {string} File text.
 */
export function reviewText({ revision = 1, intent = 3, plan = 5 } = {}) {
  return serializeReviewMd({
    missionId: MISSION,
    verdict: 'PASS',
    findingsRef: 'transcript:fixture',
    verificationId: 'v-fixture-1',
    revision,
    basedOn: plan === null ? { intentRevision: intent } : { intentRevision: intent, planRevision: plan },
    ts: TS,
  });
}

/**
 * Render an `outcome.md`.
 *
 * @param {{intent?: number, plan?: number, review?: number, marker?: string}} [spec] - Overrides.
 * @returns {string} File text.
 */
export function outcomeText({ intent = 3, plan = 5, review = 1, marker = OUTCOME_MARK } = {}) {
  return serializeOutcomeMd({
    missionId: MISSION,
    basedOn: { intentRevision: intent, planRevision: plan, reviewRevision: review },
    verificationId: 'v-fixture-1',
    evidenceRefs: [],
    accepted: true,
    actor: ACTOR,
    ts: TS,
    sections: { accepted_result: marker },
  });
}

/**
 * Seed a REAL store with one mission at the given live revisions.
 *
 * @param {string} projectRoot - Temp project root.
 * @param {{intent: number, plan: number}} live - Live revisions the store holds.
 * @returns {void}
 */
export function seedStore(projectRoot, { intent, plan }) {
  const store = createStateStore({
    projectRoot,
    sessionId: 'fixture-seed',
    appendEvent: () => ({ ok: true }),
  });
  const res = store.updateMission(
    MISSION,
    () => ({
      status: 'executing',
      intent: { path: 'intent.md', revision: intent },
      plan: { path: 'plan.md', revision: plan },
    }),
    { reason: 'fixture seed', graph: { schema_version: 1, mission_id: MISSION, tasks: [] } },
  );
  // Fail loudly: an unseeded store would turn every "current" assertion into a
  // statement about a project the CLI could not judge.
  expect(res.ok, `seed: ${JSON.stringify(res.errors ?? [])}`).toBe(true);
}

/**
 * Build a temp project: optionally a seeded store, plus the named artifacts.
 *
 * @param {{live?: {intent: number, plan: number}|null, files?: Record<string, string>}} [spec] - Contents.
 * @returns {string} Project root.
 */
export function makeProject({ live = null, files = {} } = {}) {
  const root = tempDir('artibot-read-order-guard-');
  if (live !== null) seedStore(root, live);
  const dir = path.join(root, '.artibot', 'missions', MISSION);
  if (Object.keys(files).length > 0) mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text, 'utf-8');
  return root;
}

/**
 * A plugin root holding only a config file. `config === undefined` and no
 * `raw` means no config file at all.
 *
 * @param {object|undefined} config - JSON-serialisable config.
 * @param {{raw?: string|null}} [opts] - Write these exact bytes instead.
 * @returns {string} Plugin root.
 */
export function makePluginRoot(config, { raw = null } = {}) {
  const dir = tempDir('artibot-read-order-guard-plugin-');
  if (raw !== null) writeFileSync(path.join(dir, 'artibot.config.json'), raw, 'utf-8');
  else if (config !== undefined) writeFileSync(path.join(dir, 'artibot.config.json'), JSON.stringify(config), 'utf-8');
  return dir;
}

/**
 * Content census of a tree: relative path -> size + sha256. Compared whole, so
 * a new file, a deleted file and an edited file are three distinct failures.
 *
 * @param {string} dir - Tree root.
 * @returns {Record<string, {size: number, sha256: string}>} Census.
 */
export function census(dir) {
  /** @type {Record<string, {size: number, sha256: string}>} */
  const out = {};
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      out[path.relative(dir, full).split(path.sep).join('/')] = {
        size: statSync(full).size,
        sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
      };
    }
  };
  walk(dir);
  return out;
}
