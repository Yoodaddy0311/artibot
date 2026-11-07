import { describe, expect, it } from 'vitest';
import {
  agentAsTool,
  defaultSummarizer,
} from '../../../lib/orchestration/agent-as-tool.js';

describe('agentAsTool()', () => {
  it('rejects missing invoke', () => {
    expect(() => agentAsTool({}, { name: 'x', description: 'y' })).toThrow(TypeError);
  });

  it('rejects missing name or description', () => {
    expect(() => agentAsTool({ invoke: async () => ({}) }, { description: 'y' })).toThrow(
      TypeError,
    );
    expect(() => agentAsTool({ invoke: async () => ({}) }, { name: 'n' })).toThrow(TypeError);
  });

  it('returns a tool spec with kind=agent-as-tool', () => {
    const tool = agentAsTool(
      { name: 'a', invoke: async () => ({ output: 'hi' }) },
      { name: 'ask_specialist', description: 'asks specialist' },
    );
    expect(tool.kind).toBe('agent-as-tool');
    expect(tool.name).toBe('ask_specialist');
    expect(typeof tool.invoke).toBe('function');
  });

  it('invokes the underlying agent and returns string', async () => {
    const tool = agentAsTool(
      { name: 'a', invoke: async (args) => ({ output: `echo:${args.q}` }) },
      { name: 'specialist', description: 'd' },
    );
    const out = await tool.invoke({ q: 'hello' });
    expect(out).toBe('echo:hello');
  });

  it('uses custom summarizer when provided', async () => {
    const tool = agentAsTool(
      { name: 'a', invoke: async () => ({ output: 'x', extra: 1 }) },
      {
        name: 't',
        description: 'd',
        summarizer: (r) => `summary:${r.extra}`,
      },
    );
    expect(await tool.invoke({})).toBe('summary:1');
  });

  it('defaultSummarizer prefers last assistant item', () => {
    const items = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'more' },
      { role: 'assistant', content: 'final' },
    ];
    expect(defaultSummarizer({ items })).toBe('final');
  });

  it('defaultSummarizer falls back to output', () => {
    expect(defaultSummarizer({ output: 'plain' })).toBe('plain');
    expect(defaultSummarizer({})).toBe('');
  });
});
