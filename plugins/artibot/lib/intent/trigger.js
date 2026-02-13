/**
 * Intent-to-recommendation trigger mapping.
 * Maps detected intents to agent, skill, or command recommendations.
 * @module lib/intent/trigger
 */

/**
 * Recommendation entries.
 * Each intent maps to suggested agents, skills, or commands.
 */
const TRIGGER_MAP = {
  'team:summon': {
    type: 'team',
    description: 'Team orchestration requested',
    agents: ['orchestrator'],
    commands: ['/spawn'],
  },
  'action:build': {
    type: 'action',
    description: 'Build or create operation',
    agents: ['planner'],
    commands: ['/build'],
  },
  'action:implement': {
    type: 'action',
    description: 'Feature implementation',
    agents: ['planner', 'tdd-guide'],
    commands: ['/implement'],
  },
  'action:review': {
    type: 'action',
    description: 'Code review or audit',
    agents: ['code-reviewer', 'security-reviewer'],
    commands: ['/analyze'],
  },
  'action:test': {
    type: 'action',
    description: 'Testing workflow',
    agents: ['tdd-guide', 'e2e-runner'],
    commands: ['/test'],
  },
  'action:fix': {
    type: 'action',
    description: 'Bug fix or debugging',
    agents: ['build-error-resolver'],
    commands: ['/troubleshoot'],
  },
  'action:refactor': {
    type: 'action',
    description: 'Refactoring or cleanup',
    agents: ['refactor-cleaner'],
    commands: ['/improve', '/cleanup'],
  },
  'action:deploy': {
    type: 'action',
    description: 'Deployment or release',
    agents: ['devops-engineer'],
    commands: ['/git'],
  },
  'action:document': {
    type: 'action',
    description: 'Documentation task',
    agents: ['doc-updater'],
    commands: ['/document'],
  },
  'action:analyze': {
    type: 'action',
    description: 'Analysis or investigation',
    agents: ['architect'],
    commands: ['/analyze'],
  },
  'action:explain': {
    type: 'action',
    description: 'Explanation or educational content',
    agents: [],
    commands: ['/explain'],
  },
  'action:design': {
    type: 'action',
    description: 'System or UI design',
    agents: ['architect', 'frontend-developer'],
    commands: ['/design'],
  },
  'action:plan': {
    type: 'action',
    description: 'Planning or estimation',
    agents: ['planner', 'architect'],
    commands: ['/estimate', '/task'],
  },
};

/**
 * Get recommendations for a list of detected intents.
 * @param {string[]} intents - Array of intent strings
 * @returns {{ intent: string, type: string, description: string, agents: string[], commands: string[] }[]}
 */
export function getRecommendations(intents) {
  const results = [];
  for (const intent of intents) {
    const entry = TRIGGER_MAP[intent];
    if (entry) {
      results.push({ intent, ...entry });
    }
  }
  return results;
}

/**
 * Get a single best recommendation (first match by priority).
 * @param {string[]} intents
 * @returns {{ intent: string, type: string, description: string, agents: string[], commands: string[] }|null}
 */
export function getBestRecommendation(intents) {
  // team intents take priority
  const teamIntent = intents.find((i) => i.startsWith('team:'));
  if (teamIntent && TRIGGER_MAP[teamIntent]) {
    return { intent: teamIntent, ...TRIGGER_MAP[teamIntent] };
  }
  // otherwise first action intent
  for (const intent of intents) {
    if (TRIGGER_MAP[intent]) {
      return { intent, ...TRIGGER_MAP[intent] };
    }
  }
  return null;
}
