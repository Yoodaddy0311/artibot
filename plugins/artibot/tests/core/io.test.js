import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeJSON, writeText, writeError, writeHookResult, readStdinJSON, readStdin } from '../../lib/core/io.js';

describe('io', () => {
  let stdoutSpy;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('writeJSON()', () => {
    it('writes JSON string to stdout', () => {
      writeJSON({ key: 'value' });
      expect(stdoutSpy).toHaveBeenCalledWith('{"key":"value"}');
    });

    it('handles nested objects', () => {
      writeJSON({ a: { b: 1 } });
      expect(stdoutSpy).toHaveBeenCalledWith('{"a":{"b":1}}');
    });

    it('handles arrays', () => {
      writeJSON([1, 2, 3]);
      expect(stdoutSpy).toHaveBeenCalledWith('[1,2,3]');
    });
  });

  describe('writeText()', () => {
    it('writes plain text to stdout', () => {
      writeText('hello');
      expect(stdoutSpy).toHaveBeenCalledWith('hello');
    });

    it('writes empty string', () => {
      writeText('');
      expect(stdoutSpy).toHaveBeenCalledWith('');
    });
  });

  describe('writeError()', () => {
    it('writes error JSON object', () => {
      writeError('something went wrong');
      expect(stdoutSpy).toHaveBeenCalledWith('{"error":"something went wrong"}');
    });
  });

  describe('writeHookResult()', () => {
    it('writes approve decision', () => {
      writeHookResult('approve');
      expect(stdoutSpy).toHaveBeenCalledWith('{"decision":"approve"}');
    });

    it('writes block decision with reason', () => {
      writeHookResult('block', 'not allowed');
      expect(stdoutSpy).toHaveBeenCalledWith('{"decision":"block","reason":"not allowed"}');
    });

    it('writes info decision without reason', () => {
      writeHookResult('info');
      expect(stdoutSpy).toHaveBeenCalledWith('{"decision":"info"}');
    });

    it('includes reason only when provided', () => {
      writeHookResult('approve', undefined);
      const output = JSON.parse(stdoutSpy.mock.calls[0][0]);
      expect(output).not.toHaveProperty('reason');
    });
  });

  describe('readStdin()', () => {
    let originalStdin;

    beforeEach(() => {
      originalStdin = process.stdin;
    });

    afterEach(() => {
      Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true });
    });

    it('reads all data chunks and returns joined string', async () => {
      const mockStdin = new EventEmitter();
      mockStdin.setEncoding = vi.fn();
      mockStdin.resume = vi.fn();
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const promise = readStdin();
      mockStdin.emit('data', 'hello ');
      mockStdin.emit('data', 'world');
      mockStdin.emit('end');

      const result = await promise;
      expect(result).toBe('hello world');
    });

    it('returns empty string when stdin is empty', async () => {
      const mockStdin = new EventEmitter();
      mockStdin.setEncoding = vi.fn();
      mockStdin.resume = vi.fn();
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const promise = readStdin();
      mockStdin.emit('end');

      const result = await promise;
      expect(result).toBe('');
    });

    it('calls setEncoding with utf-8', async () => {
      const mockStdin = new EventEmitter();
      mockStdin.setEncoding = vi.fn();
      mockStdin.resume = vi.fn();
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const promise = readStdin();
      mockStdin.emit('end');
      await promise;

      expect(mockStdin.setEncoding).toHaveBeenCalledWith('utf-8');
    });

    it('calls resume on stdin', async () => {
      const mockStdin = new EventEmitter();
      mockStdin.setEncoding = vi.fn();
      mockStdin.resume = vi.fn();
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const promise = readStdin();
      mockStdin.emit('end');
      await promise;

      expect(mockStdin.resume).toHaveBeenCalled();
    });
  });

  describe('readStdinJSON()', () => {
    let originalStdin;

    beforeEach(() => {
      originalStdin = process.stdin;
    });

    afterEach(() => {
      Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true });
    });

    it('parses valid JSON from stdin', async () => {
      const mockStdin = new EventEmitter();
      mockStdin.setEncoding = vi.fn();
      mockStdin.resume = vi.fn();
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const promise = readStdinJSON();
      mockStdin.emit('data', '{"key":"value"}');
      mockStdin.emit('end');

      const result = await promise;
      expect(result).toEqual({ key: 'value' });
    });

    it('returns null for empty stdin', async () => {
      const mockStdin = new EventEmitter();
      mockStdin.setEncoding = vi.fn();
      mockStdin.resume = vi.fn();
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const promise = readStdinJSON();
      mockStdin.emit('end');

      const result = await promise;
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      const mockStdin = new EventEmitter();
      mockStdin.setEncoding = vi.fn();
      mockStdin.resume = vi.fn();
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const promise = readStdinJSON();
      mockStdin.emit('data', 'not valid json {{{');
      mockStdin.emit('end');

      const result = await promise;
      expect(result).toBeNull();
    });

    it('handles multi-chunk JSON input', async () => {
      const mockStdin = new EventEmitter();
      mockStdin.setEncoding = vi.fn();
      mockStdin.resume = vi.fn();
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const promise = readStdinJSON();
      mockStdin.emit('data', '{"a":');
      mockStdin.emit('data', '1}');
      mockStdin.emit('end');

      const result = await promise;
      expect(result).toEqual({ a: 1 });
    });
  });
});
