import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createCheckpointMiddleware } from '../../../lib/runtime/middleware/checkpoint.js';

function makeState(overrides = {}) {
  return {
    context: {
      routing: { system: 'system1', score: 0.3 },
      intent: { best: 'action:fix', commands: ['/fix'], agents: [] },
      tasks: { mode: 'subAgent', id: 'rt-test-1' },
      subagents: { contract: { mode: 'subAgent' } },
      ...overrides.context,
    },
    messageParts: [],
    userPrompt: 'test prompt',
    ...overrides,
  };
}

describe('middleware/checkpoint', () => {
  describe('createCheckpointMiddleware', () => {
    it('in-memory 체크포인트 생성 (persistToDisk=false)', async () => {
      const store = new Map();
      const mw = createCheckpointMiddleware({
        store,
        persistToDisk: false,
        now: () => 1700000000000,
      });
      const state = makeState();
      const result = await mw(state);

      expect(result.context.checkpoint).toBeDefined();
      expect(result.context.checkpoint.id).toMatch(/^ckpt-/);
      expect(result.context.checkpoint.persisted).toBe(true);
      expect(result.context.checkpoint.filePath).toBeNull();
      expect(store.size).toBe(1);
    });

    it('messageParts에 ckpt= 추가', async () => {
      const mw = createCheckpointMiddleware({
        persistToDisk: false,
        now: () => 1700000000000,
      });
      const state = makeState();
      await mw(state);

      const ckptPart = state.messageParts.find((p) => p.startsWith('ckpt='));
      expect(ckptPart).toBeDefined();
    });

    it('checkpoint 필드에 routing/intent/task 정보 포함', async () => {
      const store = new Map();
      const mw = createCheckpointMiddleware({
        store,
        persistToDisk: false,
        now: () => 1700000000000,
      });
      const state = makeState({
        context: {
          routing: { system: 'system2', score: 0.8 },
          intent: { best: 'action:implement' },
          tasks: { mode: 'agentTeam', id: 'rt-team-1' },
          subagents: { contract: { mode: 'agentTeam' } },
        },
      });
      await mw(state);

      const [, checkpoint] = [...store.entries()][0];
      expect(checkpoint.routing).toBe('system2');
      expect(checkpoint.intent).toBe('action:implement');
      expect(checkpoint.taskMode).toBe('agentTeam');
      expect(checkpoint.taskId).toBe('rt-team-1');
      expect(checkpoint.delegationMode).toBe('agentTeam');
    });

    it('maxEntries 초과 시 오래된 항목 제거 (in-memory)', async () => {
      const store = new Map();
      let counter = 0;
      const mw = createCheckpointMiddleware({
        store,
        persistToDisk: false,
        maxEntries: 3,
        now: () => 1700000000000 + counter++,
      });

      for (let i = 0; i < 5; i++) {
        await mw(makeState());
      }

      expect(store.size).toBe(3);
    });

    it('디스크 persist 성공', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ckpt-test-'));
      const filePath = path.join(dir, 'checkpoints.json');

      try {
        const mw = createCheckpointMiddleware({
          filePath,
          now: () => 1700000000000,
        });
        const state = makeState();
        const result = await mw(state);

        expect(result.context.checkpoint.persisted).toBe(true);
        expect(result.context.checkpoint.filePath).toBe(filePath);

        const saved = JSON.parse(await readFile(filePath, 'utf-8'));
        expect(Array.isArray(saved.entries)).toBe(true);
        expect(saved.entries).toHaveLength(1);
        expect(saved.entries[0].id).toBe(result.context.checkpoint.id);
        expect(saved.metadata.updatedAt).toBeDefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('디스크 persist 실패 시 에러 정보 기록', async () => {
      // Use an invalid path that will fail on all OSes (null byte)
      const mw = createCheckpointMiddleware({
        filePath: '\0invalid',
        now: () => 1700000000000,
      });
      const state = makeState();
      const result = await mw(state);

      expect(result.context.checkpoint.persisted).toBe(false);
      expect(result.context.checkpoint.error).toBeTruthy();
    });

    it('빈 context 필드에서도 안전하게 동작', async () => {
      const mw = createCheckpointMiddleware({
        persistToDisk: false,
        now: () => 1700000000000,
      });
      const state = {
        context: {},
        messageParts: [],
        userPrompt: 'test',
      };
      const result = await mw(state);

      expect(result.context.checkpoint.id).toMatch(/^ckpt-/);
    });

    it('maxEntries 디스크 trimming', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ckpt-trim-'));
      const filePath = path.join(dir, 'checkpoints.json');

      try {
        let counter = 0;
        const mw = createCheckpointMiddleware({
          filePath,
          maxEntries: 2,
          now: () => 1700000000000 + counter++,
        });

        await mw(makeState());
        await mw(makeState());
        await mw(makeState());

        const saved = JSON.parse(await readFile(filePath, 'utf-8'));
        expect(saved.entries).toHaveLength(2);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
