import { describe, expect, it } from 'vitest';

import { handleUserPromptSubmit } from '../../scripts/hooks/user-prompt-handler.js';

const KOREAN_REVERIFY_TRIGGER = '!재검증';
const KOREAN_REVERIFY_CONTEXT = 'auth 모듈 다시 확인';

describe('user-prompt-handler hook', () => {
  describe('normal prompts', () => {
    it('returns null for regular prompts', () => {
      expect(handleUserPromptSubmit({ user_prompt: 'build a dashboard component' })).toBeNull();
    });

    it('returns null when !rv appears mid-prompt', () => {
      expect(handleUserPromptSubmit({ user_prompt: 'please review !rv the code' })).toBeNull();
    });

    it('returns null for empty payload', () => {
      expect(handleUserPromptSubmit({ user_prompt: '' })).toBeNull();
      expect(handleUserPromptSubmit({})).toBeNull();
    });

    it('reads prompt from content field when provided', () => {
      expect(handleUserPromptSubmit({ content: 'plain content prompt' })).toBeNull();
    });
  });

  describe('!rv re-verification trigger', () => {
    it('activates re-verification mode for "!rv"', () => {
      const out = handleUserPromptSubmit({ user_prompt: '!rv' });
      expect(out).not.toBeNull();
      expect(out.message).toContain('[trigger] !rv re-verification mode activated');
      expect(out.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
      expect(out.user_prompt).toContain('CLAIM AUDIT');
      expect(out.user_prompt).toContain('EVIDENCE CHECK');
    });

    it('includes additional context after the trigger', () => {
      const out = handleUserPromptSubmit({ user_prompt: '!rv check the auth module' });
      expect(out.user_prompt).toContain('Additional context from user: check the auth module');
    });

    it('is case-insensitive for !rv', () => {
      const out = handleUserPromptSubmit({ user_prompt: '!RV' });
      expect(out).not.toBeNull();
      expect(out.message).toContain('!rv re-verification');
    });

    it('supports the Korean trigger "!재검증"', () => {
      const out = handleUserPromptSubmit({
        user_prompt: `${KOREAN_REVERIFY_TRIGGER} ${KOREAN_REVERIFY_CONTEXT}`,
      });
      expect(out).not.toBeNull();
      expect(out.message).toContain('!rv re-verification');
      expect(out.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
      expect(out.user_prompt).toContain(`Additional context from user: ${KOREAN_REVERIFY_CONTEXT}`);
    });

    it('takes priority over words that might otherwise look like normal requests', () => {
      const out = handleUserPromptSubmit({ user_prompt: '!rv build test' });
      expect(out).not.toBeNull();
      expect(out.message).toContain('!rv re-verification');
      expect(out.user_prompt).toContain('build test');
    });
  });

  describe('--no-team flag', () => {
    it('strips --no-team and signals opt-out', () => {
      const out = handleUserPromptSubmit({ user_prompt: 'implement feature --no-team' });
      expect(out).not.toBeNull();
      expect(out.user_prompt).toBe('implement feature');
      expect(out.message).toContain('--no-team flag detected');
    });

    it('is case-insensitive for --no-team', () => {
      const out = handleUserPromptSubmit({ user_prompt: 'task --NO-TEAM' });
      expect(out).not.toBeNull();
      expect(out.message).toContain('--no-team flag detected');
    });
  });

  describe('null payload tolerance', () => {
    it('returns null for null/undefined hookData', () => {
      expect(handleUserPromptSubmit(null)).toBeNull();
      expect(handleUserPromptSubmit(undefined)).toBeNull();
    });
  });
});
