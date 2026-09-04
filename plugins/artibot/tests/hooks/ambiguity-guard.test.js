import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(TEST_DIR, '..', '..', 'scripts', 'hooks');

const {
  evaluatePrompt,
  formatReminder,
  buildOutput,
  extractPrompt,
} = await import('../../scripts/hooks/ambiguity-guard.js');

describe('ambiguity-guard hook', () => {
  describe('evaluatePrompt()', () => {
    it('flags a 2-word destructive prompt', () => {
      const ev = evaluatePrompt('delete it');
      expect(ev.ambiguous).toBe(true);
      expect(ev.hits).toContain('delete');
      expect(ev.wordCount).toBe(2);
    });

    it('flags "drop everything"', () => {
      const ev = evaluatePrompt('drop everything');
      expect(ev.ambiguous).toBe(true);
      expect(ev.hits).toContain('drop');
    });

    it('flags "kill it"', () => {
      const ev = evaluatePrompt('kill it');
      expect(ev.ambiguous).toBe(true);
      expect(ev.hits).toContain('kill');
    });

    it('does NOT flag long prompts even if they contain destructive verbs', () => {
      const ev = evaluatePrompt('please delete the obsolete migration file in the legacy folder');
      expect(ev.ambiguous).toBe(false);
      expect(ev.wordCount).toBeGreaterThanOrEqual(5);
    });

    it('does NOT flag short prompts without destructive verbs', () => {
      const ev = evaluatePrompt('add tests');
      expect(ev.ambiguous).toBe(false);
      expect(ev.hits).toEqual([]);
    });

    it('handles empty / non-string prompts safely', () => {
      expect(evaluatePrompt('').ambiguous).toBe(false);
      expect(evaluatePrompt('   ').ambiguous).toBe(false);
      expect(evaluatePrompt(null).ambiguous).toBe(false);
      expect(evaluatePrompt(undefined).ambiguous).toBe(false);
    });

    it('catches typo "dont" as destructive (intent ambiguity)', () => {
      const ev = evaluatePrompt('dont commit');
      expect(ev.ambiguous).toBe(true);
      expect(ev.hits).toContain('dont');
    });

    it('matches case-insensitively', () => {
      const ev = evaluatePrompt('NUKE this');
      expect(ev.ambiguous).toBe(true);
      expect(ev.hits).toContain('nuke');
    });
  });

  describe('formatReminder()', () => {
    it('includes the trigger words', () => {
      const msg = formatReminder(['delete', 'force'], 3);
      expect(msg).toContain('delete');
      expect(msg).toContain('force');
      expect(msg).toContain('3 word');
    });

    it('mentions clarifying question instead of guessing', () => {
      const msg = formatReminder(['drop'], 2);
      expect(msg).toMatch(/clarifying question/i);
    });
  });

  describe('buildOutput()', () => {
    it('returns a pass-through when not ambiguous', () => {
      const out = buildOutput({ ambiguous: false, hits: [], wordCount: 8 });
      // Unchanged on purpose. The hook keeps returning the host default; the
      // dispatcher is what elides `continue: true` from stdout, because that is
      // the one place that knows whether any contributor produced anything
      // (see mergeHookResults). Moving the decision here would make this hook's
      // `null` indistinguishable from a crash to the dispatcher.
      expect(out).toEqual({ continue: true });
    });

    it('attaches additionalContext when ambiguous', () => {
      const out = buildOutput({ ambiguous: true, hits: ['delete'], wordCount: 2 });
      expect(out.continue).toBe(true);
      expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(out.hookSpecificOutput.additionalContext).toContain('ambiguity-guard');
    });
  });

  describe('extractPrompt()', () => {
    it('reads the host key .prompt', () => {
      expect(extractPrompt({ prompt: 'a' })).toBe('a');
    });

    // The dispatcher writes `user_prompt` onto the payload after
    // `user-prompt-handler` rewrites the prompt, so a contributor must
    // classify the rewritten text, not the original. This guard used to read
    // `.prompt` first and was the one contributor that did not honour that.
    it('prefers the dispatcher-rewritten user_prompt over the host prompt', () => {
      expect(extractPrompt({ prompt: 'raw', user_prompt: 'rewritten' })).toBe('rewritten');
    });

    // An empty rewrite is a deliberate blank-out, not a missing value.
    it('preserves an empty-string rewrite instead of falling back', () => {
      expect(extractPrompt({ prompt: 'raw', user_prompt: '' })).toBe('');
    });

    it('falls back to the legacy content key', () => {
      expect(extractPrompt({ content: 'c' })).toBe('c');
    });

    // MEASURED 2026-09-03 (Claude Code 2.1.259 hook-input schema): the
    // UserPromptSubmit payload is base + { prompt, source?, session_title? }.
    // These three keys appear in no such payload (`message` belongs to the
    // Notification event), so reading them was dead weight — asserted absent
    // here so a future "widen the key list" change has to argue with a
    // measurement instead of re-adding them on a hunch.
    it('does not read keys absent from the UserPromptSubmit payload', () => {
      expect(extractPrompt({ userPrompt: 'y' })).toBe('');
      expect(extractPrompt({ message: 'm' })).toBe('');
      expect(extractPrompt({ text: 't' })).toBe('');
    });

    it('returns empty string for null/undefined hookData', () => {
      expect(extractPrompt(null)).toBe('');
      expect(extractPrompt(undefined)).toBe('');
      expect(extractPrompt(42)).toBe('');
    });
  });

  describe('no-egress invariant', () => {
    it('source must not import or call HTTP/fetch APIs', () => {
      const src = readFileSync(path.join(HOOKS_DIR, 'ambiguity-guard.js'), 'utf-8');
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/from\s+['"]node:https?['"]/);
      expect(src).not.toMatch(/require\(['"]node:https?['"]\)/);
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
    });
  });
});
