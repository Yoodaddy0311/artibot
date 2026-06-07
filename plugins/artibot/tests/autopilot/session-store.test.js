/**
 * Unit tests for lib/autopilot/session-store.js
 * Covers newSessionId, save/load roundtrip, listSessions, deleteSession.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteSession,
  getSessionPath,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
} from '../../lib/autopilot/session-store.js';

describe('newSessionId', () => {
  it('returns ap-YYYYMMDD-HHMMSS-xxxxxx format with random suffix', () => {
    const id = newSessionId();
    expect(id).toMatch(/^ap-\d{8}-\d{6}-[a-z0-9]{6}$/);
  });

  it('returns a string starting with "ap-"', () => {
    const id = newSessionId();
    expect(id.startsWith('ap-')).toBe(true);
  });

  it('produces unique ids across rapid successive calls (collision safety)', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i += 1) ids.add(newSessionId());
    expect(ids.size).toBe(200);
  });
});

describe('saveSession / loadSession roundtrip', () => {
  const sessions = [];

  afterEach(() => {
    while (sessions.length) {
      const id = sessions.pop();
      try { deleteSession(id); } catch { /* ignore */ }
    }
  });

  it('persists and restores session with Korean task field', () => {
    const sessionId = `ap-test-${Date.now()}-roundtrip`;
    sessions.push(sessionId);
    const state = {
      sessionId,
      task: '한글 작업 설명: 자동 모드 테스트',
      status: 'running',
      counters: { buildFailures: 0, testFailures: 1 },
      createdAt: new Date().toISOString(),
    };
    const writtenPath = saveSession(state);
    expect(writtenPath).toBe(getSessionPath(sessionId));

    const loaded = loadSession(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded.sessionId).toBe(sessionId);
    expect(loaded.task).toBe('한글 작업 설명: 자동 모드 테스트');
    expect(loaded.counters.testFailures).toBe(1);
  });

  it('returns null when loading nonexistent session', () => {
    expect(loadSession('ap-nonexistent-xyz-99999999')).toBeNull();
  });

  it('throws when saving without sessionId', () => {
    expect(() => saveSession({ task: 'x' })).toThrow();
  });
});

describe('listSessions / deleteSession', () => {
  it('listSessions includes a freshly saved session', () => {
    const sessionId = `ap-test-${Date.now()}-list`;
    saveSession({ sessionId, task: 'list test' });
    try {
      const list = listSessions();
      expect(Array.isArray(list)).toBe(true);
      expect(list).toContain(sessionId);
    } finally {
      deleteSession(sessionId);
    }
  });

  it('deleteSession returns true for existing, false for missing', () => {
    const sessionId = `ap-test-${Date.now()}-del`;
    saveSession({ sessionId, task: 'del test' });
    expect(deleteSession(sessionId)).toBe(true);
    expect(deleteSession(sessionId)).toBe(false);
  });
});
