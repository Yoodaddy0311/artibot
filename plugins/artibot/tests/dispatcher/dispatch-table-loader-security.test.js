/**
 * Security regression tests for lib/dispatcher/dispatch-table-loader.js.
 *
 * v4.8.0 H-4: a malicious or accidentally-edited dispatch-table.json must not
 * be able to point handlers outside scripts/hooks/. The loader rejects
 * traversal entries (`../`, absolute paths, NUL bytes) at load time.
 *
 * Strategy: stub `fs.readFileSync` so we can feed crafted JSON into the loader
 * without touching the real dispatch-table.json (which would race with the
 * parallel `dispatch-table.test.js` worker).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  _resetCacheForTests,
  getTablePath,
  loadDispatchTable,
} from '../../lib/dispatcher/dispatch-table-loader.js';

describe('dispatch-table-loader script-path containment (H-4)', () => {
  const realReadFileSync = fs.readFileSync;
  const TABLE_PATH = getTablePath();
  let stubContent = null;

  beforeEach(() => {
    _resetCacheForTests();
    stubContent = null;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
      if (p === TABLE_PATH && stubContent !== null) return stubContent;
      return realReadFileSync(p, ...rest);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetCacheForTests();
  });

  function setTable(json) {
    stubContent = JSON.stringify(json, null, 2);
    _resetCacheForTests();
  }

  it('rejects parent-directory traversal in script', () => {
    setTable({
      version: 1,
      slots: {
        Evil: {
          label: 'e',
          strategy: 'test',
          handlers: [
            { name: 'pwn', script: '../../../etc/passwd', timeoutMs: 100 },
          ],
        },
      },
    });
    expect(() => loadDispatchTable('Evil')).toThrow(/escapes hooks dir/);
  });

  it('rejects absolute paths in script', () => {
    const absHostile = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\cmd.exe'
      : '/etc/passwd';
    setTable({
      version: 1,
      slots: {
        Evil: {
          label: 'e',
          strategy: 'test',
          handlers: [{ name: 'pwn', script: absHostile, timeoutMs: 100 }],
        },
      },
    });
    expect(() => loadDispatchTable('Evil')).toThrow(/relative path/);
  });

  it('rejects NUL byte injection in script', () => {
    setTable({
      version: 1,
      slots: {
        Evil: {
          label: 'e',
          strategy: 'test',
          handlers: [{ name: 'pwn', script: 'ok.js\u0000evil', timeoutMs: 100 }],
        },
      },
    });
    expect(() => loadDispatchTable('Evil')).toThrow(/relative path/);
  });

  it('accepts a simple legitimate relative script entry', () => {
    setTable({
      version: 1,
      slots: {
        Test: {
          label: 't',
          strategy: 'test',
          handlers: [
            { name: 'sample', script: 'noop-handler.js', timeoutMs: 100 },
          ],
        },
      },
    });
    const handlers = loadDispatchTable('Test');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].script.endsWith('noop-handler.js')).toBe(true);
  });
});
