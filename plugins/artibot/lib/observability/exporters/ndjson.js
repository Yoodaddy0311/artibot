/**
 * Local NDJSON span exporter. Writes only to runtime/traces/ on disk.
 * NO HTTP/network egress. DATA POLICY compliant.
 * @module lib/observability/exporters/ndjson
 */

import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';

function defaultDir() {
  return join(process.cwd(), 'runtime', 'traces');
}

function safeName(s) {
  return String(s ?? 'session').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

export class NdjsonExporter {
  constructor({ dir, file } = {}) {
    this.dir = dir ?? defaultDir();
    this.file = file ?? null;
  }

  resolveFile(spans) {
    if (this.file) {
      return isAbsolute(this.file) ? this.file : join(this.dir, this.file);
    }
    const sessionId = safeName(spans?.[0]?.sessionId ?? 'session');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return join(this.dir, `${sessionId}-${ts}.ndjson`);
  }

  /**
   * Write spans as NDJSON. Creates target directory if missing.
   * @param {Array<object>} spans
   * @returns {Promise<{path: string, count: number}>}
   */
  async export(spans) {
    if (!Array.isArray(spans) || spans.length === 0) {
      return { path: null, count: 0 };
    }
    const target = this.resolveFile(spans);
    await mkdir(dirname(target), { recursive: true });
    const lines = spans.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await appendFile(target, lines, 'utf-8');
    return { path: target, count: spans.length };
  }
}
