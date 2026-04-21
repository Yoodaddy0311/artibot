import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  approveSuggestion,
  extractActions,
  getMacroSuggestions,
  observePrompt,
  redactSensitive,
  rejectSuggestion,
} from '../../lib/learning/macro-learner.js';

// Avoid literal secret-shaped strings in source. The redaction patterns look
// for `sk-` / `AIza` / `ghp_` prefixes, so we build sample strings at runtime.
const FAKE_KEY_PREFIX = ['s', 'k', '-'].join('');
const FAKE_API_KEY = `${FAKE_KEY_PREFIX}abcdefghijkl1234567`;

function makeConfig(overrides = {}) {
  return {
    ago: {
      macroLearning: {
        enabled: true,
        mode: 'suggest-only',
        minOccurrences: 3,
        requireUserApproval: true,
        suggestionsPath: 'runtime/macro-suggestions.json',
        ...overrides,
      },
    },
  };
}

describe('macro-learner', () => {
  let root;
  let config;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'artibot-macro-'));
    writeFileSync(
      path.join(root, 'artibot.config.json'),
      JSON.stringify({ version: '0.0.0' }, null, 2),
      'utf-8',
    );
    mkdirSync(path.join(root, 'runtime'), { recursive: true });
    config = makeConfig();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('extractActions', () => {
    it('extracts ordered Korean + English actions from one prompt', () => {
      // "배포 전에 보안 체크하고 테스트 돌려"
      const actions = extractActions('\uBC30\uD3EC \uC804\uC5D0 \uBCF4\uC548 \uCCB4\uD06C\uD558\uACE0 \uD14C\uC2A4\uD2B8 \uB3CC\uB824');
      expect(actions).toContain('security-review');
      expect(actions).toContain('test');
      expect(actions).toContain('deploy');
      expect(actions.indexOf('security-review')).toBeLessThan(actions.indexOf('test'));
    });

    it('returns fewer than 2 actions for trivial prompts', () => {
      expect(extractActions('hi').length).toBeLessThan(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('redactSensitive', () => {
    it('redacts API keys', () => {
      const out = redactSensitive(`my key is ${FAKE_API_KEY} here`);
      expect(out).toContain('[redacted:key]');
      expect(out).not.toContain(FAKE_API_KEY);
    });

    it('redacts windows paths', () => {
      const out = redactSensitive('look at C:\\Users\\alice\\secret.txt please');
      expect(out).toContain('[redacted:path]');
    });

    it('redacts emails', () => {
      const out = redactSensitive('contact me: alice@example.com');
      expect(out).toContain('[redacted:email]');
    });
  });

  // -------------------------------------------------------------------------
  describe('observePrompt', () => {
    it('records a single observation without producing a suggestion', async () => {
      const r = await observePrompt('security review then run tests', {
        pluginRoot: root,
        config,
      });
      expect(r.observed).toBe(true);
      expect(r.suggestionId).toBeUndefined();

      const suggestions = await getMacroSuggestions(root, config);
      expect(suggestions.length).toBe(0);
    });

    it('does not create a suggestion before minOccurrences is reached', async () => {
      await observePrompt('security test build', { pluginRoot: root, config });
      await observePrompt('security test build again', { pluginRoot: root, config });
      const suggestions = await getMacroSuggestions(root, config);
      expect(suggestions.length).toBe(0);
    });

    it('creates a pending suggestion after 3 repetitions', async () => {
      for (let i = 0; i < 3; i++) {
        await observePrompt('security then test then build', {
          pluginRoot: root,
          config,
        });
      }
      const suggestions = await getMacroSuggestions(root, config);
      expect(suggestions.length).toBe(1);
      expect(suggestions[0].status).toBe('pending');
      expect(suggestions[0].pattern.actions).toEqual(
        expect.arrayContaining(['security-review', 'test', 'build']),
      );
      expect(suggestions[0].pattern.occurrences).toBeGreaterThanOrEqual(3);
    });

    it('ignores prompts when enabled=false', async () => {
      const disabled = makeConfig({ enabled: false });
      for (let i = 0; i < 5; i++) {
        await observePrompt('security test build', { pluginRoot: root, config: disabled });
      }
      const suggestions = await getMacroSuggestions(root, disabled);
      expect(suggestions.length).toBe(0);
    });

    it('redacts sensitive data from stored triggerPhrase', async () => {
      const prompt = `security review with key ${FAKE_API_KEY} and test`;
      for (let i = 0; i < 3; i++) {
        await observePrompt(prompt, { pluginRoot: root, config });
      }
      const suggestions = await getMacroSuggestions(root, config);
      expect(suggestions.length).toBe(1);
      expect(suggestions[0].pattern.triggerPhrase).not.toContain(FAKE_API_KEY);
      expect(suggestions[0].pattern.triggerPhrase).toContain('[redacted:key]');
    });
  });

  // -------------------------------------------------------------------------
  describe('approveSuggestion', () => {
    async function seedPendingSuggestion() {
      for (let i = 0; i < 3; i++) {
        await observePrompt('security test build', { pluginRoot: root, config });
      }
      const [s] = await getMacroSuggestions(root, config);
      return s;
    }

    it('registers the macro in artibot.config.json on approval', async () => {
      const s = await seedPendingSuggestion();
      const result = await approveSuggestion(s.id, { pluginRoot: root, config });
      expect(result.registered).toBe(true);
      expect(result.macroId).toMatch(/^m_/);

      const cfg = JSON.parse(readFileSync(path.join(root, 'artibot.config.json'), 'utf-8'));
      expect(cfg.macros).toBeDefined();
      expect(cfg.macros[result.macroId]).toBeDefined();
      expect(cfg.macros[result.macroId].actions).toEqual(
        expect.arrayContaining(['security-review', 'test', 'build']),
      );
      expect(cfg.macros[result.macroId].suggestionId).toBe(s.id);
    });

    it('marks the suggestion as approved after registration', async () => {
      const s = await seedPendingSuggestion();
      await approveSuggestion(s.id, { pluginRoot: root, config });
      const suggestions = await getMacroSuggestions(root, config);
      expect(suggestions[0].status).toBe('approved');
      expect(suggestions[0].approvedAt).toBeTruthy();
    });

    it('refuses to register when requireUserApproval=false (auto-register guard)', async () => {
      const s = await seedPendingSuggestion();
      const unsafeConfig = makeConfig({ requireUserApproval: false });
      const result = await approveSuggestion(s.id, { pluginRoot: root, config: unsafeConfig });
      expect(result.registered).toBe(false);
      expect(result.reason).toBe('auto-register-forbidden');

      const cfg = JSON.parse(readFileSync(path.join(root, 'artibot.config.json'), 'utf-8'));
      expect(cfg.macros).toBeUndefined();
    });

    it('refuses to register when mode is not suggest-only', async () => {
      const s = await seedPendingSuggestion();
      const unsafeConfig = makeConfig({ mode: 'auto' });
      const result = await approveSuggestion(s.id, { pluginRoot: root, config: unsafeConfig });
      expect(result.registered).toBe(false);
      expect(result.reason).toBe('unsafe-mode');
    });

    it('rejects forbidden suggestion ids (prototype pollution guard)', async () => {
      const result = await approveSuggestion('__proto__', { pluginRoot: root, config });
      expect(result.registered).toBe(false);
      expect(result.reason).toBe('forbidden-id');
    });
  });

  // -------------------------------------------------------------------------
  describe('rejectSuggestion', () => {
    it('marks suggestion rejected and does not re-propose the same pattern', async () => {
      for (let i = 0; i < 3; i++) {
        await observePrompt('security test build', { pluginRoot: root, config });
      }
      const [s] = await getMacroSuggestions(root, config);
      const r = await rejectSuggestion(s.id, { pluginRoot: root, config });
      expect(r.rejected).toBe(true);

      for (let i = 0; i < 3; i++) {
        await observePrompt('security test build', { pluginRoot: root, config });
      }
      const suggestions = await getMacroSuggestions(root, config);
      const pendingForSamePattern = suggestions.filter(
        (x) => x.status === 'pending' && x.pattern.fingerprint === s.pattern.fingerprint,
      );
      expect(pendingForSamePattern.length).toBe(0);
    });
  });
});
