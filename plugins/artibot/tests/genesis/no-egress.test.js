/**
 * DATA POLICY regression: the three genesis renderers must perform ZERO network
 * egress. Imports all three modules and runs each write path while spying on
 * `globalThis.fetch`, `node:http.request`, `node:https.request`, and
 * `node:net.connect` — asserting none are ever called.
 *
 * @module tests/genesis/no-egress
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { writeFileTree } from '../../lib/genesis/tree-gen.js';
import { writeWorkflow } from '../../lib/genesis/flow-gen.js';
import { writeDatasets } from '../../lib/genesis/dataset-gen.js';
import { writeClaudeScaffold } from '../../lib/genesis/scaffold-gen.js';

const FIXED = new Date(2026, 5, 21, 9, 5);
const fixedNow = () => FIXED;

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), '제네시스-egress-'));
}

describe('genesis / no network egress (DATA POLICY)', () => {
  let root;
  let fetchSpy;
  let httpSpy;
  let httpsSpy;
  let netSpy;
  let originalFetch;

  beforeEach(() => {
    root = tmpRoot();
    originalFetch = globalThis.fetch;
    // Ensure fetch exists to spy on, regardless of runtime.
    globalThis.fetch = globalThis.fetch || (() => Promise.resolve());
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(undefined);
    httpSpy = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('blocked'); });
    httpsSpy = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('blocked'); });
    netSpy = vi.spyOn(net, 'connect').mockImplementation(() => { throw new Error('blocked'); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it('writeFileTree performs no egress', async () => {
    const res = await writeFileTree({
      projectRoot: root,
      tree: { name: 'app', children: [{ name: 'src', children: [], note: 'code' }] },
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(netSpy).not.toHaveBeenCalled();
  });

  it('writeWorkflow performs no egress', async () => {
    const res = await writeWorkflow({
      projectRoot: root,
      flows: {
        workflow: [{ step: 1, action: 'go' }],
        featureFlows: [{ name: 'f', nodes: ['a', 'b'], edges: [['a', 'b']] }],
      },
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(netSpy).not.toHaveBeenCalled();
  });

  it('writeDatasets performs no egress', async () => {
    const res = await writeDatasets({
      projectRoot: root,
      schemas: [{ entity: 'User', fields: [{ name: 'id', type: 'uuid' }] }],
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(netSpy).not.toHaveBeenCalled();
  });

  it('writeClaudeScaffold performs no egress', async () => {
    const res = await writeClaudeScaffold({
      projectRoot: root,
      spec: {
        projectName: 'p',
        domain: 'd',
        skills: [{ name: 's' }],
        hooks: [{ event: 'PostToolUse' }],
        mcp: [{ name: 'x', url: 'https://evil.example.com' }],
      },
      now: fixedNow,
    });
    expect(res.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(netSpy).not.toHaveBeenCalled();
  });
});
