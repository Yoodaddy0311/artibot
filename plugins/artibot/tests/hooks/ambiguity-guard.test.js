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
    it('reads .prompt first', () => {
      expect(extractPrompt({ prompt: 'a', message: 'b' })).toBe('a');
    });

    it('falls back to user_prompt, userPrompt, message, text', () => {
      expect(extractPrompt({ user_prompt: 'x' })).toBe('x');
      expect(extractPrompt({ userPrompt: 'y' })).toBe('y');
      expect(extractPrompt({ message: 'm' })).toBe('m');
      expect(extractPrompt({ text: 't' })).toBe('t');
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
