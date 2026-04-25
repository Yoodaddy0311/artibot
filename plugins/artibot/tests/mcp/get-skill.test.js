import { describe, expect, it } from 'vitest';
import { getSkillTool } from '../../lib/mcp/tools/get-skill.js';

describe('getSkillTool — schema', () => {
  it('exposes the expected MCP tool descriptor', () => {
    expect(getSkillTool.name).toBe('artibot.get_skill');
    expect(typeof getSkillTool.description).toBe('string');
    expect(getSkillTool.inputSchema.required).toEqual(['name']);
    expect(getSkillTool.inputSchema.properties.name.type).toBe('string');
  });

  it('descriptor is frozen', () => {
    expect(Object.isFrozen(getSkillTool)).toBe(true);
    expect(Object.isFrozen(getSkillTool.inputSchema)).toBe(true);
  });
});

describe('getSkillTool — handler', () => {
  it('rejects empty name', async () => {
    await expect(getSkillTool.handler({ name: '' })).rejects.toThrow(/invalid skill name/);
  });

  it('rejects whitespace-only name', async () => {
    await expect(getSkillTool.handler({ name: '   ' })).rejects.toThrow(/invalid skill name/);
  });

  it('rejects path-traversal attempts', async () => {
    await expect(getSkillTool.handler({ name: '../etc/passwd' }))
      .rejects.toThrow(/invalid skill name/);
    await expect(getSkillTool.handler({ name: 'foo/bar' }))
      .rejects.toThrow(/invalid skill name/);
  });

  it('rejects names with uppercase or underscores', async () => {
    await expect(getSkillTool.handler({ name: 'BadName' }))
      .rejects.toThrow(/invalid skill name/);
    await expect(getSkillTool.handler({ name: 'with_underscore' }))
      .rejects.toThrow(/invalid skill name/);
  });

  it('rejects non-string name', async () => {
    await expect(getSkillTool.handler({ name: 123 })).rejects.toThrow(/invalid skill name/);
    await expect(getSkillTool.handler({})).rejects.toThrow(/invalid skill name/);
    await expect(getSkillTool.handler()).rejects.toThrow(/invalid skill name/);
  });

  it('rejects names that pass the regex but reference a missing skill', async () => {
    await expect(getSkillTool.handler({ name: 'definitely-not-a-real-skill-xyz' }))
      .rejects.toThrow(/skill not found/);
  });

  it('returns SKILL.md content for a real plugin skill', async () => {
    // "ad" exists in plugins/artibot/skills/.
    const result = await getSkillTool.handler({ name: 'ab-testing' });
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content[0].type).toBe('text');
    expect(typeof result.content[0].text).toBe('string');
    expect(result.metadata.name).toBe('ab-testing');
    expect(result.metadata.bytes).toBeGreaterThan(0);
    expect(result.metadata.path).toMatch(/SKILL\.md$/);
  });

  it('trims whitespace around valid names', async () => {
    const result = await getSkillTool.handler({ name: '  ab-testing  ' });
    expect(result.metadata.name).toBe('ab-testing');
  });
});
