/**
 * Regression guard for plugins/artibot/.mcp.json.
 *
 * The GitHub MCP server was removed (see docs/MCP-SETUP.md). These tests pin
 * the current contract so future edits don't accidentally:
 *   - re-introduce the github entry
 *   - drop one of the three shipped servers (context7 / playwright / chrome-devtools)
 *   - leak a hard-coded token
 *   - float a server off its exact version (@latest, another dist-tag, a range,
 *     or no version at all)
 *
 * Bumping a pin means editing three places together: the args in .mcp.json,
 * the expected strings in the `points the expected package at each server`
 * test below, and the measured versions in docs/MCP-SETUP.md.
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
      it(`${name} uses npx with an exact-semver-pinned package (never @latest)`, () => {
        const entry = mcpConfig.mcpServers[name];
        expect(entry.command).toBe('npx');
        expect(Array.isArray(entry.args)).toBe(true);
        expect(entry.args).toHaveLength(2);
        expect(entry.args[0]).toBe('-y');
        // Allowlist, not a ban list: whatever follows the last `@` must be exactly
        // MAJOR.MINOR.PATCH. That rejects @latest, @next, ranges (@^4.1.1, @4.1,
        // @4) and a missing version (the slice then returns the package name).
        const version = entry.args[1].slice(entry.args[1].lastIndexOf('@') + 1);
        expect(version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(entry.args[1]).not.toMatch(/@latest$/);
      });
    }
  });

  it('points the expected package at each server', () => {
    expect(mcpConfig.mcpServers.context7.args).toEqual([
      '-y',
      '@upstash/context7-mcp@4.1.1',
    ]);
    expect(mcpConfig.mcpServers.playwright.args).toEqual([
      '-y',
      '@executeautomation/playwright-mcp-server@1.0.12',
    ]);
    expect(mcpConfig.mcpServers['chrome-devtools'].args).toEqual([
      '-y',
      'chrome-devtools-mcp@1.10.1',
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
