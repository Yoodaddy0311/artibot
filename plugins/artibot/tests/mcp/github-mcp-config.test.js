/**
 * Tests for GitHub MCP server registration in .mcp.json (v4.7.5 PoC).
 *
 * The official server is registered via remote HTTP transport and
 * authenticates with the user's PAT, read from the GITHUB_TOKEN env var.
 * These tests pin the contract so future edits don't accidentally:
 *   - swap to an unofficial npm package
 *   - leak a hard-coded token
 *   - drop the entry from .mcp.json
 *   - drop the corresponding allow-list pattern
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..', '..');

function readJson(relPath) {
  return JSON.parse(readFileSync(resolve(pluginRoot, relPath), 'utf8'));
}

describe('.mcp.json — github entry', () => {
  const mcpConfig = readJson('.mcp.json');

  it('parses as valid JSON', () => {
    expect(mcpConfig).toBeTypeOf('object');
    expect(mcpConfig.mcpServers).toBeTypeOf('object');
  });

  it('keeps existing context7 and playwright entries', () => {
    expect(mcpConfig.mcpServers.context7).toBeDefined();
    expect(mcpConfig.mcpServers.playwright).toBeDefined();
  });

  it('registers a github entry', () => {
    expect(mcpConfig.mcpServers.github).toBeDefined();
  });

  describe('github entry shape', () => {
    const github = mcpConfig.mcpServers.github;

    it('uses http transport (official remote server)', () => {
      expect(github.type).toBe('http');
    });

    it('points at the official GitHub MCP URL', () => {
      expect(github.url).toBe('https://api.githubcopilot.com/mcp/');
    });

    it('passes a Bearer token via Authorization header', () => {
      expect(github.headers).toBeTypeOf('object');
      expect(github.headers.Authorization).toBe('Bearer ${GITHUB_TOKEN}');
    });

    it('does not hard-code a real token', () => {
      const auth = github.headers?.Authorization ?? '';
      expect(auth).not.toMatch(/Bearer\s+(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/);
    });

    it('does not use an unofficial npm package via npx', () => {
      expect(github.command).toBeUndefined();
      expect(github.args).toBeUndefined();
    });
  });
});

describe('artibot.config.json — autopilot.mcp.allowList', () => {
  const config = readJson('artibot.config.json');
  const mcp = config.autopilot?.mcp;

  it('defines an mcp section under autopilot', () => {
    expect(mcp).toBeTypeOf('object');
    expect(Array.isArray(mcp.allowList)).toBe(true);
  });

  it('keeps existing artibot self-plugin entries', () => {
    expect(mcp.allowList).toContain('plugin:artibot:context7');
    expect(mcp.allowList).toContain('plugin:artibot:playwright');
  });

  it('allows the github MCP toolset (read-only)', () => {
    expect(mcp.allowList).toContain('mcp__github__*');
  });

  it('permits the official github MCP host through denyHostPatterns', () => {
    const negativeLookahead = mcp.denyHostPatterns?.find((p) => p.includes('localhost'));
    expect(negativeLookahead).toBeDefined();
    expect(negativeLookahead).toContain('api\\.githubcopilot\\.com');
  });
});
