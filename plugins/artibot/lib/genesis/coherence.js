/**
 * Genesis cross-document coherence checker — the `/go` blueprint emits SIX
 * documents (PRD / FILE-TREE / WORKFLOW / DATASETS / …) from a single
 * one-shot generation pass. The classic failure of one-shot generation is that
 * the documents silently contradict each other: a dataset entity that never
 * appears in the file tree, a workflow step that maps to no feature, a flow
 * edge that points at a non-existent node, a relation that targets a missing
 * entity. This module catches those inconsistencies in code, before the
 * blueprint is trusted.
 *
 * Pure function by construction: no IO, no clock, no network (DATA POLICY).
 * It only reads the same structured input objects the three renderers consume
 * (see `tree-gen.js` / `flow-gen.js` / `dataset-gen.js`) and returns a verdict.
 * Input is graceful: missing fields are treated as empty — it never throws.
 *
 * @module lib/genesis/coherence
 */

/**
 * @typedef {object} TreeNode
 * @property {string} name - File or directory name.
 * @property {TreeNode[]} [children] - Present ⇒ directory.
 * @property {string} [note] - Optional responsibility note.
 */

/**
 * @typedef {object} WorkflowStep
 * @property {string|number} [step] - Step identifier/order.
 * @property {string} [action] - What happens at this step.
 */

/**
 * @typedef {object} FeatureFlow
 * @property {string} [name] - Feature/flow name.
 * @property {string[]} [nodes] - Node labels.
 * @property {Array<[string,string]|{from?:string,to?:string,label?:string}>} [edges] -
 *   Directed edges between node labels.
 */

/**
 * @typedef {object} Flows
 * @property {WorkflowStep[]} [workflow] - Top-level linear workflow steps.
 * @property {FeatureFlow[]} [featureFlows] - Per-feature flow graphs.
 */

/**
 * @typedef {object} SchemaSpec
 * @property {string} [entity] - Entity name.
 * @property {Array<object>} [fields] - Field definitions (metadata only).
 * @property {Array<string|{target?:string,to?:string,entity?:string}>} [relations] -
 *   Relationship definitions; may reference other entities.
 */

/**
 * @typedef {object} CoherenceIssue
 * @property {'error'|'warn'} severity - `error` blocks `ok`; `warn` is advisory.
 * @property {string} kind - Stable machine-readable issue category.
 * @property {string} detail - Human-readable explanation.
 */

/**
 * @typedef {object} CoherenceResult
 * @property {boolean} ok - True iff there are zero `error`-severity issues.
 * @property {CoherenceIssue[]} issues - All detected issues (errors + warns).
 */

/** Coerce any value to a normalized comparison token (lowercase, alnum only). */
function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Coerce to an array, treating null/undefined/non-arrays as empty. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Walk a tree (single root, root-with-children, or array of roots) and collect
 * every node name as a normalized token. Tolerates arbitrary shapes.
 * @param {TreeNode|TreeNode[]|undefined} tree
 * @returns {Set<string>} Normalized name tokens present anywhere in the tree.
 */
function collectTreeTokens(tree) {
  const tokens = new Set();
  const stack = [];
  if (Array.isArray(tree)) stack.push(...tree);
  else if (tree && typeof tree === 'object') stack.push(tree);

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const token = norm(node.name);
    if (token) tokens.add(token);
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return tokens;
}

/**
 * Singularize a normalized entity token heuristically so that an entity `User`
 * still matches a `users/` directory or `users.ts` file (and vice-versa).
 * Returns the candidate token variants to test against the tree.
 * @param {string} token - Already-normalized entity token.
 * @returns {string[]} Distinct candidate tokens (includes singular/plural).
 */
function entityVariants(token) {
  const variants = new Set([token]);
  if (token.endsWith('ies') && token.length > 3) variants.add(`${token.slice(0, -3)}y`);
  if (token.endsWith('es') && token.length > 2) variants.add(token.slice(0, -2));
  if (token.endsWith('s') && token.length > 1) variants.add(token.slice(0, -1));
  variants.add(`${token}s`);
  variants.add(`${token}es`);
  return [...variants].filter(Boolean);
}

/**
 * Test whether an entity leaves a trace anywhere in the tree token set. A trace
 * is a substring match in either direction (entity token inside a filename, or
 * a filename token inside the entity) across singular/plural variants.
 * @param {string} entityToken
 * @param {Set<string>} treeTokens
 * @returns {boolean}
 */
function entityInTree(entityToken, treeTokens) {
  if (!entityToken) return false;
  const variants = entityVariants(entityToken);
  for (const fileToken of treeTokens) {
    for (const v of variants) {
      if (!v) continue;
      if (fileToken.includes(v) || v.includes(fileToken)) return true;
    }
  }
  return false;
}

/**
 * Rule 1 — orphan dataset: each schema entity should leave a trace in the file
 * tree (a directory or file named after it, singular or plural). If not, the
 * dataset has no home in the planned codebase. Severity: warn.
 * @param {SchemaSpec[]} schemas
 * @param {Set<string>} treeTokens
 * @param {CoherenceIssue[]} issues - mutated.
 * @returns {void}
 */
function checkOrphanDatasets(schemas, treeTokens, issues) {
  for (const schema of schemas) {
    const entity = schema?.entity;
    const token = norm(entity);
    if (!token) continue;
    if (!entityInTree(token, treeTokens)) {
      issues.push({
        severity: 'warn',
        kind: 'dataset-not-in-tree',
        detail: `데이터셋 엔티티 '${entity}'가 파일트리 어디에도 흔적이 없음 (파일/디렉터리명 미발견)`,
      });
    }
  }
}

/**
 * Build the set of normalized "mappable" tokens that a workflow step/feature
 * may legitimately reference: PRD feature names, schema entities, and tree
 * node names. Returns both an exact-token set and the raw token list for
 * substring matching.
 * @param {string[]} prdFeatures
 * @param {SchemaSpec[]} schemas
 * @param {Set<string>} treeTokens
 * @returns {string[]} Distinct normalized anchor tokens.
 */
function buildAnchorTokens(prdFeatures, schemas, treeTokens) {
  const anchors = new Set();
  for (const f of prdFeatures) {
    const t = norm(f);
    if (t) anchors.add(t);
  }
  for (const s of schemas) {
    const t = norm(s?.entity);
    if (t) anchors.add(t);
  }
  for (const t of treeTokens) anchors.add(t);
  return [...anchors].filter(Boolean);
}

/**
 * Test whether a workflow label maps to any anchor token via bidirectional
 * substring match (label mentions an anchor, or an anchor mentions the label).
 * @param {string} labelToken
 * @param {string[]} anchors
 * @returns {boolean}
 */
function labelMapsToAnchor(labelToken, anchors) {
  if (!labelToken) return false;
  for (const a of anchors) {
    if (!a) continue;
    if (labelToken.includes(a) || a.includes(labelToken)) return true;
  }
  return false;
}

/**
 * Rule 2 — dangling workflow step: each workflow step (its action text) and
 * each feature-flow name should map to some PRD feature / entity / tree node.
 * Steps that map to nothing are orphaned planning. Severity: warn.
 * @param {Flows} flows
 * @param {string[]} anchors
 * @param {CoherenceIssue[]} issues - mutated.
 * @returns {void}
 */
function checkWorkflowOrphans(flows, anchors, issues) {
  const workflow = asArray(flows?.workflow);
  workflow.forEach((s, i) => {
    const labelToken = norm(`${s?.action ?? ''}${s?.step ?? ''}`);
    if (!labelToken) return;
    if (!labelMapsToAnchor(labelToken, anchors)) {
      const label = String(s?.action ?? s?.step ?? `#${i + 1}`);
      issues.push({
        severity: 'warn',
        kind: 'workflow-orphan',
        detail: `워크플로우 단계 '${label}'가 어떤 PRD 기능/엔티티/파일과도 매핑되지 않음`,
      });
    }
  });

  for (const flow of asArray(flows?.featureFlows)) {
    const nameToken = norm(flow?.name);
    if (!nameToken) continue;
    if (!labelMapsToAnchor(nameToken, anchors)) {
      issues.push({
        severity: 'warn',
        kind: 'workflow-orphan',
        detail: `기능 플로우 '${flow?.name}'가 어떤 PRD 기능/엔티티/파일과도 매핑되지 않음`,
      });
    }
  }
}

/** Normalize an edge endpoint label from tuple or object form. */
function edgeEndpoints(edge) {
  if (Array.isArray(edge)) return { from: edge[0], to: edge[1] };
  if (edge && typeof edge === 'object') return { from: edge.from, to: edge.to };
  return { from: undefined, to: undefined };
}

/**
 * Rule 3 (part) — broken flow edge: every feature-flow edge endpoint must
 * reference a declared node label. An edge pointing at an undeclared node is a
 * structurally broken graph. Severity: error.
 * @param {Flows} flows
 * @param {CoherenceIssue[]} issues - mutated.
 * @returns {void}
 */
function checkBrokenFlowEdges(flows, issues) {
  for (const flow of asArray(flows?.featureFlows)) {
    const declared = new Set(asArray(flow?.nodes).map((n) => norm(n)));
    for (const raw of asArray(flow?.edges)) {
      const { from, to } = edgeEndpoints(raw);
      for (const [role, endpoint] of [['from', from], ['to', to]]) {
        const token = norm(endpoint);
        // An empty endpoint OR one that is not a declared node is broken.
        if (!token || !declared.has(token)) {
          issues.push({
            severity: 'error',
            kind: 'broken-flow-edge',
            detail: `기능 플로우 '${flow?.name ?? '(이름없음)'}'의 엣지 ${role} 끝점 `
              + `'${endpoint ?? '(빈값)'}'이(가) 선언된 노드가 아님`,
          });
        }
      }
    }
  }
}

/**
 * Rule 3 (part) — empty blueprint: if the entire blueprint carries no tree,
 * no flows, and no schemas, there is nothing coherent to ship. Severity: error.
 * @param {Set<string>} treeTokens
 * @param {Flows} flows
 * @param {SchemaSpec[]} schemas
 * @param {CoherenceIssue[]} issues - mutated.
 * @returns {void}
 */
function checkEmptyBlueprint(treeTokens, flows, schemas, issues) {
  const hasTree = treeTokens.size > 0;
  const hasFlows = asArray(flows?.workflow).length > 0 || asArray(flows?.featureFlows).length > 0;
  const hasSchemas = schemas.length > 0;
  if (!hasTree && !hasFlows && !hasSchemas) {
    issues.push({
      severity: 'error',
      kind: 'empty-blueprint',
      detail: '청사진이 비어 있음 — 파일트리/플로우/스키마가 모두 없음',
    });
  }
}

/**
 * Resolve a relation entry to its target entity token, tolerating string and
 * object forms (`target` / `to` / `entity` keys).
 * @param {string|{target?:string,to?:string,entity?:string}} relation
 * @returns {string} Normalized target token, or '' if none resolvable.
 */
function relationTargetToken(relation) {
  if (typeof relation === 'string') return norm(relation);
  if (relation && typeof relation === 'object') {
    return norm(relation.target ?? relation.to ?? relation.entity ?? '');
  }
  return '';
}

/**
 * Rule 4 — dangling relation: each schema relation must target a declared
 * entity. A relation pointing at a non-existent entity breaks referential
 * integrity of the data model. Severity: error.
 *
 * String relations are free-form prose (e.g. "User 1:N (자유 서술)") and are
 * only flagged when their resolved token clearly fails to contain any known
 * entity token — otherwise prose is given the benefit of the doubt.
 * @param {SchemaSpec[]} schemas
 * @param {CoherenceIssue[]} issues - mutated.
 * @returns {void}
 */
function checkDanglingRelations(schemas, issues) {
  const entityTokens = new Set();
  for (const s of schemas) {
    const t = norm(s?.entity);
    if (t) entityTokens.add(t);
  }

  for (const schema of schemas) {
    for (const relation of asArray(schema?.relations)) {
      const isString = typeof relation === 'string';
      const targetToken = relationTargetToken(relation);

      // Structured relation with an explicit but absent target ⇒ error.
      if (!isString) {
        if (!targetToken) continue; // no target declared — nothing to validate
        if (!entityTokens.has(targetToken)) {
          issues.push({
            severity: 'error',
            kind: 'dangling-relation',
            detail: `엔티티 '${schema?.entity}'의 관계가 존재하지 않는 엔티티 '${displayTarget(relation)}'을(를) 가리킴`,
          });
        }
        continue;
      }

      // Free-form string relation: only flag if it mentions NO known entity.
      if (!targetToken) continue;
      let mentionsKnown = false;
      for (const et of entityTokens) {
        if (et && targetToken.includes(et)) { mentionsKnown = true; break; }
      }
      if (!mentionsKnown) {
        issues.push({
          severity: 'error',
          kind: 'dangling-relation',
          detail: `엔티티 '${schema?.entity}'의 관계 서술 '${relation}'이(가) 어떤 엔티티도 참조하지 않음`,
        });
      }
    }
  }
}

/** Best-effort human label for a relation target (object or string). */
function displayTarget(relation) {
  if (typeof relation === 'string') return relation;
  return String(relation?.target ?? relation?.to ?? relation?.entity ?? '(미상)');
}

/**
 * Cross-check the six-document blueprint for internal contradictions.
 *
 * Pure function: no IO, no network, no mutation of input. Missing fields are
 * treated as empty (graceful) — it never throws on malformed input.
 *
 * Rules:
 *  1. `dataset-not-in-tree` (warn) — schema entity has no trace in the tree.
 *  2. `workflow-orphan` (warn) — workflow step / feature-flow name maps to no
 *     PRD feature, entity, or tree node.
 *  3. `broken-flow-edge` (error) — a feature-flow edge references an undeclared
 *     node; `empty-blueprint` (error) — tree+flows+schemas are all empty.
 *  4. `dangling-relation` (error) — a relation targets a non-existent entity.
 *
 * @param {object} input
 * @param {TreeNode|TreeNode[]} [input.tree] - File-tree spec (tree-gen shape).
 * @param {Flows} [input.flows] - Workflow + feature-flow spec (flow-gen shape).
 * @param {SchemaSpec[]} [input.schemas] - Entity schemas (dataset-gen shape).
 * @param {string[]} [input.prdFeatures] - PRD feature names for mapping.
 * @returns {CoherenceResult} `{ ok, issues }` — `ok` iff zero error issues.
 */
export function checkCoherence({ tree, flows, schemas, prdFeatures } = {}) {
  const schemaList = asArray(schemas);
  const features = asArray(prdFeatures);
  const treeTokens = collectTreeTokens(tree);
  const anchors = buildAnchorTokens(features, schemaList, treeTokens);

  /** @type {CoherenceIssue[]} */
  const issues = [];

  checkEmptyBlueprint(treeTokens, flows, schemaList, issues);
  checkOrphanDatasets(schemaList, treeTokens, issues);
  checkWorkflowOrphans(flows, anchors, issues);
  checkBrokenFlowEdges(flows, issues);
  checkDanglingRelations(schemaList, issues);

  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, issues };
}
