import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  createMemoryMdAdapter,
  indexRowFor,
  parseIndex,
  parseMemoryDoc,
  serializeIndex,
  serializeMemoryDoc,
} from '../../../../lib/learning/memory/dream/memory-md-adapter.js';

// ---------------------------------------------------------------------------
// Fixture helpers — every test uses an isolated OS temp dir. The real
// ~/.claude/projects/.../memory is NEVER touched (PRD acceptance #10).
// ---------------------------------------------------------------------------

let tmpDir;

const DOC = `---
name: v4-16-release
description: "v4.16.0 release — social-media depth 4"
metadata:
  node_type: memory
  type: project
  originSessionId: f203a901-7ed7-4b23
---

## v4.16.0 Release

Body text with a [[benchmark-2026-05-28]] link and another [[other-note]].

**Why:** parallel team execution.
`;

const INDEX = `# Project Memory

- [Project: Artibot](project_artibot.md) — Claude Code 플러그인
- [Release v4.16.0](project_v4_16_release.md) — social-media depth 4
`;

async function hashFile(p) {
  const raw = await fs.readFile(p, 'utf-8');
  return createHash('sha256').update(raw).digest('hex');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-adapter-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('parseMemoryDoc', () => {
  it('extracts frontmatter, metadata, body, and links', () => {
    const rec = parseMemoryDoc(DOC, 'project_v4_16_release.md');
    expect(rec.name).toBe('v4-16-release');
    expect(rec.description).toBe('v4.16.0 release — social-media depth 4');
    expect(rec.nodeType).toBe('memory');
    expect(rec.type).toBe('project');
    expect(rec.originSessionId).toBe('f203a901-7ed7-4b23');
    expect(rec.links).toEqual(['benchmark-2026-05-28', 'other-note']);
    expect(rec.body).toContain('## v4.16.0 Release');
  });

  it('handles a doc with no frontmatter', () => {
    const rec = parseMemoryDoc('just a body', 'x.md');
    expect(rec.name).toBe('x');
    expect(rec.body).toBe('just a body');
    expect(rec.links).toEqual([]);
  });

  it('de-duplicates repeated links preserving order', () => {
    const rec = parseMemoryDoc('a [[one]] b [[two]] c [[one]]', 'y.md');
    expect(rec.links).toEqual(['one', 'two']);
  });
});

describe('serializeMemoryDoc round-trip', () => {
  it('parse -> serialize -> parse is identity on structured fields', () => {
    const rec1 = parseMemoryDoc(DOC, 'project_v4_16_release.md');
    const text = serializeMemoryDoc(rec1);
    const rec2 = parseMemoryDoc(text, 'project_v4_16_release.md');
    expect(rec2.name).toBe(rec1.name);
    expect(rec2.description).toBe(rec1.description);
    expect(rec2.metadata).toEqual(rec1.metadata);
    expect(rec2.body.trim()).toBe(rec1.body.trim());
    expect(rec2.links).toEqual(rec1.links);
  });

  it('reconstructs frontmatter from flat fields when front/metadata absent', () => {
    const text = serializeMemoryDoc({
      name: 'n', description: 'd', nodeType: 'memory', type: 'feedback',
      originSessionId: 's1', body: '\nhello\n',
    });
    const rec = parseMemoryDoc(text, 'n.md');
    expect(rec.name).toBe('n');
    expect(rec.type).toBe('feedback');
    expect(rec.body.trim()).toBe('hello');
  });
});

describe('MEMORY.md index', () => {
  it('parseIndex reads the 1-line format', () => {
    const rows = parseIndex(INDEX);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      title: 'Project: Artibot', file: 'project_artibot.md', hook: 'Claude Code 플러그인',
    });
  });

  it('serializeIndex round-trips parseIndex', () => {
    const rows = parseIndex(INDEX);
    const text = serializeIndex(rows);
    expect(parseIndex(text)).toEqual(rows);
    expect(text.startsWith('# Project Memory')).toBe(true);
  });

  it('indexRowFor derives title from first heading and hook from description', () => {
    const rec = parseMemoryDoc(DOC, 'project_v4_16_release.md');
    const row = indexRowFor(rec);
    expect(row.title).toBe('v4.16.0 Release');
    expect(row.file).toBe('project_v4_16_release.md');
    expect(row.hook).toBe('v4.16.0 release — social-media depth 4');
  });
});

describe('createMemoryMdAdapter (directory-bound, injected memoryDir)', () => {
  it('requires memoryDir', () => {
    expect(() => createMemoryMdAdapter({})).toThrow();
  });

  it('readAll parses every memory md except MEMORY.md', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.md'), DOC, 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'MEMORY.md'), INDEX, 'utf-8');
    const adapter = createMemoryMdAdapter({ memoryDir: tmpDir });
    const records = await adapter.readAll();
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('v4-16-release');
  });

  it('readAll NEVER modifies source files (hash unchanged)', async () => {
    const aPath = path.join(tmpDir, 'a.md');
    await fs.writeFile(aPath, DOC, 'utf-8');
    const before = await hashFile(aPath);
    const adapter = createMemoryMdAdapter({ memoryDir: tmpDir });
    await adapter.readAll();
    await adapter.readIndex();
    const after = await hashFile(aPath);
    expect(after).toBe(before);
  });

  it('writeDoc writes only to the supplied target path (staging)', async () => {
    const adapter = createMemoryMdAdapter({ memoryDir: tmpDir });
    const target = path.join(adapter.stagingDir, 'staged.md');
    await adapter.writeDoc(target, DOC);
    const exists = await fs.readFile(target, 'utf-8');
    expect(exists).toContain('v4-16-release');
    // Source dir gained only the staging subtree, no sibling md.
    const top = await fs.readdir(tmpDir);
    expect(top).toEqual(['.dream-staging']);
  });

  it('regenerateIndex drops vanished files and appends new ones, preserving order', async () => {
    await fs.writeFile(path.join(tmpDir, 'project_artibot.md'),
      '---\nname: artibot\ndescription: hook one\n---\n\n# Project: Artibot\n', 'utf-8');
    await fs.writeFile(path.join(tmpDir, 'project_v4_16_release.md'),
      '---\nname: rel\ndescription: depth 4\n---\n\n# Release v4.16.0\n', 'utf-8');
    const adapter = createMemoryMdAdapter({ memoryDir: tmpDir });
    const records = await adapter.readAll();
    const priorIndex = parseIndex(INDEX);
    const text = adapter.regenerateIndex(records, { preserveOrderFrom: priorIndex });
    const rows = parseIndex(text);
    expect(rows.map((r) => r.file)).toEqual([
      'project_artibot.md', 'project_v4_16_release.md',
    ]);
    expect(rows[0].hook).toBe('hook one');
  });
});
