import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  computeHash,
  extractSkillBody,
  readSkillFrontmatter,
  verifyHash,
} from '../../lib/core/skill-hash.js';

describe('skill-hash', () => {
  describe('computeHash', () => {
    it('returns a deterministic 8-char hex string', () => {
      const a = computeHash('hello world');
      const b = computeHash('hello world');
      expect(a).toBe(b);
      expect(a).toHaveLength(8);
      expect(/^[0-9a-f]{8}$/.test(a)).toBe(true);
    });

    it('normalizes CRLF to LF before hashing', () => {
      const lf = computeHash('line1\nline2');
      const crlf = computeHash('line1\r\nline2');
      expect(lf).toBe(crlf);
    });

    it('strips trailing whitespace before hashing', () => {
      const a = computeHash('content');
      const b = computeHash('content   \n\n');
      expect(a).toBe(b);
    });

    it('produces different hashes for different content', () => {
      expect(computeHash('foo')).not.toBe(computeHash('bar'));
    });
  });

  describe('extractSkillBody', () => {
    it('returns text unchanged when no frontmatter', () => {
      expect(extractSkillBody('plain body')).toBe('plain body');
    });

    it('strips a well-formed frontmatter block', () => {
      const raw = '---\nname: test\ndescription: x\n---\nBody here\nmore';
      expect(extractSkillBody(raw)).toBe('Body here\nmore');
    });

    it('returns text unchanged when only opening fence', () => {
      const raw = '---\nname: incomplete\nbody never closes';
      expect(extractSkillBody(raw)).toBe(raw);
    });

    it('handles CRLF line endings', () => {
      const raw = '---\r\nname: test\r\n---\r\nbody';
      expect(extractSkillBody(raw)).toBe('body');
    });
  });

  describe('readSkillFrontmatter', () => {
    let tmpDir;
    function makeFile(content) {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'skill-hash-test-'));
      const file = path.join(tmpDir, 'SKILL.md');
      writeFileSync(file, content, 'utf-8');
      return file;
    }
    function cleanup() {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }

    it('parses key/value pairs from frontmatter', async () => {
      const file = makeFile('---\nname: foo\ndescription: bar baz\n---\nbody');
      try {
        const { frontmatter, body } = await readSkillFrontmatter(file);
        expect(frontmatter.name).toBe('foo');
        expect(frontmatter.description).toBe('bar baz');
        expect(body).toBe('body');
      } finally {
        cleanup();
      }
    });

    it('returns empty frontmatter when none present', async () => {
      const file = makeFile('just body content');
      try {
        const { frontmatter, body } = await readSkillFrontmatter(file);
        expect(frontmatter).toEqual({});
        expect(body).toBe('just body content');
      } finally {
        cleanup();
      }
    });
  });

  describe('verifyHash', () => {
    let tmpDir;
    function makeFile(content) {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'skill-hash-verify-'));
      const file = path.join(tmpDir, 'SKILL.md');
      writeFileSync(file, content, 'utf-8');
      return file;
    }
    function cleanup() {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }

    it('reports match when stored hash equals current', async () => {
      const body = 'consistent body content';
      const expectedHash = computeHash(body);
      const file = makeFile(`---\nname: ok\nsource_hash: ${expectedHash}\n---\n${body}`);
      try {
        const result = await verifyHash(file);
        expect(result.match).toBe(true);
        expect(result.stored).toBe(expectedHash);
        expect(result.current).toBe(expectedHash);
      } finally {
        cleanup();
      }
    });

    it('reports mismatch when stored is stale', async () => {
      const file = makeFile('---\nname: stale\nsource_hash: 00000000\n---\nbody');
      try {
        const result = await verifyHash(file);
        expect(result.match).toBe(false);
        expect(result.stored).toBe('00000000');
        expect(result.current).not.toBe('00000000');
      } finally {
        cleanup();
      }
    });

    it('reports null stored when source_hash absent', async () => {
      const file = makeFile('---\nname: nohash\n---\nbody');
      try {
        const result = await verifyHash(file);
        expect(result.stored).toBeNull();
        expect(result.match).toBe(false);
      } finally {
        cleanup();
      }
    });
  });
});
