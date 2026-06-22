/**
 * Tests for the genesis post-generation verifier (verifyGenerated). Builds a
 * valid fake artifact set in a mkdtemp root and asserts ok:true, then exercises
 * each check's violation case (missing artifact / broken settings.json /
 * frontmatter-less SKILL.md / `.sh` hook / unloadable `.mjs` hook), and the
 * graceful tolerance of an empty/absent projectRoot (never throws).
 *
 * Local filesystem only — no network.
 * @module tests/genesis/verify-gen
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyGenerated } from '../../lib/genesis/verify-gen.js';

/** Korean-named tmp root, mirroring tests/genesis/no-egress.test.js. */
function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), '제네시스-verify-'));
}

/** Look up a check by its stable `name`. */
function findCheck(res, name) {
  return res.checks.find((c) => c.name === name);
}

/**
 * Materialize a fully valid generated project under `root`:
 * blueprint docs + `.claude/` scaffold (settings.json, a well-formed skill,
 * a `.mjs` hook stub, an agent + command with frontmatter).
 * @param {string} root
 */
async function writeValidProject(root) {
  const docs = path.join(root, 'docs');
  await fs.mkdir(path.join(docs, 'PRD'), { recursive: true });
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Project\n', 'utf-8');
  await fs.writeFile(path.join(docs, 'PRD', 'my-app-2026-06-21.md'), '# PRD\n', 'utf-8');
  await fs.writeFile(path.join(docs, 'FILE-TREE.md'), '# FILE-TREE\n', 'utf-8');
  await fs.writeFile(path.join(docs, 'WORKFLOW.md'), '# WORKFLOW\n', 'utf-8');
  await fs.writeFile(path.join(docs, 'DATASETS.md'), '# DATASETS\n', 'utf-8');
  // A docs-map that enumerates every generated doc under docs/ (check 7).
  await fs.writeFile(
    path.join(docs, 'DOCS-INDEX.md'),
    '# DOCS-INDEX\n\n'
    + '| 상태 | 경로 |\n|---|---|\n'
    + '| 🟢 | `docs/PRD/my-app-2026-06-21.md` |\n'
    + '| 🟢 | `docs/FILE-TREE.md` |\n'
    + '| 🟢 | `docs/WORKFLOW.md` |\n'
    + '| 🟢 | `docs/DATASETS.md` |\n',
    'utf-8',
  );

  const claude = path.join(root, '.claude');
  await fs.mkdir(claude, { recursive: true });
  await fs.writeFile(
    path.join(claude, 'settings.json'),
    JSON.stringify({ hooks: {} }, null, 2),
    'utf-8',
  );

  const skillDir = path.join(claude, 'skills', 'greet');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: greet\ndescription: greets the user\n---\n\n# Greet\n',
    'utf-8',
  );

  const hooksDir = path.join(claude, 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(
    path.join(hooksDir, 'notify.mjs'),
    'export default function notify() { return { ok: true }; }\n',
    'utf-8',
  );

  const agentsDir = path.join(claude, 'agents');
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(
    path.join(agentsDir, 'builder.md'),
    '---\nname: builder\n---\n\nYou build things.\n',
    'utf-8',
  );

  const commandsDir = path.join(claude, 'commands');
  await fs.mkdir(commandsDir, { recursive: true });
  await fs.writeFile(
    path.join(commandsDir, 'ship.md'),
    '---\ndescription: ship it\n---\n\n# /ship\n',
    'utf-8',
  );
}

describe('verify-gen / valid project', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns ok:true with all error checks passing for a valid artifact set', async () => {
    await writeValidProject(root);
    const res = await verifyGenerated({ projectRoot: root });
    expect(res.ok).toBe(true);
    const errorFails = res.checks.filter((c) => c.severity === 'error' && !c.pass);
    expect(errorFails).toEqual([]);
    // Every check carries the documented shape.
    for (const c of res.checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.pass).toBe('boolean');
      expect(['error', 'warn']).toContain(c.severity);
      expect(typeof c.detail).toBe('string');
    }
  });
});

describe('verify-gen / check 1 — required artifacts (error)', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('fails required-artifacts and ok:false when a core doc is missing', async () => {
    await writeValidProject(root);
    await fs.rm(path.join(root, 'docs', 'WORKFLOW.md'));
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'required-artifacts');
    expect(c.pass).toBe(false);
    expect(c.severity).toBe('error');
    expect(c.detail).toContain('WORKFLOW.md');
    expect(res.ok).toBe(false);
  });

  it('fails when the PRD directory has no markdown doc', async () => {
    await writeValidProject(root);
    await fs.rm(path.join(root, 'docs', 'PRD', 'my-app-2026-06-21.md'));
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'required-artifacts');
    expect(c.pass).toBe(false);
    expect(c.detail).toContain('docs/PRD/*');
  });
});

describe('verify-gen / check 2 — settings.json valid (error)', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('fails settings-json-valid and ok:false on broken JSON', async () => {
    await writeValidProject(root);
    await fs.writeFile(path.join(root, '.claude', 'settings.json'), '{ "hooks": ', 'utf-8');
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'settings-json-valid');
    expect(c.pass).toBe(false);
    expect(c.severity).toBe('error');
    expect(res.ok).toBe(false);
  });

  it('fails settings-json-valid when settings.json is absent', async () => {
    await writeValidProject(root);
    await fs.rm(path.join(root, '.claude', 'settings.json'));
    const res = await verifyGenerated({ projectRoot: root });
    expect(findCheck(res, 'settings-json-valid').pass).toBe(false);
  });
});

describe('verify-gen / check 3 — SKILL.md frontmatter (warn)', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('warns (pass:false) on a SKILL.md missing frontmatter, but keeps ok:true', async () => {
    await writeValidProject(root);
    await fs.writeFile(
      path.join(root, '.claude', 'skills', 'greet', 'SKILL.md'),
      '# Greet without frontmatter\n',
      'utf-8',
    );
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'skill-frontmatter');
    expect(c.pass).toBe(false);
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('greet');
    // warn-only ⇒ blueprint still ok.
    expect(res.ok).toBe(true);
  });

  it('warns when SKILL.md has frontmatter but is missing the description field', async () => {
    await writeValidProject(root);
    await fs.writeFile(
      path.join(root, '.claude', 'skills', 'greet', 'SKILL.md'),
      '---\nname: greet\n---\n\n# Greet\n',
      'utf-8',
    );
    const res = await verifyGenerated({ projectRoot: root });
    expect(findCheck(res, 'skill-frontmatter').pass).toBe(false);
  });
});

describe('verify-gen / check 4 — hook extension (warn)', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('warns (pass:false) on a .sh hook, but keeps ok:true', async () => {
    await writeValidProject(root);
    await fs.writeFile(
      path.join(root, '.claude', 'hooks', 'legacy.sh'),
      '#!/bin/sh\necho hi\n',
      'utf-8',
    );
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'hook-mjs-extension');
    expect(c.pass).toBe(false);
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('legacy.sh');
    expect(res.ok).toBe(true);
  });
});

describe('verify-gen / check 5 — agent/command frontmatter (warn)', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('warns when a command markdown lacks frontmatter', async () => {
    await writeValidProject(root);
    await fs.writeFile(
      path.join(root, '.claude', 'commands', 'ship.md'),
      '# /ship without frontmatter\n',
      'utf-8',
    );
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'agent-command-frontmatter');
    expect(c.pass).toBe(false);
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('commands/ship.md');
    expect(res.ok).toBe(true);
  });
});

describe('verify-gen / check 6 — hooks loadable (error)', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('fails hooks-loadable and ok:false on a .mjs hook with a syntax error', async () => {
    await writeValidProject(root);
    await fs.writeFile(
      path.join(root, '.claude', 'hooks', 'broken.mjs'),
      'export default function ( {  // unterminated\n',
      'utf-8',
    );
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'hooks-loadable');
    expect(c.pass).toBe(false);
    expect(c.severity).toBe('error');
    expect(c.detail).toContain('broken.mjs');
    expect(res.ok).toBe(false);
  });

  it('passes hooks-loadable when there are no .mjs hooks (vacuous)', async () => {
    await writeValidProject(root);
    await fs.rm(path.join(root, '.claude', 'hooks', 'notify.mjs'));
    const res = await verifyGenerated({ projectRoot: root });
    expect(findCheck(res, 'hooks-loadable').pass).toBe(true);
  });
});

describe('verify-gen / check 7 — docs-map complete (warn)', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('passes docs-map-complete for a valid project whose DOCS-INDEX lists every doc', async () => {
    await writeValidProject(root);
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'docs-map-complete');
    expect(c.pass).toBe(true);
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('전수 일치');
    expect(res.ok).toBe(true);
  });

  it('warns (pass:false) when a generated doc is absent from DOCS-INDEX, keeps ok:true', async () => {
    await writeValidProject(root);
    // Add an extra doc that the docs-map does NOT enumerate.
    await fs.writeFile(path.join(root, 'docs', 'API-SPEC.md'), '# API\n', 'utf-8');
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'docs-map-complete');
    expect(c.pass).toBe(false);
    expect(c.severity).toBe('warn');
    expect(c.detail).toContain('API-SPEC.md');
    // warn-only ⇒ blueprint still ok.
    expect(res.ok).toBe(true);
  });

  it('falls back to CLAUDE.md as the docs-map when DOCS-INDEX is absent', async () => {
    await writeValidProject(root);
    await fs.rm(path.join(root, 'docs', 'DOCS-INDEX.md'));
    // CLAUDE.md (the fallback map) does NOT list the docs → warn.
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'docs-map-complete');
    expect(c.pass).toBe(false);
    expect(c.detail).toContain('CLAUDE.md');
    expect(res.ok).toBe(true);
  });

  it('passes vacuously when docs/ has no markdown to track', async () => {
    // .claude scaffold only, no docs/ markdown.
    const claude = path.join(root, '.claude');
    await fs.mkdir(claude, { recursive: true });
    const res = await verifyGenerated({ projectRoot: root });
    const c = findCheck(res, 'docs-map-complete');
    expect(c.pass).toBe(true);
    expect(c.detail).toContain('생략');
  });

  it('matches docs listed by bare filename only (not full relative path)', async () => {
    await writeValidProject(root);
    await fs.writeFile(path.join(root, 'docs', 'EXTRA.md'), '# extra\n', 'utf-8');
    // Map references the new doc by bare filename only.
    await fs.writeFile(
      path.join(root, 'docs', 'DOCS-INDEX.md'),
      '# DOCS-INDEX\n\n'
      + '`docs/PRD/my-app-2026-06-21.md` `docs/FILE-TREE.md` `docs/WORKFLOW.md` '
      + '`docs/DATASETS.md` `EXTRA.md`\n',
      'utf-8',
    );
    const res = await verifyGenerated({ projectRoot: root });
    expect(findCheck(res, 'docs-map-complete').pass).toBe(true);
  });
});

describe('verify-gen / graceful tolerance', () => {
  it('does not throw and returns ok:false when projectRoot is omitted', async () => {
    await expect(verifyGenerated()).resolves.toBeDefined();
    const res = await verifyGenerated();
    expect(res.ok).toBe(false);
    expect(Array.isArray(res.checks)).toBe(true);
    expect(findCheck(res, 'project-root').pass).toBe(false);
  });

  it('does not throw on an empty/nonexistent projectRoot; required-artifacts fails', async () => {
    const root = tmpRoot();
    try {
      const res = await verifyGenerated({ projectRoot: root });
      expect(typeof res.ok).toBe('boolean');
      expect(Array.isArray(res.checks)).toBe(true);
      // Empty root ⇒ every required artifact missing ⇒ error check fails ⇒ not ok.
      expect(findCheck(res, 'required-artifacts').pass).toBe(false);
      expect(res.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tolerates a projectRoot pointing at a non-existent path', async () => {
    const ghost = path.join(os.tmpdir(), '제네시스-does-not-exist-zzz', 'sub');
    const res = await verifyGenerated({ projectRoot: ghost });
    expect(typeof res.ok).toBe('boolean');
    expect(res.ok).toBe(false);
  });
});
