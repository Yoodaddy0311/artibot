/**
 * File checkpoint system for snapshot-based backup and restore.
 * Stores file snapshots in a session-scoped temp directory as JSON files,
 * enabling point-in-time recovery before destructive write operations.
 *
 * @module lib/core/file-checkpoint
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Maximum number of snapshots retained per instance (FIFO eviction). */
const MAX_SNAPSHOTS = 10;

/** Maximum file size in bytes eligible for snapshotting (1 MB). */
const MAX_FILE_SIZE = 1_048_576;

/**
 * File-level checkpoint system with FIFO eviction.
 *
 * @example
 * const cp = new FileCheckpoint('sess-123');
 * cp.snapshot('/path/to/file.js');
 * cp.restore('/path/to/file.js');
 */
export class FileCheckpoint {
  /**
   * @param {string} [sessionId] - Unique session identifier. Auto-generated if omitted.
   * @param {object} [options]
   * @param {number} [options.maxSnapshots=10] - Maximum snapshots before FIFO eviction.
   */
  constructor(sessionId, options = {}) {
    this._sessionId = sessionId || randomUUID();
    this._maxSnapshots = options.maxSnapshots || MAX_SNAPSHOTS;
    this._dir = join(tmpdir(), `artibot-file-checkpoints-${this._sessionId}`);
    this._ensureDir();
  }

  /** @returns {string} The checkpoint storage directory path. */
  get dir() {
    return this._dir;
  }

  /**
   * Take a snapshot of a file's current contents.
   *
   * @param {string} filePath - Absolute path to the file to snapshot.
   * @returns {{ filePath: string, content: string, timestamp: number, size: number } | null}
   *   The snapshot record, or null if the file does not exist.
   */
  snapshot(filePath) {
    if (!filePath || !existsSync(filePath)) return null;

    if (statSync(filePath).size > MAX_FILE_SIZE) {
      process.stderr.write(
        `[artibot:file-checkpoint] Skipping snapshot for large file (>1MB): ${filePath}\n`,
      );
      return null;
    }

    const content = readFileSync(filePath, 'utf-8');
    const record = Object.freeze({
      filePath,
      content,
      timestamp: Date.now(),
      size: Buffer.byteLength(content, 'utf-8'),
    });

    this._ensureDir();
    this._evictIfNeeded();

    const snapshotName = `${Date.now()}-${basename(filePath)}.json`;
    writeFileSync(
      join(this._dir, snapshotName),
      JSON.stringify(record),
      'utf-8',
    );

    return record;
  }

  /**
   * Restore a file from its most recent snapshot.
   *
   * Retained intentionally for a future `/rollback`-style restore path:
   * the PreToolUse `pre-write-checkpoint` hook continuously snapshots, but
   * no command currently calls `restore()`. It is exercised by unit tests
   * and kept as the consumer-facing recovery API. Do NOT remove without
   * also removing the snapshot hot path.
   *
   * @param {string} filePath - Absolute path to the file to restore.
   * @returns {boolean} True if restored, false if no snapshot found.
   */
  restore(filePath) {
    const history = this.getHistory(filePath);
    if (history.length === 0) return false;

    const latest = history[history.length - 1];
    writeFileSync(filePath, latest.content, 'utf-8');
    return true;
  }

  /**
   * List all stored snapshots, sorted by timestamp ascending.
   *
   * @returns {Array<{ filePath: string, content: string, timestamp: number, size: number }>}
   */
  list() {
    if (!existsSync(this._dir)) return [];

    return readdirSync(this._dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this._readSnapshot(join(this._dir, f)))
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get snapshot history for a specific file, sorted by timestamp ascending.
   *
   * @param {string} filePath - Absolute path to query.
   * @returns {Array<{ filePath: string, content: string, timestamp: number, size: number }>}
   */
  getHistory(filePath) {
    return this.list().filter((s) => s.filePath === filePath);
  }

  /**
   * Remove all snapshots from the checkpoint directory.
   */
  clear() {
    if (!existsSync(this._dir)) return;

    for (const f of readdirSync(this._dir)) {
      if (f.endsWith('.json')) {
        try { unlinkSync(join(this._dir, f)); } catch { /* ignore */ }
      }
    }
  }

  // ─── Internal ────────────────────────────────────────────────────

  /** @private */
  _ensureDir() {
    if (!existsSync(this._dir)) {
      mkdirSync(this._dir, { recursive: true });
    }
  }

  /** @private */
  _evictIfNeeded() {
    const files = existsSync(this._dir)
      ? readdirSync(this._dir).filter((f) => f.endsWith('.json')).sort()
      : [];

    while (files.length >= this._maxSnapshots) {
      const oldest = files.shift();
      try { unlinkSync(join(this._dir, oldest)); } catch { /* ignore */ }
    }
  }

  /** @private */
  _readSnapshot(fullPath) {
    try {
      return JSON.parse(readFileSync(fullPath, 'utf-8'));
    } catch {
      return null;
    }
  }
}
