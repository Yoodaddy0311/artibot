/**
 * Tests for lib/core/rules-resolver.js (WS-D.3).
 *
 * These tests exercise the resolver against the live canonical CSV store
 * (`plugins/artibot/rules/csv/`) and the live pilot agent .md files
 * (backend-developer, security-reviewer, frontend-developer). When pilot
 * agents are mutated, only the count assertions need to flex.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  _resetResolverCache,
  getAllRules,
  resolveRuleByRef,
  resolveRules,
} from '../../lib/core/rules-resolver.js';
import { getPluginRoot } from '../../lib/core/platform.js';

/**
 * Write a fake agent .md into the live agents dir for one test, and return
 * a cleanup function. Used to cover the "no rules: field" and "malformed ref"
 * paths without polluting the canonical pilot agents.
 *
 * @param {string} name - Agent slug (no .md suffix).
 * @param {string} body - Full file contents.
 * @returns {() => void}
 */
function writeFixtureAgent(name, body) {
  const filePath = path.join(getPluginRoot(), 'agents', `${name}.md`);
  writeFileSync(filePath, body, 'utf-8');
  return () => rmSync(filePath, { force: true });
}

describe('rules-resolver', () => {
  beforeEach(() => {
    _resetResolverCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAllRules', () => {
    it('loads at least 150 rules from the canonical CSV store', async () => {
      const rules = await getAllRules();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThanOrEqual(150);
      // Sanity-check Rule shape on a sample.
      for (const key of ['domain', 'rule_id', 'severity', 'context', 'description', 'rationale']) {
        expect(rules[0]).toHaveProperty(key);
      }
    });

    it('returns the same array on repeat calls (cached)', async () => {
      const a = await getAllRules();
      const b = await getAllRules();
      expect(b).toBe(a);
    });

    it('reloads after _resetResolverCache', async () => {
      const a = await getAllRules();
      _resetResolverCache();
      const b = await getAllRules();
      expect(b).not.toBe(a);
      expect(b.length).toBe(a.length);
    });
  });

  describe('resolveRuleByRef', () => {
    it('returns the matching rule for a known backend ref', async () => {
      const rule = await resolveRuleByRef('backend:input-validation');
      expect(rule).not.toBeNull();
      expect(rule?.domain).toBe('backend');
      expect(rule?.rule_id).toBe('input-validation');
      expect(rule?.severity).toBe('error');
    });

    it('returns the matching rule for a known security ref', async () => {
      const rule = await resolveRuleByRef('security:no-hardcoded-secrets');
      expect(rule).not.toBeNull();
      expect(rule?.domain).toBe('security');
      expect(rule?.rule_id).toBe('no-hardcoded-secrets');
    });

    it('returns null for an unknown domain or rule_id', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const rule = await resolveRuleByRef('nonexistent:xyz');
      expect(rule).toBeNull();
      expect(stderr).toHaveBeenCalled();
    });

    it('returns null and warns on a malformed ref (no colon)', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const rule = await resolveRuleByRef('badref');
      expect(rule).toBeNull();
      expect(stderr).toHaveBeenCalled();
    });

    it('returns null and warns when domain or rule_id half is empty', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      expect(await resolveRuleByRef(':rule-1')).toBeNull();
      expect(await resolveRuleByRef('domain:')).toBeNull();
      expect(stderr).toHaveBeenCalled();
    });
  });

  describe('resolveRules', () => {
    it('resolves the pilot backend-developer agent rules', async () => {
      const rules = await resolveRules('backend-developer');
      expect(rules.length).toBeGreaterThanOrEqual(3);
      const ids = rules.map((r) => `${r.domain}:${r.rule_id}`);
      expect(ids).toContain('backend:input-validation');
      expect(ids).toContain('backend:parameterized-queries');
      expect(ids).toContain('security:no-hardcoded-secrets');
    });

    it('resolves the pilot security-reviewer agent rules', async () => {
      const rules = await resolveRules('security-reviewer');
      expect(rules.length).toBeGreaterThanOrEqual(3);
      const ids = rules.map((r) => `${r.domain}:${r.rule_id}`);
      expect(ids).toContain('security:input-validation');
      expect(ids).toContain('security:password-hashing');
    });

    it('resolves the pilot frontend-developer agent rules', async () => {
      const rules = await resolveRules('frontend-developer');
      expect(rules.length).toBeGreaterThanOrEqual(3);
      const ids = rules.map((r) => `${r.domain}:${r.rule_id}`);
      expect(ids).toContain('frontend:key-prop');
      expect(ids).toContain('accessibility:alt-text');
    });

    it('returns [] for an agent that has no rules: frontmatter field', async () => {
      const cleanup = writeFixtureAgent(
        '__test_no_rules_field',
        `---\nname: __test_no_rules_field\ncapabilities: [thing]\nlifecycle: build\n---\nbody\n`,
      );
      try {
        const rules = await resolveRules('__test_no_rules_field');
        expect(rules).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('returns [] for a missing agent file (warns to stderr)', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const rules = await resolveRules('__definitely-not-an-agent__');
      expect(rules).toEqual([]);
      expect(stderr).toHaveBeenCalled();
    });

    it('skips malformed refs and warns, but resolves valid siblings', async () => {
      const cleanup = writeFixtureAgent(
        '__test_mixed_refs',
        `---\nname: __test_mixed_refs\ncapabilities: [x]\nlifecycle: build\nrules: [badref, backend:input-validation]\n---\nbody\n`,
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const rules = await resolveRules('__test_mixed_refs');
        expect(rules).toHaveLength(1);
        expect(rules[0].rule_id).toBe('input-validation');
        expect(stderr).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('deduplicates when the same ref is listed twice', async () => {
      const cleanup = writeFixtureAgent(
        '__test_dedup',
        `---\nname: __test_dedup\ncapabilities: [x]\nlifecycle: build\nrules: [backend:input-validation, backend:input-validation, security:no-hardcoded-secrets]\n---\nbody\n`,
      );
      try {
        const rules = await resolveRules('__test_dedup');
        expect(rules).toHaveLength(2);
        const ids = rules.map((r) => `${r.domain}:${r.rule_id}`);
        expect(ids).toEqual(['backend:input-validation', 'security:no-hardcoded-secrets']);
      } finally {
        cleanup();
      }
    });

    it('warns on unresolved refs but does not throw', async () => {
      const cleanup = writeFixtureAgent(
        '__test_unresolved',
        `---\nname: __test_unresolved\ncapabilities: [x]\nlifecycle: build\nrules: [backend:does-not-exist]\n---\nbody\n`,
      );
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const rules = await resolveRules('__test_unresolved');
        expect(rules).toEqual([]);
        expect(stderr).toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });
});
