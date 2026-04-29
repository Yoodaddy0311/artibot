/**
 * Session interface (ABC) and two zero-dep backends.
 * Pattern adopted from openai-agents-python memory/session.py (AD-05).
 * No sqlite or external DB; in-memory + JSON file only.
 * @module lib/learning/session
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * Abstract base class. Subclasses MUST override all five methods.
 */
export class Session {
  constructor({ id } = {}) {
    if (!id || typeof id !== 'string') {
      throw new TypeError('Session requires string id');
    }
    this.id = id;
  }

  // eslint-disable-next-line no-unused-vars
  async getItems(limit) {
    throw new Error('getItems() must be implemented by subclass');
  }

  // eslint-disable-next-line no-unused-vars
  async addItems(items) {
    throw new Error('addItems() must be implemented by subclass');
  }

  async popItem() {
    throw new Error('popItem() must be implemented by subclass');
  }

  async clearSession() {
    throw new Error('clearSession() must be implemented by subclass');
  }
}

export class InMemorySession extends Session {
  constructor({ id }) {
    super({ id });
    this._items = [];
  }

  async getItems(limit) {
    if (typeof limit === 'number' && limit >= 0) {
      return this._items.slice(-limit);
    }
    return this._items.slice();
  }

  async addItems(items) {
    if (!Array.isArray(items)) {
      throw new TypeError('addItems expects an array');
    }
    for (const item of items) {
      this._items.push(item);
    }
    return items.length;
  }

  async popItem() {
    return this._items.pop() ?? null;
  }

  async clearSession() {
    this._items.length = 0;
  }
}

function defaultDir() {
  return join(process.cwd(), 'runtime', 'sessions');
}

export class JsonFileSession extends Session {
  constructor({ id, dir } = {}) {
    super({ id });
    this.dir = dir ?? defaultDir();
    this.path = isAbsolute(this.dir)
      ? join(this.dir, `${id}.json`)
      : join(process.cwd(), this.dir, `${id}.json`);
  }

  async _read() {
    try {
      const buf = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(buf);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async _write(items) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(items, null, 2), 'utf-8');
  }

  async getItems(limit) {
    const items = await this._read();
    if (typeof limit === 'number' && limit >= 0) {
      return items.slice(-limit);
    }
    return items;
  }

  async addItems(items) {
    if (!Array.isArray(items)) {
      throw new TypeError('addItems expects an array');
    }
    const current = await this._read();
    const next = current.concat(items);
    await this._write(next);
    return items.length;
  }

  async popItem() {
    const current = await this._read();
    const popped = current.pop() ?? null;
    await this._write(current);
    return popped;
  }

  async clearSession() {
    try {
      await unlink(this.path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}
