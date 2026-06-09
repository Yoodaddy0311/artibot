/**
 * Regression guard for plugins/artibot/.mcp.json.
 *
 * The GitHub MCP server was removed (see docs/MCP-SETUP.md). These tests pin
 * the current contract so future edits don't accidentally:
 *   - re-introduce the github entry
 *   - drop one of the three shipped servers (context7 / playwright / chrome-devtools)
 *   - leak a hard-coded token
 *   - swap a pinned package for an unpinned one
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

describe('.mcp.json — server registry', () => {
  const mcpConfig = readJson('.mcp.json');

  it('parses as valid JSON with an mcpServers object', () => {
    expect(mcpConfig).toBeTypeOf('object');
    expect(mcpConfig.mcpServers).toBeTypeOf('object');
  });

  it('registers exactly three servers: context7, playwright, chrome-devtools', () => {
    expect(Object.keys(mcpConfig.mcpServers).sort()).toEqual([
      'chrome-devtools',
      'context7',
      'playwright',
    ]);
  });

  it('does NOT register a github entry (removed)', () => {
    expect(mcpConfig.mcpServers.github).toBeUndefined();
  });

  describe('every server is a pinned stdio/npx server', () => {
    for (const name of ['context7', 'playwright', 'chrome-devtools']) {
      it(`${name} uses npx with a version-pinned @latest package`, () => {
        const entry = mcpConfig.mcpServers[name];
        expect(entry.command).toBe('npx');
        expect(Array.isArray(entry.args)).toBe(true);
        expect(entry.args[0]).toBe('-y');
        expect(entry.args[1]).toMatch(/@latest$/);
      });
    }
  });

  it('points the expected package at each server', () => {
    expect(mcpConfig.mcpServers.context7.args).toEqual([
      '-y',
      '@upstash/context7-mcp@latest',
    ]);
    expect(mcpConfig.mcpServers.playwright.args).toEqual([
      '-y',
      '@executeautomation/playwright-mcp-server@latest',
    ]);
    expect(mcpConfig.mcpServers['chrome-devtools'].args).toEqual([
      '-y',
      'chrome-devtools-mcp@latest',
    ]);
  });

  it('does not hard-code any token or secret-shaped value', () => {
    const raw = readFileSync(resolve(pluginRoot, '.mcp.json'), 'utf8');
    expect(raw).not.toMatch(/github_pat_|ghp_|gho_|ghu_|ghs_|ghr_/);
    expect(raw).not.toMatch(/Authorization/i);
  });

  it('uses no http/remote transport (all servers are local stdio)', () => {
    for (const entry of Object.values(mcpConfig.mcpServers)) {
      expect(entry.type).toBeUndefined();
      expect(entry.url).toBeUndefined();
      expect(entry.headers).toBeUndefined();
    }
  });
});
