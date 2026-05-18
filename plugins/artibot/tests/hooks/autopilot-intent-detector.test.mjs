import { describe, expect, it } from 'vitest';
import { handlePreExecute } from '../../hooks/autopilot-intent-detector.mjs';

describe('autopilot-intent-detector — handlePreExecute', () => {
  it('returns empty envelope on null hook data', async () => {
    const r = await handlePreExecute(null);
    expect(r).toEqual({});
  });

  it('returns empty envelope on missing prompt fields', async () => {
    const r = await handlePreExecute({ unrelated: true });
    expect(r).toEqual({});
  });

  it('returns empty envelope on empty prompt string', async () => {
    const r = await handlePreExecute({ user_prompt: '   ' });
    expect(r).toEqual({});
  });

  it('returns metadata.autopilotIntents for a queue-intent prompt', async () => {
    const r = await handlePreExecute({ user_prompt: '이거 3개 다 처리해줘' });
    expect(r.metadata).toBeDefined();
    expect(r.metadata.autopilotIntents).toBeDefined();
    expect(r.metadata.autopilotIntents.queue.found).toBe(true);
  });

  it('detects schedule intent from "오늘 밤"', async () => {
    const r = await handlePreExecute({ user_prompt: '오늘 밤에 알아서 처리해줘' });
    expect(r.metadata.autopilotIntents.schedule.found).toBe(true);
    expect(r.metadata.autopilotIntents.schedule.window).toBe('22:00-07:00');
  });

  it('detects dry-run intent from "미리보기"', async () => {
    const r = await handlePreExecute({ user_prompt: '미리보기로 어떻게 될지 보여줘' });
    expect(r.metadata.autopilotIntents.dryRun.found).toBe(true);
  });

  it('detects template hint (bugfix) from "버그 고쳐"', async () => {
    const r = await handlePreExecute({ user_prompt: '이 버그 고쳐줘' });
    expect(r.metadata.autopilotIntents.template.template).toBe('bugfix');
  });

  it('detects rollback intent from "롤백"', async () => {
    const r = await handlePreExecute({ user_prompt: '방금 변경사항 롤백' });
    expect(r.metadata.autopilotIntents.rollback.found).toBe(true);
  });

  it('accepts the "prompt" field shape', async () => {
    const r = await handlePreExecute({ prompt: 'undo the last change' });
    expect(r.metadata.autopilotIntents.rollback.found).toBe(true);
  });

  it('accepts the "content" field shape', async () => {
    const r = await handlePreExecute({ content: 'simulate this' });
    expect(r.metadata.autopilotIntents.dryRun.found).toBe(true);
  });

  it('accepts nested message.content shape', async () => {
    const r = await handlePreExecute({ message: { content: 'overnight please' } });
    expect(r.metadata.autopilotIntents.schedule.found).toBe(true);
  });

  it('includes the hook source name in metadata', async () => {
    const r = await handlePreExecute({ user_prompt: '오늘 밤' });
    expect(r.metadata.source).toBe('autopilot-intent-detector');
  });

  it('combines multiple intents in one call', async () => {
    const r = await handlePreExecute({
      user_prompt: '오늘 밤에 이거 3개 다 시뮬레이션으로:\n1. A\n2. B\n3. C',
    });
    expect(r.metadata.autopilotIntents.queue.found).toBe(true);
    expect(r.metadata.autopilotIntents.schedule.found).toBe(true);
    expect(r.metadata.autopilotIntents.dryRun.found).toBe(true);
  });

  it('returns {} when handed a non-object payload', async () => {
    // @ts-expect-error testing defensive guard
    const r = await handlePreExecute('not an object');
    expect(r).toEqual({});
  });
});
