/**
 * Genesis workflow generator — renders the project's high-level workflow and
 * per-feature flows as STATIC mermaid text (flowchart + sequenceDiagram) plus a
 * step table, and writes `docs/WORKFLOW.md`.
 *
 * Pure & non-destructive (collision → `-NN` suffix), Korean-path safe, atomic,
 * no network (DATA POLICY). Emits mermaid as plain strings only — never invokes
 * a mermaid render engine. The command/model builds the structured `flows`
 * object; this module only transforms it into markdown (IO boundary).
 *
 * @module lib/genesis/flow-gen
 */

import path from 'node:path';
import {
  atomicWriteText,
  cell,
  humanStamp,
  nonCollidingPath,
  resolveNow,
} from './_shared.js';

/**
 * @typedef {object} WorkflowStep
 * @property {string|number} step - Step identifier/order.
 * @property {string} action - What happens at this step.
 */

/**
 * @typedef {object} FeatureFlow
 * @property {string} name - Feature/flow name.
 * @property {string[]} nodes - Node labels.
 * @property {Array<[string, string]|{from: string, to: string, label?: string}>} edges -
 *   Directed edges between node labels.
 */

/**
 * @typedef {object} Flows
 * @property {WorkflowStep[]} [workflow] - Top-level linear workflow steps.
 * @property {FeatureFlow[]} [featureFlows] - Per-feature flow graphs.
 */

/** Sanitize a label so it is safe inside a mermaid node bracket. */
function mermaidLabel(value) {
  return String(value ?? '')
    .replace(/[[\]{}()"]/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim() || 'node';
}

/** Deterministic node id from an index (n0, n1, ...). */
function nodeId(i) {
  return `n${i}`;
}

/**
 * Render the top-level workflow as a static mermaid `flowchart TD`.
 * @param {WorkflowStep[]} workflow
 * @returns {string}
 */
function renderWorkflowChart(workflow) {
  const steps = Array.isArray(workflow) ? workflow : [];
  if (!steps.length) {
    return '```mermaid\nflowchart TD\n    empty["(워크플로우 단계 없음)"]\n```';
  }
  const lines = ['```mermaid', 'flowchart TD'];
  steps.forEach((s, i) => {
    const id = nodeId(i);
    const label = mermaidLabel(`${s?.step ?? i + 1}. ${s?.action ?? ''}`);
    lines.push(`    ${id}["${label}"]`);
  });
  for (let i = 0; i < steps.length - 1; i += 1) {
    lines.push(`    ${nodeId(i)} --> ${nodeId(i + 1)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * Render the workflow step table.
 * @param {WorkflowStep[]} workflow
 * @returns {string}
 */
function renderWorkflowTable(workflow) {
  const steps = Array.isArray(workflow) ? workflow : [];
  const head = '| 단계 | 동작 |\n|---|---|';
  if (!steps.length) return `${head}\n| _(없음)_ | 단계가 제공되지 않음 |`;
  const body = steps
    .map((s) => `| ${cell(s?.step ?? '')} | ${cell(s?.action ?? '')} |`)
    .join('\n');
  return `${head}\n${body}`;
}

/**
 * Normalize an edge entry into `{ from, to, label }`.
 * @param {[string,string]|{from:string,to:string,label?:string}} edge
 * @returns {{from: string, to: string, label: string}|null}
 */
function normalizeEdge(edge) {
  if (Array.isArray(edge)) {
    return { from: String(edge[0] ?? ''), to: String(edge[1] ?? ''), label: '' };
  }
  if (edge && typeof edge === 'object') {
    return {
      from: String(edge.from ?? ''),
      to: String(edge.to ?? ''),
      label: String(edge.label ?? ''),
    };
  }
  return null;
}

/**
 * Render one feature flow as a static mermaid `flowchart LR`.
 * @param {FeatureFlow} flow
 * @returns {string}
 */
function renderFeatureChart(flow) {
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const edges = Array.isArray(flow?.edges) ? flow.edges : [];
  const idByLabel = new Map();
  const lines = ['```mermaid', 'flowchart LR'];
  nodes.forEach((label, i) => {
    const id = nodeId(i);
    idByLabel.set(String(label), id);
    lines.push(`    ${id}["${mermaidLabel(label)}"]`);
  });
  for (const raw of edges) {
    const e = normalizeEdge(raw);
    if (!e) continue;
    const fromId = idByLabel.get(e.from) ?? mermaidLabel(e.from);
    const toId = idByLabel.get(e.to) ?? mermaidLabel(e.to);
    const arrow = e.label ? `-->|${mermaidLabel(e.label)}|` : '-->';
    lines.push(`    ${fromId} ${arrow} ${toId}`);
  }
  if (!nodes.length && !edges.length) {
    lines.push('    empty["(노드 없음)"]');
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * Render the full WORKFLOW markdown from a flows spec. Pure (no IO, no clock).
 * Mermaid is emitted as static text only — no render engine is invoked.
 *
 * @param {Flows} flows
 * @returns {string}
 */
export function renderWorkflow(flows) {
  const src = flows && typeof flows === 'object' ? flows : {};
  const featureFlows = Array.isArray(src.featureFlows) ? src.featureFlows : [];

  const features = featureFlows.length
    ? featureFlows
      .map((f) => `### ${cell(f?.name ?? '기능')}\n\n${renderFeatureChart(f)}`)
      .join('\n\n')
    : '_(기능 플로우가 제공되지 않음)_';

  return (
    '# WORKFLOW\n\n'
    + '> Genesis 청사진 — 워크플로우 + 기능 플로우 (정적 mermaid 텍스트, 렌더 X).\n\n'
    + '## 워크플로우 (개요)\n\n'
    + `${renderWorkflowChart(src.workflow)}\n\n`
    + '## 단계\n\n'
    + `${renderWorkflowTable(src.workflow)}\n\n`
    + '## 기능 플로우\n\n'
    + `${features}\n`
  );
}

/**
 * Write the rendered workflow to `docs/WORKFLOW.md` under `projectRoot`.
 * Non-destructive: collisions get a `-NN` suffix. Failure-tolerant.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute project root.
 * @param {Flows} args.flows - Flows spec (see {@link renderWorkflow}).
 * @param {(() => Date)|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, workflowPath?: string, error?: string }>}
 */
export async function writeWorkflow({ projectRoot, flows, now } = {}) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    const when = resolveNow(now);
    const dir = path.join(projectRoot, 'docs');
    const workflowPath = await nonCollidingPath(dir, 'WORKFLOW', '.md');
    const body = renderWorkflow(flows);
    const content = `${body}\n---\n생성: ${humanStamp(when)}\n`;
    await atomicWriteText(workflowPath, content);
    return { ok: true, workflowPath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
