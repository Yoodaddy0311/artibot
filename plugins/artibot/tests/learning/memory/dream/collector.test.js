import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCollector } from '../../../../lib/learning/memory/dream/collector.js';

let tmpDir;

function doc({ name, type, body, desc = 'hook', session = 's1', extraLink = '' }) {
  return `---
name: ${name}
description: ${desc}
metadata:
  node_type: memory
  type: ${type}
  originSessionId: ${session}
---

# ${name}

${body}
${extraLink}
`;
}

async function writeMemory(dir, file, content) {
  await fs.writeFile(path.join(dir, file), content, 'utf-8');
}

async function hashAll(dir) {
  const out = {};
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile()) {
      const raw = await fs.readFile(path.join(dir, e.name), 'utf-8');
      out[e.name] = createHash('sha256').update(raw).digest('hex');
    }
  }
  return out;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-collector-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('createCollector', () => {
  it('requires memoryDir', () => {
    expect(() => createCollector({})).toThrow();
  });

  it('collects memories + index rows + external signals read-only', async () => {
    const memDir = path.join(tmpDir, 'memory');
    const projDir = path.join(tmpDir, 'proj');
    await fs.mkdir(memDir, { recursive: true });
    await fs.mkdir(path.join(projDir, '.artibot', 'handoffs'), { recursive: true });
    await writeMemory(memDir, 'a.md', doc({ name: 'a', type: 'project', body: 'release ci ship' }));
    await fs.writeFile(path.join(memDir, 'MEMORY.md'),
      '# Project Memory\n\n- [A](a.md) — hook\n', 'utf-8');
    await fs.writeFile(path.join(projDir, '.artibot', 'handoffs', 'h1.md'), '# handoff', 'utf-8');
    await fs.writeFile(path.join(projDir, '.artibot', 'SESSION-NOTES.md'), 'notes', 'utf-8');

    const before = await hashAll(memDir);
    const collector = createCollector({ memoryDir: memDir, projectDir: projDir });
    const result = await collector.collect();

    expect(result.memories).toHaveLength(1);
    expect(result.indexRows).toHaveLength(1);
    const kinds = result.signals.map((s) => s.kind).sort();
    expect(kinds).toEqual(['handoff', 'session-notes']);
    expect(result.signals.every((s) => s.externalSignal === true)).toBe(true);
    // Read-only proof
    expect(await hashAll(memDir)).toEqual(before);
  });

  it('includes ambient ledger conversation as a read-only signal (F-08 D1)', async () => {
    const memDir = path.join(tmpDir, 'memory');
    const projDir = path.join(tmpDir, 'proj');
    await fs.mkdir(memDir, { recursive: true });
    await fs.mkdir(path.join(projDir, '.artibot', 'ledger'), { recursive: true });
    const line = (role, text) => JSON.stringify({
      type: role,
      message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    });
    await fs.writeFile(
      path.join(projDir, '.artibot', 'ledger', 's1.jsonl'),
      `${line('user', 'how do I ship a release')}\n${line('assistant', 'use the /ship command')}\n`,
      'utf-8',
    );

    const collector = createCollector({ memoryDir: memDir, projectDir: projDir });
    const result = await collector.collect();

    const ledger = result.signals.filter((s) => s.kind === 'ledger');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].externalSignal).toBe(true);
    expect(ledger[0].text).toContain('how do I ship a release');
    expect(ledger[0].text).toContain('use the /ship command');
    expect(ledger[0].source).toContain('s1.jsonl');
    expect(typeof ledger[0].hash).toBe('string');
  });

  it('adds NO ledger signal when the ledger dir is absent', async () => {
    const memDir = path.join(tmpDir, 'memory');
    const projDir = path.join(tmpDir, 'proj');
    await fs.mkdir(memDir, { recursive: true });
    await fs.mkdir(path.join(projDir, '.artibot'), { recursive: true });
    const collector = createCollector({ memoryDir: memDir, projectDir: projDir });
    const result = await collector.collect();
    expect(result.signals.some((s) => s.kind === 'ledger')).toBe(false);
  });
});
