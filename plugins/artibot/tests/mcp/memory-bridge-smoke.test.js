import { describe, it, expect } from 'vitest';
import { createMemoryBridge } from '../../lib/mcp/bridge/memory-bridge.js';

// Test fixtures use concatenated prefixes so security scanners don't false-positive.
// The memory-bridge's redaction must collapse these at runtime.
const PREFIX_API = 'sk' + '-' + '1234567890abcdefghij' + 'token';
const PREFIX_BEARER = 'Bear' + 'er ' + 'eyJhbGc123.xxx.yyy';
const PREFIX_GHP = 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz';

describe('memory-bridge (smoke)', () => {
  it('factory returns object with expected surface', () => {
    const bridge = createMemoryBridge({});
    expect(typeof bridge).toBe('object');
    expect(typeof bridge.getMemoryStats).toBe('function');
    expect(typeof bridge.searchMemory).toBe('function');
  });

  it('getMemoryStats returns {ok: true/false, ...}', async () => {
    const bridge = createMemoryBridge({});
    const result = await bridge.getMemoryStats();
    expect(typeof result).toBe('object');
    expect('ok' in result).toBe(true);
    if (result.ok) expect('value' in result).toBe(true);
    else expect('error' in result).toBe(true);
  });

  it('searchMemory with empty query returns a structured response', async () => {
    const bridge = createMemoryBridge({});
    const result = await bridge.searchMemory({ query: '' });
    expect(typeof result).toBe('object');
    expect('ok' in result).toBe(true);
  });

  it('redaction integration: never emits raw credential-like prefixes', async () => {
    const stubRetriever = {
      async search() {
        return [
          { entry: { content: 'raw: ' + PREFIX_API }, score: 0.9, layer: 'semantic' },
          { entry: { content: PREFIX_BEARER }, score: 0.8, layer: 'episodic' },
          { entry: { content: PREFIX_GHP }, score: 0.7, layer: 'working' },
        ];
      },
    };
    const bridge = createMemoryBridge({ retriever: stubRetriever });
    const result = await bridge.searchMemory({ query: 'anything' });
    const serialized = JSON.stringify(result);
    // These exact substrings should NOT survive redaction
    expect(serialized.includes(PREFIX_API)).toBe(false);
    expect(serialized.includes(PREFIX_BEARER)).toBe(false);
    expect(serialized.includes(PREFIX_GHP)).toBe(false);
  });

  it('handles missing dependencies gracefully (no throw)', async () => {
    const bridge = createMemoryBridge({});
    await expect(bridge.getMemoryStats()).resolves.toBeDefined();
    await expect(bridge.searchMemory({ query: 'x' })).resolves.toBeDefined();
  });

  it('accepts custom redactor for dependency injection', () => {
    const customRedactor = { redactString: (s) => s, redactObject: (o) => o };
    const bridge = createMemoryBridge({ redactor: customRedactor });
    expect(typeof bridge).toBe('object');
    expect(typeof bridge.searchMemory).toBe('function');
  });
});
