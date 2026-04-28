/**
 * Input/Output Guardrails with tripwire semantics.
 * Pattern adopted from openai-agents-python (AD-01). Pattern-only; zero new deps.
 * @module lib/orchestration/guardrails
 */

export class GuardrailTripped extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'GuardrailTripped';
    this.info = info ?? null;
  }
}

export class Guardrail {
  constructor({ name, run }) {
    if (!name || typeof name !== 'string') {
      throw new TypeError('Guardrail requires string name');
    }
    if (typeof run !== 'function') {
      throw new TypeError('Guardrail requires run function');
    }
    this.name = name;
    this.run = run;
  }
}

/**
 * Run guardrails in parallel; the first tripwire short-circuits behavior.
 * @param {Guardrail[]} guardrails
 * @param {object} ctx
 * @param {*} input
 * @returns {Promise<{tripped: boolean, results: Array<{name: string, tripwireTriggered: boolean, info: any}>}>}
 */
export async function runAll(guardrails, ctx, input) {
  if (!Array.isArray(guardrails) || guardrails.length === 0) {
    return { tripped: false, results: [] };
  }
  const settled = await Promise.all(
    guardrails.map(async (g) => {
      const out = await g.run(ctx, input);
      const tripwireTriggered = Boolean(out?.tripwireTriggered);
      return {
        name: g.name,
        tripwireTriggered,
        info: out?.info ?? null,
      };
    }),
  );
  const tripped = settled.some((r) => r.tripwireTriggered);
  return { tripped, results: settled };
}

/**
 * Convenience: run guardrails and throw GuardrailTripped on first trip.
 * @param {Guardrail[]} guardrails
 * @param {object} ctx
 * @param {*} input
 */
export async function runOrThrow(guardrails, ctx, input) {
  const result = await runAll(guardrails, ctx, input);
  if (result.tripped) {
    const first = result.results.find((r) => r.tripwireTriggered);
    throw new GuardrailTripped(`Guardrail tripped: ${first.name}`, first.info);
  }
  return result;
}
