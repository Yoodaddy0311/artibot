import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(TEST_DIR, '..', '..', 'scripts', 'hooks');

const {
  todayStamp,
  readLastDate,
  writeGate,
  loadMetaSkill,
  formatInjectContext,
  decide,
} = await import('../../scripts/hooks/skill-discovery-inject.js');

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'artibot-skill-disc-'));
}

describe('skill-discovery-inject hook', () => {
  let tmp;

  beforeEach(() => { tmp = makeTempDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  describe('todayStamp()', () => {
    it('returns YYYY-MM-DD format', () => {
      const stamp = todayStamp();
      expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('has 4-digit year, zero-padded month and day', () => {
      const stamp = todayStamp();
      const [y, m, d] = stamp.split('-');
      expect(y.length).toBe(4);
      expect(m.length).toBe(2);
      expect(d.length).toBe(2);
    });
  });

  describe('readLastDate() / writeGate()', () => {
    it('returns empty string when the gate file does not exist', async () => {
      const v = await readLastDate(path.join(tmp, 'missing.txt'));
      expect(v).toBe('');
    });

    it('persists and reads back today\'s stamp', async () => {
      const filePath = path.join(tmp, 'last.txt');
      await writeGate(filePath, '2026-04-28');
      const v = await readLastDate(filePath);
      expect(v).toBe('2026-04-28');
    });

    it('creates parent directories during writeGate', async () => {
      const filePath = path.join(tmp, 'nested', 'deeper', 'last.txt');
      await writeGate(filePath, '2026-04-28');
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('loadMetaSkill()', () => {
    it('returns empty string when SKILL.md is missing', async () => {
      const body = await loadMetaSkill(tmp);
      expect(body).toBe('');
    });

    it('loads the SKILL.md when present', async () => {
      const skillsDir = path.join(tmp, 'skills', 'using-agent-skills');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(path.join(skillsDir, 'SKILL.md'), '---\nname: test\n---\nhello');
      const body = await loadMetaSkill(tmp);
      expect(body).toContain('hello');
    });
  });

  describe('formatInjectContext()', () => {
    it('strips YAML frontmatter', () => {
      const ctx = formatInjectContext('---\nname: x\n---\nbody text');
      expect(ctx).not.toContain('name: x');
      expect(ctx).toContain('body text');
    });

    it('returns empty string for empty input', () => {
      expect(formatInjectContext('')).toBe('');
    });

    it('includes the discovery prefix marker', () => {
      const ctx = formatInjectContext('# header');
      expect(ctx).toContain('[artibot:skill-discovery]');
    });
  });

  describe('decide()', () => {
    it('returns continue-only when today\'s stamp matches lastDate', () => {
      const r = decide({
        pluginRoot: '/x',
        stamp: '2026-04-28',
        lastDate: '2026-04-28',
        skillBody: '---\nname: meta\n---\nbody',
      });
      expect(r.output).toEqual({ continue: true });
      expect(r.shouldWriteGate).toBe(false);
    });

    it('injects when lastDate is empty (first session ever)', () => {
      const r = decide({
        pluginRoot: '/x',
        stamp: '2026-04-28',
        lastDate: '',
        skillBody: '---\nname: meta\n---\nflow',
      });
      expect(r.output.continue).toBe(true);
      expect(r.output.hookSpecificOutput).toBeDefined();
      expect(r.output.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(r.output.hookSpecificOutput.additionalContext).toContain('flow');
      expect(r.shouldWriteGate).toBe(true);
    });

    it('injects when lastDate is yesterday', () => {
      const r = decide({
        pluginRoot: '/x',
        stamp: '2026-04-28',
        lastDate: '2026-04-27',
        skillBody: '---\nname: meta\n---\nbody',
      });
      expect(r.output.hookSpecificOutput).toBeDefined();
      expect(r.shouldWriteGate).toBe(true);
    });

    it('still writes the gate but skips inject when skillBody is empty', () => {
      const r = decide({
        pluginRoot: '/x',
        stamp: '2026-04-28',
        lastDate: '',
        skillBody: '',
      });
      expect(r.output).toEqual({ continue: true });
      expect(r.shouldWriteGate).toBe(true);
    });
  });

  describe('no-egress invariant', () => {
    it('source must not import HTTP/fetch APIs', () => {
      const src = readFileSync(path.join(HOOKS_DIR, 'skill-discovery-inject.js'), 'utf-8');
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/from\s+['"]node:https?['"]/);
      expect(src).not.toMatch(/require\(['"]node:https?['"]\)/);
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
    });
  });
});
