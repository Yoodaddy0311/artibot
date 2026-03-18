/**
 * Runtime skills middleware.
 * Provides lightweight skill recommendations from detected commands/intents.
 *
 * @module lib/runtime/middleware/skills
 */

/**
 * @param {object} [options]
 * @param {Record<string, string[]>} [options.intentToSkills] - Optional intent->skills map.
 * @returns {(state: object) => Promise<object>}
 */
export function createSkillsMiddleware(options = {}) {
  const { intentToSkills = {} } = options;

  return async function skillsMiddleware(state) {
    const intentInfo = state.context.intent || {};
    const bestCommand = intentInfo.commands?.[0];
    const bestIntent = intentInfo.best;
    const suggested = [];

    if (bestCommand) {
      const fromCommand = bestCommand.replace(/^\//, 'cmd-');
      suggested.push(fromCommand);
    }

    if (bestIntent && Array.isArray(intentToSkills[bestIntent])) {
      suggested.push(...intentToSkills[bestIntent]);
    }

    const deduped = [...new Set(suggested)];
    state.context.skills = {
      suggested: deduped,
      source: 'intent-derived',
    };

    state.messageParts.push(`skills=${deduped.length}`);
    return state;
  };
}

