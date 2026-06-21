/**
 * Genesis file-tree generator — renders a project's planned file tree as a
 * code-fenced ASCII tree plus a directory-responsibility table, and writes it
 * to `docs/FILE-TREE.md`.
 *
 * Pure & non-destructive (collision → `-NN` suffix), Korean-path safe, atomic,
 * no network (DATA POLICY). The command/model builds the structured `tree`
 * object; this module only transforms it into markdown (IO boundary).
 *
 * @module lib/genesis/tree-gen
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
 * @typedef {object} TreeNode
 * @property {string} name - File or directory name.
 * @property {TreeNode[]} [children] - Present (even if empty) ⇒ directory.
 * @property {string} [note] - Optional responsibility/description note.
 */

/**
 * Render a single tree level into ASCII branch lines, recursing into children.
 * @param {TreeNode[]} nodes
 * @param {string} prefix - Accumulated indentation/branch prefix.
 * @param {string[]} out - Output accumulator (mutated locally).
 * @returns {void}
 */
function renderLevel(nodes, prefix, out) {
  const list = Array.isArray(nodes) ? nodes : [];
  list.forEach((node, i) => {
    const isLast = i === list.length - 1;
    const branch = isLast ? '└── ' : '├── ';
    const name = String(node?.name ?? '').trim() || '(unnamed)';
    const isDir = Array.isArray(node?.children);
    const label = isDir ? `${name}/` : name;
    const note = node?.note ? `  # ${String(node.note).replace(/\r?\n/g, ' ').trim()}` : '';
    out.push(`${prefix}${branch}${label}${note}`);
    if (isDir) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      renderLevel(node.children, childPrefix, out);
    }
  });
}

/**
 * Collect directory nodes (those with a `children` array) that carry a `note`,
 * as `{ pathLabel, note }` rows for the responsibility table.
 * @param {TreeNode[]} nodes
 * @param {string} parentPath
 * @param {Array<{pathLabel: string, note: string}>} out
 * @returns {void}
 */
function collectDirRows(nodes, parentPath, out) {
  const list = Array.isArray(nodes) ? nodes : [];
  for (const node of list) {
    if (!Array.isArray(node?.children)) continue;
    const name = String(node?.name ?? '').trim() || '(unnamed)';
    const pathLabel = parentPath ? `${parentPath}/${name}` : name;
    if (node?.note) out.push({ pathLabel: `${pathLabel}/`, note: String(node.note) });
    collectDirRows(node.children, pathLabel, out);
  }
}

/**
 * Render the full FILE-TREE markdown from a tree spec. Pure (no IO, no clock).
 *
 * @param {TreeNode|TreeNode[]} tree - Root node, or an array of root entries.
 * @returns {string} Markdown: code-fenced tree + directory-responsibility table.
 */
export function renderFileTree(tree) {
  // Accept either a single root node or a list of top-level entries.
  let roots;
  let rootLabel = '.';
  if (Array.isArray(tree)) {
    roots = tree;
  } else if (tree && Array.isArray(tree.children)) {
    roots = tree.children;
    rootLabel = `${String(tree.name ?? '.').trim() || '.'}/`;
  } else if (tree && typeof tree === 'object') {
    roots = [tree];
  } else {
    roots = [];
  }

  const treeLines = [rootLabel];
  renderLevel(roots, '', treeLines);

  const dirRows = [];
  collectDirRows(roots, '', dirRows);

  const tableHead = '| 디렉터리 | 책임 |\n|---|---|';
  const tableBody = dirRows.length
    ? dirRows.map((r) => `| \`${cell(r.pathLabel)}\` | ${cell(r.note)} |`).join('\n')
    : '| _(없음)_ | 디렉터리 책임 노트가 제공되지 않음 |';

  return (
    '# FILE-TREE\n\n'
    + '> Genesis 청사진 — 프로젝트 파일트리 (계획). 자동 생성, 비파괴.\n\n'
    + '## 파일트리\n\n'
    + '```text\n'
    + treeLines.join('\n')
    + '\n```\n\n'
    + '## 디렉터리 책임\n\n'
    + `${tableHead}\n${tableBody}\n`
  );
}

/**
 * Write the rendered file tree to `docs/FILE-TREE.md` under `projectRoot`.
 * Non-destructive: collisions get a `-NN` suffix. Failure-tolerant.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Absolute project root.
 * @param {TreeNode|TreeNode[]} args.tree - Tree spec (see {@link renderFileTree}).
 * @param {(() => Date)|Date} [args.now] - Injectable clock.
 * @returns {Promise<{ ok: boolean, treePath?: string, error?: string }>}
 */
export async function writeFileTree({ projectRoot, tree, now } = {}) {
  try {
    if (!projectRoot) return { ok: false, error: 'projectRoot required' };
    const when = resolveNow(now);
    const dir = path.join(projectRoot, 'docs');
    const treePath = await nonCollidingPath(dir, 'FILE-TREE', '.md');
    const body = renderFileTree(tree);
    const content = `${body}\n---\n생성: ${humanStamp(when)}\n`;
    await atomicWriteText(treePath, content);
    return { ok: true, treePath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
