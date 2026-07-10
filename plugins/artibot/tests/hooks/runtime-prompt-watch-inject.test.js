/**
 * P4 — /watch front-door hint injection.
 *
 * A YouTube link in the user prompt should surface an ADVISORY
 * [artibot:hint recommend=watch] directive (deterministic regex counterpart to
 * the probabilistic description activation). It must never auto-fire /watch and
 * must leave non-YouTube prompts byte-identical. These tests pin the detector
 * (buildWatchDirective) and its wiring through composePromptOutput.
 */

import { describe, expect, it } from 'vitest';
import {
  buildWatchDirective,
  composePromptOutput,
} from '../../scripts/hooks/runtime-prompt.js';

describe('buildWatchDirective()', () => {
  it('emits the hint with the matched url for youtube.com/watch links', () => {
    expect(buildWatchDirective('이 영상 봐줘 https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('[artibot:hint recommend=watch url=https://www.youtube.com/watch?v=dQw4w9WgXcQ]');
  });

  it('emits the hint for youtu.be short links', () => {
    expect(buildWatchDirective('https://youtu.be/dQw4w9WgXcQ'))
      .toBe('[artibot:hint recommend=watch url=https://youtu.be/dQw4w9WgXcQ]');
  });

  it('emits the hint for m/music subdomains and shorts/embed paths', () => {
    expect(buildWatchDirective('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toContain('recommend=watch');
    expect(buildWatchDirective('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toContain('recommend=watch');
    expect(buildWatchDirective('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toContain('recommend=watch');
    expect(buildWatchDirective('https://youtube.com/embed/dQw4w9WgXcQ 봐줘')).toContain('recommend=watch');
  });

  it('emits the hint when the watch URL carries extra query params', () => {
    expect(buildWatchDirective('https://youtube.com/watch?v=dQw4w9WgXcQ&t=10s&list=PLx'))
      .toContain('recommend=watch');
  });

  it('returns empty string for non-YouTube hosts', () => {
    expect(buildWatchDirective('https://vimeo.com/12345678')).toBe('');
    expect(buildWatchDirective('https://evil.com/watch?v=dQw4w9WgXcQ')).toBe('');
  });

  it('rejects spoofed hosts (youtube.com.evil.com must NOT match)', () => {
    expect(buildWatchDirective('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ')).toBe('');
    expect(buildWatchDirective('https://youtube.com.evil.com/embed/dQw4w9WgXcQ')).toBe('');
    expect(buildWatchDirective('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBe('');
    expect(buildWatchDirective('https://myyoutube.com/watch?v=dQw4w9WgXcQ')).toBe('');
  });

  it('returns empty string for a bare 11-char id (too ambiguous for a front-door hint)', () => {
    expect(buildWatchDirective('dQw4w9WgXcQ 이 ID')).toBe('');
  });

  it('returns empty string for plain prompts and invalid input', () => {
    expect(buildWatchDirective('그냥 일반 질문입니다')).toBe('');
    expect(buildWatchDirective('')).toBe('');
    expect(buildWatchDirective(null)).toBe('');
    expect(buildWatchDirective(undefined)).toBe('');
  });
});

describe('composePromptOutput() — watch hint wiring', () => {
  it('prepends the watch hint when the prompt contains a YouTube link', () => {
    const out = composePromptOutput({
      prepared: { userPrompt: '이 영상 요약해줘 https://youtu.be/dQw4w9WgXcQ' },
      prompt: '',
      effortMeta: null,
      taskBudgetDirective: '',
      injectPrompt: true,
    });
    expect(out.user_prompt).toContain('[artibot:hint recommend=watch url=https://youtu.be/dQw4w9WgXcQ]');
    expect(out.user_prompt).toMatch(/이 영상 요약해줘 https:\/\/youtu\.be\/dQw4w9WgXcQ$/);
  });

  it('coexists with an existing recommendation hint (both directives on the leading line)', () => {
    const out = composePromptOutput({
      prepared: {
        userPrompt: '이거 반복작업이야 https://youtu.be/dQw4w9WgXcQ',
        context: { tasks: { meta: { workflowPlan: { recommendation: 'workflow' } } } },
      },
      prompt: '',
      effortMeta: null,
      taskBudgetDirective: '',
      injectPrompt: true,
    });
    expect(out.user_prompt).toContain('[artibot:hint recommend=workflow]');
    expect(out.user_prompt).toContain('[artibot:hint recommend=watch url=https://youtu.be/dQw4w9WgXcQ]');
    // watch hint follows the recommendation hint (appended last in the prefix array).
    expect(out.user_prompt.indexOf('recommend=workflow')).toBeLessThan(out.user_prompt.indexOf('recommend=watch'));
  });

  it('leaves a non-YouTube prompt byte-identical (no hint)', () => {
    const out = composePromptOutput({
      prepared: { userPrompt: '일반 질문' },
      prompt: '',
      effortMeta: null,
      taskBudgetDirective: '',
      injectPrompt: true,
    });
    expect(out.user_prompt).toBe('일반 질문');
    expect(out.user_prompt).not.toContain('recommend=watch');
  });

  it('respects injectPrompt=false even when a YouTube link is present', () => {
    const out = composePromptOutput({
      prepared: { userPrompt: 'https://youtu.be/dQw4w9WgXcQ' },
      prompt: '',
      effortMeta: null,
      taskBudgetDirective: '',
      injectPrompt: false,
    });
    expect(out.user_prompt).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(out.user_prompt).not.toContain('recommend=watch');
  });
});
