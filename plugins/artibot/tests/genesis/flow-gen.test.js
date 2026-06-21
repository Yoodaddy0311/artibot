/**
 * Tests for the genesis workflow generator (renderWorkflow / writeWorkflow).
 * @module tests/genesis/flow-gen
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderWorkflow, writeWorkflow } from '../../lib/genesis/flow-gen.js';

const FIXED = new Date(2026, 5, 21, 9, 5);
const fixedNow = () => FIXED;

function tmpRoot() {
  return mkdtempSync(path.join(os.tmpdir(), '제네시스-flow-'));
}

const FLOWS = {
  workflow: [
    { step: 1, action: 'INTAKE 아이디어 분석' },
    { step: 2, action: 'BLUEPRINT 문서 생성' },
    { step: 3, action: 'SCAFFOLD .claude 구조' },
  ],
  featureFlows: [
    {
      name: '로그인',
      nodes: ['시작', '검증', '발급'],
      edges: [['시작', '검증'], { from: '검증', to: '발급', label: 'ok' }],
    },
  ],
};

describe('flow-gen / renderWorkflow', () => {
  it('emits a static mermaid flowchart for the workflow (no render engine)', () => {
    const md = renderWorkflow(FLOWS);
    expect(md).toContain('```mermaid');
    expect(md).toContain('flowchart TD');
    expect(md).toContain('1. INTAKE 아이디어 분석');
    expect(md).toContain('n0 --> n1');
    expect(md).toContain('n1 --> n2');
  });

  it('renders the workflow step table', () => {
    const md = renderWorkflow(FLOWS);
    expect(md).toContain('| 단계 | 동작 |');
    expect(md).toContain('| 1 | INTAKE 아이디어 분석 |');
    expect(md).toContain('| 3 | SCAFFOLD .claude 구조 |');
  });

  it('renders per-feature flowchart with labeled edges', () => {
    const md = renderWorkflow(FLOWS);
    expect(md).toContain('### 로그인');
    expect(md).toContain('flowchart LR');
    expect(md).toContain('["시작"]');
    expect(md).toContain('-->|ok|');
  });

  it('tolerates empty / missing input', () => {
    expect(renderWorkflow(undefined)).toContain('# WORKFLOW');
    const md = renderWorkflow({});
    expect(md).toContain('워크플로우 단계 없음');
    expect(md).toContain('기능 플로우가 제공되지 않음');
  });

  it('handles an empty feature flow and edges to unknown nodes', () => {
    const md = renderWorkflow({
      workflow: [],
      featureFlows: [
        { name: '빈것', nodes: [], edges: [] },
        // edge references a node label not in `nodes` → falls back to sanitized id
        { name: '미스', nodes: ['A'], edges: [{ from: 'A', to: 'GHOST' }, 'bad-edge'] },
      ],
    });
    expect(md).toContain('노드 없음');
    expect(md).toContain('### 미스');
    expect(md).toContain('--> GHOST'); // unknown-node fallback rendered
  });
});

describe('flow-gen / writeWorkflow', () => {
  let root;
  beforeEach(() => { root = tmpRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes docs/WORKFLOW.md with rendered content + stamp', async () => {
    const res = await writeWorkflow({ projectRoot: root, flows: FLOWS, now: fixedNow });
    expect(res.ok).toBe(true);
    expect(res.workflowPath).toBe(path.join(root, 'docs', 'WORKFLOW.md'));
    const body = readFileSync(res.workflowPath, 'utf-8');
    expect(body).toContain('flowchart TD');
    expect(body).toContain('### 로그인');
    expect(body).toContain('생성: 2026-06-21 09:05');
  });

  it('non-collision: second write gets a -2 suffix (prior survives)', async () => {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'WORKFLOW.md'), 'pre-existing', 'utf-8');

    const res = await writeWorkflow({ projectRoot: root, flows: FLOWS, now: fixedNow });
    expect(res.workflowPath).toBe(path.join(root, 'docs', 'WORKFLOW-2.md'));
    expect(readFileSync(path.join(root, 'docs', 'WORKFLOW.md'), 'utf-8')).toBe('pre-existing');
    const files = readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(['WORKFLOW-2.md', 'WORKFLOW.md']);
  });

  it('returns {ok:false} when projectRoot missing', async () => {
    const res = await writeWorkflow({ flows: FLOWS });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/projectRoot/);
  });
});
