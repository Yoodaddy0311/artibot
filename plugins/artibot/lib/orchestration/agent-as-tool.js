/**
 * Wrap an agent specification as a tool spec consumable by the tool layer.
 * Pattern adopted from openai-agents-python AgentTool (AD-03). Builder-only:
 * does NOT spawn subprocesses; the runner injects the actual agent invoker.
 * @module lib/orchestration/agent-as-tool
 */

/**
 * @typedef {Object} AgentSpec
 * @property {string} name
 * @property {string} [description]
 * @property {(args: any, ctx?: any) => Promise<{output: string, items?: any[]}>} invoke
 *   Required runner callable. Tests inject a mock; production wires Agent Teams runner.
 */

/**
 * @typedef {Object} ToolSpec
 * @property {string} name
 * @property {string} description
 * @property {(args: any, ctx?: any) => Promise<string>} invoke
 * @property {string} kind
 */

/**
 * Build a tool spec that runs the wrapped agent and returns a string summary.
 * @param {AgentSpec} agentSpec
 * @param {object} options
 * @param {string} options.name - Tool name (must be unique within tool list)
 * @param {string} options.description - Description for the calling LLM
 * @param {(result: {output: string, items?: any[]}) => string} [options.summarizer]
 * @returns {ToolSpec}
 */
export function agentAsTool(agentSpec, { name, description, summarizer } = {}) {
  if (!agentSpec || typeof agentSpec.invoke !== 'function') {
    throw new TypeError('agentSpec must define invoke()');
  }
  if (!name || typeof name !== 'string') {
    throw new TypeError('options.name is required');
  }
  if (!description || typeof description !== 'string') {
    throw new TypeError('options.description is required');
  }
  const summarize = typeof summarizer === 'function'
    ? summarizer
    : (r) => (typeof r?.output === 'string' ? r.output : JSON.stringify(r ?? ''));

  return {
    kind: 'agent-as-tool',
    name,
    description,
    async invoke(args, ctx) {
      const result = await agentSpec.invoke(args, ctx);
      return summarize(result);
    },
  };
}

/**
 * Default summarizer: prefer last assistant text, fallback to output field.
 * @param {{output?: string, items?: any[]}} result
 * @returns {string}
 */
export function defaultSummarizer(result) {
  if (Array.isArray(result?.items)) {
    for (let i = result.items.length - 1; i >= 0; i -= 1) {
      const item = result.items[i];
      if (item?.role === 'assistant' && typeof item.content === 'string') {
        return item.content;
      }
    }
  }
  return typeof result?.output === 'string' ? result.output : '';
}
