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

  // 호스트 2.1.259 스키마 형태 — 회귀 방지.
  // 이 핸들러는 디스패처 체인의 FIRST 이므로 `user_prompt` 가 아직 존재할 수 없다.
  // 호스트가 주는 `prompt` 만으로 동작해야 한다. 아래 픽스처에 `user_prompt` 는 없다.
  describe('host payload shape (UserPromptSubmit, Claude Code 2.1.259)', () => {
    const hostPayload = (prompt) => ({
      hook_event_name: 'UserPromptSubmit',
      prompt,
      session_id: '9120048e-3385-4855-a35b-09c89e5dd684',
      cwd: 'C:/Users/HeechangLee/Desktop/AI/Artibot',
    });

    it('fires the !rv trigger from the host `prompt` key alone', () => {
      const out = handleUserPromptSubmit(hostPayload('!rv check the auth module'));
      expect(out).not.toBeNull();
      expect(out.message).toContain('[trigger] !rv re-verification mode activated');
      expect(out.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE');
      expect(out.user_prompt).toContain('Additional context from user: check the auth module');
    });

    it('strips --no-team from the host `prompt` key alone', () => {
      const out = handleUserPromptSubmit(hostPayload('build a dashboard --no-team'));
      expect(out).not.toBeNull();
      expect(out.user_prompt).toBe('build a dashboard');
      expect(out.message).toContain('--no-team flag detected');
    });
  });

  // The two surfaces this hook writes to are NOT interchangeable:
  // `user_prompt`/`message` are dispatcher-internal (the host discards them —
  // 2.1.259 measured), `hookSpecificOutput.additionalContext` is what the model
  // sees. Every branch that changes behaviour must reach the second one, or it
  // changes nothing the user can observe.
  describe('host channel (hookSpecificOutput.additionalContext)', () => {
    it('states the --no-team opt-out as an instruction', () => {
      const out = handleUserPromptSubmit({ user_prompt: 'implement feature --no-team' });
      const ctx = out.hookSpecificOutput?.additionalContext ?? '';
      expect(out.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
      expect(ctx).toContain('[artibot:team opt-out]');
      expect(ctx).toContain('do not spawn a team');
    });

    it('carries the full !rv protocol, not just a mention of it', () => {
      const out = handleUserPromptSubmit({ user_prompt: '!rv check the auth module' });
      const ctx = out.hookSpecificOutput?.additionalContext ?? '';
      expect(ctx).toContain('CRITICAL RE-VERIFICATION MODE');
      expect(ctx).toContain('CLAIM AUDIT');
      expect(ctx).toContain('Additional context from user: check the auth module');
    });

    it('emits nothing on the host channel for an ordinary prompt', () => {
      // Pass-through returns null outright — no empty envelope to merge.
      expect(handleUserPromptSubmit({ user_prompt: 'build a dashboard component' })).toBeNull();
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
