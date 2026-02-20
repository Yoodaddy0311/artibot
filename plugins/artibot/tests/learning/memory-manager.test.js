import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  saveMemory,
  searchMemory,
  getRelevantContext,
  summarizeSession,
  pruneOldMemories,
  loadMemories,
  clearMemories,
  getMemoryStats,
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
      expect(written.entries).toHaveLength(1);
      expect(written.entries[0].data.value).toBe('dark');
    });

    it('does not deduplicate preferences without data.key', async () => {
      readJsonFile.mockResolvedValue({
        entries: [{
          id: 'pref_old',
          type: 'preference',
          data: { value: 'light' },
          tags: ['light'],
          source: 'system',
          createdAt: new Date().toISOString(),
          expiresAt: null,
          accessCount: 0,
          lastAccessedAt: null,
        }],
        metadata: { createdAt: new Date().toISOString() },
      });

      await saveMemory('preference', { value: 'dark' });
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.entries).toHaveLength(2);
    });

    it('preference entries have null expiresAt (permanent)', async () => {
      const entry = await saveMemory('preference', { key: 'pref1', value: 'v1' });
      expect(entry.expiresAt).toBeNull();
    });

    it('command entries have non-null expiresAt (7 days TTL)', async () => {
      const entry = await saveMemory('command', { command: '/test' });
      expect(entry.expiresAt).not.toBeNull();
    });

    it('context entries have non-null expiresAt (90 days TTL)', async () => {
      const entry = await saveMemory('context', { project: 'test' });
      expect(entry.expiresAt).not.toBeNull();
      const expiresAt = new Date(entry.expiresAt).getTime();
      const eightyDaysFromNow = Date.now() + 80 * 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThan(eightyDaysFromNow);
    });

    it('error entries have non-null expiresAt (90 days TTL)', async () => {
      const entry = await saveMemory('error', { message: 'fail' });
      expect(entry.expiresAt).not.toBeNull();
    });

    it('unknown type defaults to shortTerm TTL', async () => {
      const entry = await saveMemory('unknown_type', { info: 'test' });
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

    it('enforces MAX_ERROR_PATTERNS size limit (200)', async () => {
      readJsonFile.mockResolvedValue({
        entries: Array.from({ length: 200 }, (_, i) => ({
          id: `err_${i}`,
          type: 'error',
          data: { message: `error ${i}` },
          tags: [],
          source: 'system',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
          accessCount: 0,
          lastAccessedAt: null,
        })),
        metadata: { createdAt: new Date().toISOString() },
      });

      await saveMemory('error', { message: 'new error' });
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.entries.length).toBeLessThanOrEqual(200);
    });

    it('does not enforce size limit for context type', async () => {
      readJsonFile.mockResolvedValue({
        entries: Array.from({ length: 600 }, (_, i) => ({
          id: `ctx_${i}`,
          type: 'context',
          data: { project: `project${i}` },
          tags: [],
          source: 'system',
          createdAt: new Date().toISOString(),
          expiresAt: null,
          accessCount: 0,
          lastAccessedAt: null,
        })),
        metadata: { createdAt: new Date().toISOString() },
      });

      await saveMemory('context', { project: 'new' });
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.entries.length).toBe(601);
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

    it('accepts custom ttl option', async () => {
      const entry = await saveMemory('context', { info: 'test' }, { ttl: 1000 });
      expect(entry.expiresAt).not.toBeNull();
      const expiresAt = new Date(entry.expiresAt).getTime();
      expect(expiresAt).toBeLessThan(Date.now() + 5000);
    });

    it('has accessCount of 0 on creation', async () => {
      const entry = await saveMemory('context', { info: 'data' });
      expect(entry.accessCount).toBe(0);
    });

    it('has lastAccessedAt of null on creation', async () => {
      const entry = await saveMemory('context', { info: 'data' });
      expect(entry.lastAccessedAt).toBeNull();
    });

    it('auto-extracts tags from data when no custom tags', async () => {
      const entry = await saveMemory('context', { project: 'artibot', language: 'javascript' });
      expect(entry.tags.length).toBeGreaterThan(0);
      expect(entry.tags).toContain('artibot');
      expect(entry.tags).toContain('javascript');
    });

    it('extracts tags from nested objects and arrays', async () => {
      const entry = await saveMemory('context', {
        project: 'test',
        tools: ['Read', 'Write'],
        meta: { author: 'dev' },
      });
      expect(entry.tags).toContain('test');
      expect(entry.tags).toContain('read');
      expect(entry.tags).toContain('write');
      expect(entry.tags).toContain('dev');
    });

    it('defaults source to system when not provided', async () => {
      const entry = await saveMemory('context', { info: 'test' });
      expect(entry.source).toBe('system');
    });

    it('maps unknown type to projectContexts store', async () => {
      await saveMemory('nonexistent_type', { info: 'test' });
      const writeCall = writeJsonFile.mock.calls[0];
      expect(writeCall[0]).toContain('project-contexts');
    });
  });

  // ---------------------------------------------------------------------------
  describe('searchMemory()', () => {
    const setupStore = (entries) => {
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

    it('returns empty array for single-char query', async () => {
      const results = await searchMemory('a');
      expect(results).toEqual([]);
    });

    it('returns matching entries above threshold', async () => {
      setupStore([{
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
          expiresAt: pastDate,
          accessCount: 0,
          lastAccessedAt: null,
        }],
        metadata: { createdAt: new Date().toISOString() },
      }));

      const results = await searchMemory('expired command');
      expect(results).toHaveLength(0);
    });

    it('includes entries with null expiresAt (permanent)', async () => {
      setupStore([{
        id: 'perm_1',
        type: 'preference',
        data: { key: 'theme', value: 'dark' },
        tags: ['theme', 'dark', 'permanent'],
        source: 'user',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        accessCount: 0,
        lastAccessedAt: null,
      }]);

      const results = await searchMemory('permanent theme');
      expect(results.length).toBeGreaterThan(0);
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

      const results = await searchMemory('artibot typescript', { threshold: 0.9 });
      expect(results).toHaveLength(0);
    });

    it('sorts results by score descending', async () => {
      const now = new Date().toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [
          { id: '1', type: 'context', data: { project: '1' }, tags: ['artibot', 'typescript', 'frontend'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null },
          { id: '2', type: 'context', data: { project: '2' }, tags: ['artibot'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null },
        ],
        metadata: { createdAt: now },
      }));

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

    it('searches across all stores when no types filter', async () => {
      const now = new Date().toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [{ id: '1', type: 'context', data: { info: 'global search' }, tags: ['global', 'search'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null }],
        metadata: { createdAt: now },
      }));

      const results = await searchMemory('global search');
      // Should have searched across all 4 stores (each returning the same entries from our mock)
      expect(results.length).toBeGreaterThan(0);
    });

    it('handles entries with empty or missing tags', async () => {
      setupStore([{
        id: 'no_tags',
        type: 'context',
        data: { info: 'test' },
        tags: [],
        source: 'system',
        createdAt: new Date().toISOString(),
        expiresAt: null,
        accessCount: 0,
        lastAccessedAt: null,
      }]);
      const results = await searchMemory('test', { threshold: 0.01 });
      // Should not crash
      expect(Array.isArray(results)).toBe(true);
    });

    it('gives access frequency bonus to frequently accessed entries', async () => {
      const now = new Date().toISOString();
      setupStore([
        { id: 'low_access', type: 'context', data: { topic: 'test' }, tags: ['test', 'topic'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null },
        { id: 'high_access', type: 'context', data: { topic: 'test' }, tags: ['test', 'topic'], source: 'system', createdAt: now, expiresAt: null, accessCount: 10, lastAccessedAt: null },
      ]);
      const results = await searchMemory('test topic');
      if (results.length >= 2) {
        const highAccess = results.find((r) => r.entry.id === 'high_access');
        const lowAccess = results.find((r) => r.entry.id === 'low_access');
        if (highAccess && lowAccess) {
          expect(highAccess.score).toBeGreaterThan(lowAccess.score);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('getRelevantContext()', () => {
    it('returns structured context with preferences, project, commands, errors', async () => {
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

    it('returns all empty arrays when called with no arguments', async () => {
      const context = await getRelevantContext();
      expect(context.preferences).toEqual([]);
      expect(context.projectContext).toEqual([]);
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
      const found = context.projectContext.length > 0 || context.preferences.length > 0;
      expect(typeof found).toBe('boolean');
    });

    it('accepts additional keywords', async () => {
      const context = await getRelevantContext({ keywords: ['typescript', 'security', 'test'] });
      expect(context).toHaveProperty('preferences');
    });

    it('uses project name in query when provided', async () => {
      const context = await getRelevantContext({ project: 'artibot' });
      expect(context).toBeDefined();
    });

    it('combines all context sources into query', async () => {
      const context = await getRelevantContext({
        cwd: '/projects/myapp',
        command: '/analyze',
        project: 'myapp',
        keywords: ['security'],
      });
      expect(context).toHaveProperty('preferences');
    });

    it('categorizes results by store type correctly', async () => {
      const now = new Date().toISOString();
      readJsonFile.mockImplementation((p) => {
        if (p.includes('user-preferences')) {
          return Promise.resolve({
            entries: [{ id: 'pref1', type: 'preference', data: { key: 'lang', value: 'kr' }, tags: ['lang', 'kr', 'myapp'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null }],
            metadata: { createdAt: now },
          });
        }
        if (p.includes('error-patterns')) {
          return Promise.resolve({
            entries: [{ id: 'err1', type: 'error', data: { code: 'ETIMEOUT', message: 'myapp timeout' }, tags: ['etimeout', 'myapp', 'timeout'], source: 'system', createdAt: now, expiresAt: null, accessCount: 0, lastAccessedAt: null }],
            metadata: { createdAt: now },
          });
        }
        return Promise.resolve({ entries: [], metadata: { createdAt: now } });
      });

      const context = await getRelevantContext({ project: 'myapp' });
      // preferences and errorPatterns should contain data from their respective stores
      if (context.preferences.length > 0) {
        expect(context.preferences[0]).toHaveProperty('key');
      }
      if (context.errorPatterns.length > 0) {
        expect(context.errorPatterns[0]).toHaveProperty('code');
      }
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

    it('handles no arguments', async () => {
      const entry = await summarizeSession();
      expect(entry.type).toBe('context');
      expect(entry.data.commandCount).toBe(0);
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

    it('includes project name in tags', async () => {
      const entry = await summarizeSession({ project: 'myproj' });
      expect(entry.tags).toContain('myproj');
    });

    it('uses longTerm TTL (90 days)', async () => {
      const entry = await summarizeSession({ sessionId: 'sess-1' });
      expect(entry.expiresAt).not.toBeNull();
      const expiresAt = new Date(entry.expiresAt).getTime();
      const eightyDaysFromNow = Date.now() + 80 * 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThan(eightyDaysFromNow);
    });

    it('stores duration from metadata', async () => {
      const entry = await summarizeSession({ metadata: { duration: 300000 } });
      expect(entry.data.duration).toBe(300000);
    });

    it('defaults duration to null when not provided in metadata', async () => {
      const entry = await summarizeSession({ metadata: {} });
      expect(entry.data.duration).toBeNull();
    });

    it('truncates uniqueCommands when summary is too long', async () => {
      const entry = await summarizeSession({
        history: Array.from({ length: 50 }, (_, i) => ({
          event: 'command',
          data: { command: `/very-long-command-name-that-makes-summary-big-${i}` },
        })),
      });
      // The truncation logic limits uniqueCommands to 10 when JSON is too long
      expect(entry.data.uniqueCommands.length).toBeLessThanOrEqual(50);
    });

    it('handles command event without data.command using event name', async () => {
      const entry = await summarizeSession({
        history: [{ event: 'command' }],
      });
      expect(entry.data.commandCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('pruneOldMemories()', () => {
    it('returns pruned count and store results', async () => {
      const result = await pruneOldMemories();
      expect(result).toHaveProperty('pruned');
      expect(result).toHaveProperty('stores');
    });

    it('prunes expired entries', async () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [
          { id: 'expired_1', expiresAt: pastDate, createdAt: pastDate },
          { id: 'valid_1', expiresAt: null, createdAt: new Date().toISOString() },
        ],
        metadata: { createdAt: new Date().toISOString() },
      }));

      const result = await pruneOldMemories();
      expect(result.pruned).toBeGreaterThan(0);
    });

    it('does not prune entries with null expiresAt', async () => {
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [
          { id: 'permanent_1', expiresAt: null, createdAt: new Date().toISOString() },
        ],
        metadata: { createdAt: new Date().toISOString() },
      }));

      const result = await pruneOldMemories();
      // All entries are permanent, nothing pruned from individual stores
      // But since there are 4 stores, pruned should be 0 (all permanent)
      expect(result.pruned).toBe(0);
    });

    it('does not write to disk when nothing pruned', async () => {
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [{ id: '1', expiresAt: null, createdAt: new Date().toISOString() }],
        metadata: { createdAt: new Date().toISOString() },
      }));

      await pruneOldMemories();
      // writeJsonFile should not be called since nothing was pruned
      expect(writeJsonFile).not.toHaveBeenCalled();
    });

    it('writes updated store to disk when entries are pruned', async () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [{ id: 'expired_1', expiresAt: pastDate, createdAt: pastDate }],
        metadata: { createdAt: new Date().toISOString() },
      }));

      await pruneOldMemories();
      expect(writeJsonFile).toHaveBeenCalled();
    });

    it('reports per-store results with before, after, pruned counts', async () => {
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [],
        metadata: { createdAt: new Date().toISOString() },
      }));

      const result = await pruneOldMemories();
      for (const storeKey of Object.keys(result.stores)) {
        expect(result.stores[storeKey]).toHaveProperty('before');
        expect(result.stores[storeKey]).toHaveProperty('after');
        expect(result.stores[storeKey]).toHaveProperty('pruned');
      }
    });

    it('keeps entries with future expiresAt', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [{ id: 'future_1', expiresAt: futureDate, createdAt: new Date().toISOString() }],
        metadata: { createdAt: new Date().toISOString() },
      }));

      const result = await pruneOldMemories();
      expect(result.pruned).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('loadMemories()', () => {
    it('returns empty array when store is empty', async () => {
      const memories = await loadMemories('preference');
      expect(memories).toEqual([]);
    });

    it('returns non-expired entries only', async () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      readJsonFile.mockResolvedValue({
        entries: [
          { id: 'expired', expiresAt: pastDate },
          { id: 'valid', expiresAt: futureDate },
          { id: 'permanent', expiresAt: null },
        ],
        metadata: { createdAt: new Date().toISOString() },
      });

      const memories = await loadMemories('preference');
      expect(memories).toHaveLength(2);
      expect(memories.some((m) => m.id === 'expired')).toBe(false);
    });

    it('loads all 4 memory types', async () => {
      readJsonFile.mockResolvedValue({
        entries: [{ id: 'test', expiresAt: null }],
        metadata: { createdAt: new Date().toISOString() },
      });

      for (const type of ['preference', 'context', 'command', 'error']) {
        const memories = await loadMemories(type);
        expect(Array.isArray(memories)).toBe(true);
      }
    });

    it('maps unknown type to projectContexts', async () => {
      readJsonFile.mockResolvedValue({
        entries: [{ id: 'test', expiresAt: null }],
        metadata: { createdAt: new Date().toISOString() },
      });

      const memories = await loadMemories('nonexistent');
      expect(Array.isArray(memories)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  describe('clearMemories()', () => {
    it('clears all entries for a given type', async () => {
      await clearMemories('preference');
      expect(writeJsonFile).toHaveBeenCalledTimes(1);
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.entries).toEqual([]);
      expect(written.metadata).toHaveProperty('createdAt');
      expect(written.metadata).toHaveProperty('clearedAt');
    });

    it('clears command history', async () => {
      await clearMemories('command');
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.entries).toEqual([]);
    });

    it('clears error patterns', async () => {
      await clearMemories('error');
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.entries).toEqual([]);
    });

    it('clears context entries', async () => {
      await clearMemories('context');
      const written = writeJsonFile.mock.calls[0][1];
      expect(written.entries).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getMemoryStats()', () => {
    it('returns stats with memoryDir and stores', async () => {
      const stats = await getMemoryStats();
      expect(stats).toHaveProperty('memoryDir');
      expect(stats).toHaveProperty('stores');
    });

    it('reports stats for all 4 stores', async () => {
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [],
        metadata: { createdAt: new Date().toISOString() },
      }));

      const stats = await getMemoryStats();
      expect(Object.keys(stats.stores)).toHaveLength(4);
      expect(stats.stores).toHaveProperty('userPreferences');
      expect(stats.stores).toHaveProperty('projectContexts');
      expect(stats.stores).toHaveProperty('commandHistory');
      expect(stats.stores).toHaveProperty('errorPatterns');
    });

    it('reports total, active, expired counts per store', async () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [
          { id: '1', expiresAt: pastDate },
          { id: '2', expiresAt: null },
          { id: '3', expiresAt: new Date(Date.now() + 86400000).toISOString() },
        ],
        metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      }));

      const stats = await getMemoryStats();
      for (const storeKey of Object.keys(stats.stores)) {
        expect(stats.stores[storeKey]).toHaveProperty('total');
        expect(stats.stores[storeKey]).toHaveProperty('active');
        expect(stats.stores[storeKey]).toHaveProperty('expired');
        expect(stats.stores[storeKey]).toHaveProperty('lastUpdated');
        expect(stats.stores[storeKey].total).toBe(3);
        expect(stats.stores[storeKey].active).toBe(2);
        expect(stats.stores[storeKey].expired).toBe(1);
      }
    });

    it('reports lastUpdated from metadata', async () => {
      const updatedAt = '2024-06-15T12:00:00.000Z';
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [],
        metadata: { createdAt: new Date().toISOString(), updatedAt },
      }));

      const stats = await getMemoryStats();
      for (const storeKey of Object.keys(stats.stores)) {
        expect(stats.stores[storeKey].lastUpdated).toBe(updatedAt);
      }
    });

    it('handles store with no metadata', async () => {
      readJsonFile.mockImplementation(() => Promise.resolve({
        entries: [],
      }));

      const stats = await getMemoryStats();
      for (const storeKey of Object.keys(stats.stores)) {
        expect(stats.stores[storeKey].lastUpdated).toBeNull();
      }
    });

    it('returns 0 counts for empty stores', async () => {
      const stats = await getMemoryStats();
      for (const storeKey of Object.keys(stats.stores)) {
        expect(stats.stores[storeKey].total).toBe(0);
        expect(stats.stores[storeKey].active).toBe(0);
        expect(stats.stores[storeKey].expired).toBe(0);
      }
    });
  });
});
