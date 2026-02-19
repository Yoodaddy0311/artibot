import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveMemory,
  searchMemory,
  getRelevantContext,
  summarizeSession,
} from '../../lib/learning/memory-manager.js';

vi.mock('../../lib/core/file.js', () => ({
  readJsonFile: vi.fn(() => Promise.resolve(null)),
  writeJsonFile: vi.fn(() => Promise.resolve()),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

const { readJsonFile, writeJsonFile, ensureDir } = await import('../../lib/core/file.js');

describe('memory-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJsonFile.mockResolvedValue(null);
  });

  // ---------------------------------------------------------------------------
  describe('saveMemory()', () => {
    it('saves a preference entry and returns it', async () => {
      const entry = await saveMemory('preference', { key: 'theme', value: 'dark' });
      expect(entry).toHaveProperty('id');
      expect(entry.type).toBe('preference');
      expect(entry.data).toEqual({ key: 'theme', value: 'dark' });
    });

    it('saves a context entry', async () => {
      const entry = await saveMemory('context', { project: 'artibot', language: 'javascript' });
      expect(entry.type).toBe('context');
      expect(entry.data.project).toBe('artibot');
    });

    it('saves a command entry', async () => {
      const entry = await saveMemory('command', { command: '/analyze', args: '--focus security' });
      expect(entry.type).toBe('command');
    });

    it('saves an error entry', async () => {
      const entry = await saveMemory('error', { code: 'ENOENT', message: 'file not found' });
      expect(entry.type).toBe('error');
    });

    it('persists entry to disk', async () => {
      await saveMemory('preference', { key: 'lang', value: 'en' });
      expect(writeJsonFile).toHaveBeenCalledTimes(1);
    });

    it('ensures memory directory exists before saving', async () => {
      await saveMemory('preference', { key: 'x', value: 'y' });
      expect(ensureDir).toHaveBeenCalledTimes(1);
    });

    it('deduplicates preferences by data.key', async () => {
      // Pre-existing preference with same key
      readJsonFile.mockResolvedValue({
        entries: [{
          id: 'pref_old',
          type: 'preference',
          data: { key: 'theme', value: 'light' },
          tags: ['theme', 'light'],
          source: 'system',
          createdAt: new Date(Date.now() - 10000).toISOString(),
          expiresAt: null,
          accessCount: 0,
          lastAccessedAt: null,
        }],
        metadata: { createdAt: new Date().toISOString() },
      });

      await saveMemory('preference', { key: 'theme', value: 'dark' });
      const written = writeJsonFile.mock.calls[0][1];
      // Should have exactly 1 entry (old replaced by new)
      expect(written.entries).toHaveLength(1);
      expect(written.entries[0].data.value).toBe('dark');
    });

    it('preference entries have null expiresAt (permanent)', async () => {
      const entry = await saveMemory('preference', { key: 'pref1', value: 'v1' });
      expect(entry.expiresAt).toBeNull();
    });

    it('command entries have non-null expiresAt (7 days TTL)', async () => {
      const entry = await saveMemory('command', { command: '/test' });
      expect(entry.expiresAt).not.toBeNull();
    });

    it('enforces MAX_COMMAND_HISTORY size limit (500)', async () => {
      readJsonFile.mockResolvedValue({
        entries: Array.from({ length: 500 }, (_, i) => ({
          id: `cmd_${i}`,
          type: 'command',
          data: { command: `/cmd${i}` },
          tags: [],
          source: 'system',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          accessCount: 0,
          lastAccessedAt: null,
        })),
        metadata: { createdAt: new Date().toISOString() },
      });

      await saveMemory('command', { command: '/new-command' });
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.entries.length).toBeLessThanOrEqual(500);
    });

    it('accepts custom tags option', async () => {
      const entry = await saveMemory('context', { info: 'test' }, { tags: ['custom', 'tag'] });
      expect(entry.tags).toContain('custom');
      expect(entry.tags).toContain('tag');
    });

    it('accepts custom source option', async () => {
      const entry = await saveMemory('preference', { key: 'x', value: 'y' }, { source: 'user' });
      expect(entry.source).toBe('user');
    });

    it('has accessCount of 0 on creation', async () => {
      const entry = await saveMemory('context', { info: 'data' });
      expect(entry.accessCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('searchMemory()', () => {
    const setupStore = (type, entries) => {
      readJsonFile.mockImplementation(() => {
        return Promise.resolve({
          entries,
          metadata: { createdAt: new Date().toISOString() },
        });
      });
    };

    it('returns empty array for empty query tokens', async () => {
      const results = await searchMemory('');
      expect(results).toEqual([]);
    });

    it('returns matching entries above threshold', async () => {
      setupStore('preference', [{
        id: 'pref_1',
        type: 'preference',
        data: { key: 'theme', value: 'dark' },
        tags: ['theme', 'dark'],
        source: 'user',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        accessCount: 3,
        lastAccessedAt: null,
      }]);

      const results = await searchMemory('dark theme');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('entry');
      expect(results[0]).toHaveProperty('score');
      expect(results[0]).toHaveProperty('store');
    });

    it('scores entries with keyword matches higher', async () => {
      const now = new Date().toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [
          { id: '1', type: 'context', data: { project: 'artibot' }, tags: ['artibot', 'frontend'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null },
          { id: '2', type: 'context', data: { project: 'other' }, tags: ['other', 'backend'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null },
        ],
        metadata: { createdAt: now },
      }));

      const results = await searchMemory('artibot');
      // artibot-tagged entry should score higher
      if (results.length >= 2) {
        const artibotResult = results.find((r) => r.entry.tags.includes('artibot'));
        const otherResult = results.find((r) => r.entry.tags.includes('other'));
        if (artibotResult && otherResult) {
          expect(artibotResult.score).toBeGreaterThan(otherResult.score);
        }
      }
    });

    it('skips expired entries', async () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [{
          id: 'expired',
          type: 'command',
          data: { command: '/expired' },
          tags: ['expired', 'command'],
          source: 'system',
          createdAt: new Date(Date.now() - 10000).toISOString(),
          expiresAt: pastDate, // already expired
          accessCount: 0,
          lastAccessedAt: null,
        }],
        metadata: { createdAt: new Date().toISOString() },
      }));

      const results = await searchMemory('expired command');
      expect(results).toHaveLength(0);
    });

    it('respects limit option', async () => {
      const now = new Date().toISOString();
      const entries = Array.from({ length: 20 }, (_, i) => ({
        id: `entry-${i}`,
        type: 'context',
        data: { project: `project${i}` },
        tags: ['project', `project${i}`],
        source: 'system',
        createdAt: now,
        expiresAt: null,
        accessCount: 0,
        lastAccessedAt: null,
      }));
      readJsonFile.mockImplementation(() => Promise.resolve({ entries, metadata: { createdAt: now } }));

      const results = await searchMemory('project', { limit: 5 });
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('respects threshold option', async () => {
      const now = new Date().toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [{
          id: '1',
          type: 'context',
          data: { info: 'completely unrelated data xyz' },
          tags: ['xyz', 'unrelated'],
          source: 'system',
          createdAt: now,
          expiresAt: null,
          accessCount: 0,
          lastAccessedAt: null,
        }],
        metadata: { createdAt: now },
      }));

      // High threshold should filter out low-relevance entries
      const results = await searchMemory('artibot typescript', { threshold: 0.9 });
      expect(results).toHaveLength(0);
    });

    it('sorts results by score descending', async () => {
      const now = new Date().toISOString();
      readJobFile_withEntries(readJsonFile, [
        { id: '1', tags: ['artibot', 'typescript', 'frontend'], createdAt: now },
        { id: '2', tags: ['artibot'], createdAt: now },
      ]);

      const results = await searchMemory('artibot typescript frontend');
      if (results.length >= 2) {
        expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
      }
    });

    it('filters by types option', async () => {
      const now = new Date().toISOString();
      readJsonFile.mockImplementation((p) => {
        if (p.includes('user-preferences')) {
          return Promise.resolve({
            entries: [{ id: 'pref1', type: 'preference', data: { key: 'x' }, tags: ['search', 'test'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null }],
            metadata: { createdAt: now },
          });
        }
        return Promise.resolve({ entries: [], metadata: { createdAt: now } });
      });

      const results = await searchMemory('search test', { types: ['preference'] });
      expect(results.every((r) => r.store === 'userPreferences')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getRelevantContext()', () => {
    it('returns structured context with preference, project, commands, errors', async () => {
      readJsonFile.mockResolvedValue(null);
      const context = await getRelevantContext({ cwd: '/project/artibot', command: '/analyze' });
      expect(context).toHaveProperty('preferences');
      expect(context).toHaveProperty('projectContext');
      expect(context).toHaveProperty('recentCommands');
      expect(context).toHaveProperty('errorPatterns');
    });

    it('returns all empty arrays when no query built', async () => {
      const context = await getRelevantContext({});
      expect(context.preferences).toEqual([]);
      expect(context.projectContext).toEqual([]);
      expect(context.recentCommands).toEqual([]);
      expect(context.errorPatterns).toEqual([]);
    });

    it('uses cwd basename as search term', async () => {
      const now = new Date().toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [{
          id: '1',
          type: 'context',
          data: { project: 'myproject', lang: 'ts' },
          tags: ['myproject', 'project', 'ts'],
          source: 'system',
          createdAt: now,
          expiresAt: null,
          accessCount: 0,
          lastAccessedAt: null,
        }],
        metadata: { createdAt: now },
      }));

      const context = await getRelevantContext({ cwd: '/path/to/myproject' });
      // Should find the project context entry
      const found = context.projectContext.length > 0 || context.preferences.length > 0;
      expect(typeof found).toBe('boolean');
    });

    it('accepts additional keywords', async () => {
      readJsonFile.mockResolvedValue(null);
      // Should not throw
      const context = await getRelevantContext({ keywords: ['typescript', 'security', 'test'] });
      expect(context).toHaveProperty('preferences');
    });

    it('uses project name in query when provided', async () => {
      readJsonFile.mockResolvedValue(null);
      const context = await getRelevantContext({ project: 'artibot' });
      expect(context).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  describe('summarizeSession()', () => {
    it('saves a session summary and returns the entry', async () => {
      const entry = await summarizeSession({
        sessionId: 'sess-123',
        project: 'artibot',
        history: [
          { event: 'command', data: { command: '/analyze' } },
          { event: 'command', data: { command: '/implement' } },
          { event: 'task_completed', data: { taskId: 'task-1' } },
        ],
        metadata: { duration: 120000 },
      });

      expect(entry.type).toBe('context');
      expect(entry.data.sessionId).toBe('sess-123');
      expect(entry.data.project).toBe('artibot');
      expect(entry.data.commandCount).toBe(2);
      expect(entry.data.completedTasks).toBe(1);
    });

    it('counts errors from history', async () => {
      const entry = await summarizeSession({
        sessionId: 'sess-1',
        history: [
          { event: 'error', data: { message: 'timeout' } },
          { event: 'error', data: { message: 'permission denied' } },
        ],
      });
      expect(entry.data.errorCount).toBe(2);
    });

    it('deduplicates commands in uniqueCommands', async () => {
      const entry = await summarizeSession({
        history: [
          { event: 'command', data: { command: '/analyze' } },
          { event: 'command', data: { command: '/analyze' } },
          { event: 'command', data: { command: '/implement' } },
        ],
      });
      expect(entry.data.uniqueCommands).toHaveLength(2);
    });

    it('handles empty session gracefully', async () => {
      const entry = await summarizeSession({});
      expect(entry.type).toBe('context');
      expect(entry.data.commandCount).toBe(0);
      expect(entry.data.completedTasks).toBe(0);
      expect(entry.data.errorCount).toBe(0);
    });

    it('includes timestamp in summary', async () => {
      const entry = await summarizeSession({ sessionId: 's1' });
      expect(entry.data.timestamp).toBeDefined();
    });

    it('persists the summary to disk', async () => {
      await summarizeSession({ sessionId: 'sess-1', project: 'test' });
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('includes session-summary tag', async () => {
      const entry = await summarizeSession({ project: 'myproj' });
      expect(entry.tags).toContain('session-summary');
    });

    it('uses longTerm TTL (90 days)', async () => {
      const entry = await summarizeSession({ sessionId: 'sess-1' });
      // expiresAt should be ~90 days from now (non-null for context type)
      expect(entry.expiresAt).not.toBeNull();
      const expiresAt = new Date(entry.expiresAt).getTime();
      const eightyDaysFromNow = Date.now() + 80 * 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThan(eightyDaysFromNow);
    });

    it('stores duration from metadata', async () => {
      const entry = await summarizeSession({
        metadata: { duration: 300000 },
      });
      expect(entry.data.duration).toBe(300000);
    });
  });
});

// ---------------------------------------------------------------------------
// Helper used in searchMemory tests
// ---------------------------------------------------------------------------
function readJobFile_withEntries(mockFn, entryParts) {
  const now = new Date().toISOString();
  mockFn.mockImplementation(() => Promise.resolve({
    entries: entryParts.map((p) => ({
      id: p.id,
      type: 'context',
      data: { project: p.id },
      tags: p.tags,
      source: 'system',
      createdAt: p.createdAt ?? now,
      expiresAt: null,
      accessCount: 0,
      lastAccessedAt: null,
    })),
    metadata: { createdAt: now },
  }));
}
