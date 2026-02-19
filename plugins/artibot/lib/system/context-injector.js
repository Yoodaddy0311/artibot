/**
 * Context injector for LAM OS Awareness.
 * Intelligently injects system telemetry into user prompts based on relevance.
 * @module lib/system/context-injector
 */

/** Maximum injected context size in estimated tokens */
const MAX_CONTEXT_TOKENS = 500;

/** Approximate characters per token */
const CHARS_PER_TOKEN = 4;

/** Maximum injected context length in characters */
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN;

/**
 * Relevance mapping: keyword patterns to telemetry data keys.
 * Each entry maps trigger keywords (EN + KO) to the telemetry sections to inject.
 *
 * @type {Array<{ keywords: string[], dataKeys: string[], priority: number }>}
 */
const RELEVANCE_MAP = [
  {
    keywords: [
      'slow', 'lag', 'hang', 'freeze', 'cpu', 'process',
      '느려', '느림', '멈춤', '렉', '프로세스', 'CPU',
    ],
    dataKeys: ['cpu', 'memory'],
    priority: 10,
  },
  {
    keywords: [
      'memory', 'ram', 'oom', 'out of memory', 'leak',
      '메모리', '램', 'OOM', '누수',
    ],
    dataKeys: ['memory', 'cpu'],
    priority: 10,
  },
  {
    keywords: [
      'error', 'crash', 'fail', 'exception', 'bug', 'broken',
      '에러', '오류', '크래시', '실패', '버그', '깨짐',
    ],
    dataKeys: ['errors', 'cpu', 'memory'],
    priority: 9,
  },
  {
    keywords: [
      'deploy', 'docker', 'container', 'k8s', 'kubernetes', 'compose',
      '배포', '도커', '컨테이너',
    ],
    dataKeys: ['docker', 'network'],
    priority: 8,
  },
  {
    keywords: [
      'disk', 'storage', 'space', 'full',
      '디스크', '용량', '저장', '꽉',
    ],
    dataKeys: ['disk'],
    priority: 8,
  },
  {
    keywords: [
      'port', 'network', 'connect', 'listen', 'socket', 'http', 'api',
      '포트', '네트워크', '연결', '소켓',
    ],
    dataKeys: ['network'],
    priority: 7,
  },
  {
    keywords: [
      'git', 'branch', 'commit', 'merge', 'push', 'pull',
      '브랜치', '커밋', '머지',
    ],
    dataKeys: ['git'],
    priority: 6,
  },
  {
    keywords: [
      'system', 'os', 'platform', 'environment', 'machine',
      '시스템', '환경', '플랫폼', '머신',
    ],
    dataKeys: ['cpu', 'memory', 'disk'],
    priority: 5,
  },
];

/**
 * Action safety classification for LAM commands.
 * Defines which system actions are safe to auto-execute, require confirmation,
 * or must be blocked entirely.
 *
 * @type {{ auto: string[], confirm: string[], blocked: string[] }}
 */
export const ACTION_SPACE = {
  /** Commands safe for automatic execution (read-only, non-destructive) */
  auto: [
    'process list', 'disk usage', 'memory usage', 'cpu usage',
    'network ports', 'docker status', 'git status', 'system info',
    'uptime', 'whoami', 'hostname', 'env list',
  ],
  /** Commands requiring explicit user confirmation */
  confirm: [
    'kill process', 'restart service', 'delete file', 'stop container',
    'restart container', 'clear cache', 'close port',
  ],
  /** Commands that are absolutely blocked (aligned with sandbox.js) */
  blocked: [
    'system shutdown', 'system reboot', 'format disk', 'rm -rf',
    'chmod 777', 'chown root', 'fork bomb', 'pipe to shell',
    'drop database', 'truncate table', 'unset PATH',
  ],
};

/**
 * Determine whether system context injection is needed for a given prompt.
 *
 * @param {string} userPrompt - The user's input prompt
 * @returns {boolean} True if context should be injected
 */
export function shouldInject(userPrompt) {
  if (!userPrompt || typeof userPrompt !== 'string') return false;

  const lower = userPrompt.toLowerCase();

  // Check if any relevance keywords match
  for (const entry of RELEVANCE_MAP) {
    if (entry.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return true;
    }
  }

  return false;
}

/**
 * Score relevance of each telemetry data key to the user prompt.
 * Returns matched data keys sorted by priority.
 *
 * @param {string} userPrompt - The user's input prompt
 * @returns {Array<{ key: string, score: number }>} Matched keys with scores
 */
function scoreRelevance(userPrompt) {
  const lower = userPrompt.toLowerCase();
  /** @type {Map<string, number>} */
  const scores = new Map();

  for (const entry of RELEVANCE_MAP) {
    const matchCount = entry.keywords.filter((kw) =>
      lower.includes(kw.toLowerCase()),
    ).length;

    if (matchCount > 0) {
      const score = matchCount * entry.priority;
      for (const key of entry.dataKeys) {
        const existing = scores.get(key) || 0;
        scores.set(key, existing + score);
      }
    }
  }

  return Array.from(scores.entries())
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Format a telemetry section into a compact string.
 *
 * @param {string} key - Telemetry data key (cpu, memory, disk, etc.)
 * @param {object} telemetry - Full telemetry snapshot
 * @returns {string} Formatted context string
 */
function formatSection(key, telemetry) {
  const data = telemetry[key];
  if (!data) return '';

  switch (key) {
    case 'cpu': {
      const top = (data.topProcesses || [])
        .slice(0, 3)
        .map((p) => `${p.name}(${p.cpu}%)`)
        .join(', ');
      return `CPU: ${data.usage}% used${top ? ` | top: ${top}` : ''}`;
    }

    case 'memory': {
      return `Memory: ${data.used}/${data.total} (${data.usage}% used)`;
    }

    case 'disk': {
      if (!Array.isArray(data) || data.length === 0) return '';
      return data
        .slice(0, 3)
        .map((d) => `Disk ${d.mount}: ${d.used}/${d.total} (${d.usage}%)`)
        .join('; ');
    }

    case 'network': {
      if (!Array.isArray(data) || data.length === 0) return 'Network: no listening ports';
      const portList = data.slice(0, 8).map((p) => p.port).join(', ');
      return `Listening ports: ${portList}`;
    }

    case 'errors': {
      if (!Array.isArray(data) || data.length === 0) return 'System errors: none recent';
      const recent = data.slice(0, 3);
      return `System errors (${data.length}): ${recent.map((e) => e.message.slice(0, 80)).join(' | ')}`;
    }

    case 'docker': {
      if (!Array.isArray(data) || data.length === 0) return 'Docker: no running containers';
      const containers = data
        .slice(0, 5)
        .map((c) => `${c.name}(${c.status})`)
        .join(', ');
      return `Docker: ${containers}`;
    }

    case 'git': {
      if (!data) return '';
      return `Git: ${data.branch} | ${data.status}`;
    }

    default:
      return '';
  }
}

/**
 * Format selected telemetry sections into a compact context string.
 *
 * @param {object} telemetry - Full telemetry snapshot from getFullSnapshot()
 * @param {string[]} relevantKeys - Telemetry keys to include
 * @returns {string} Formatted context string within token budget
 */
export function formatContext(telemetry, relevantKeys) {
  if (!telemetry || !relevantKeys || relevantKeys.length === 0) return '';

  const sections = [];
  let totalLength = 0;

  for (const key of relevantKeys) {
    const section = formatSection(key, telemetry);
    if (!section) continue;

    // Check if adding this section would exceed the budget
    if (totalLength + section.length + 3 > MAX_CONTEXT_CHARS) break;

    sections.push(section);
    totalLength += section.length + 3; // +3 for " | " separator
  }

  if (sections.length === 0) return '';

  const platform = telemetry.platform;
  const platformInfo = platform
    ? `${platform.os}/${platform.arch}`
    : 'unknown';

  return `[System Context: ${platformInfo} | ${sections.join(' | ')}]`;
}

/**
 * Inject relevant system context into a user prompt.
 * Only injects context when the prompt contains relevant keywords.
 *
 * @param {string} userPrompt - The user's original prompt
 * @param {object} telemetry - Full telemetry snapshot from getFullSnapshot()
 * @returns {string} The prompt with injected system context (or unchanged if irrelevant)
 */
export function injectContext(userPrompt, telemetry) {
  if (!userPrompt || !telemetry) return userPrompt || '';

  if (!shouldInject(userPrompt)) return userPrompt;

  const scored = scoreRelevance(userPrompt);
  if (scored.length === 0) return userPrompt;

  const relevantKeys = scored.map((s) => s.key);
  const context = formatContext(telemetry, relevantKeys);

  if (!context) return userPrompt;

  return `${userPrompt}\n\n${context}`;
}

/**
 * Classify whether a system action is safe to auto-execute,
 * requires user confirmation, or must be blocked.
 * Integrates with sandbox.js blocked patterns.
 *
 * @param {string} actionDescription - Description of the action to classify
 * @returns {{ classification: 'auto' | 'confirm' | 'blocked', reason: string }}
 */
export function classifyAction(actionDescription) {
  if (!actionDescription || typeof actionDescription !== 'string') {
    return { classification: 'blocked', reason: 'Empty or invalid action description' };
  }

  const lower = actionDescription.toLowerCase();

  // Check blocked first (highest priority)
  for (const blocked of ACTION_SPACE.blocked) {
    if (lower.includes(blocked)) {
      return { classification: 'blocked', reason: `Action "${blocked}" is absolutely blocked for safety` };
    }
  }

  // Check confirm next
  for (const confirm of ACTION_SPACE.confirm) {
    if (lower.includes(confirm)) {
      return { classification: 'confirm', reason: `Action "${confirm}" requires explicit user confirmation` };
    }
  }

  // Check auto
  for (const auto of ACTION_SPACE.auto) {
    if (lower.includes(auto)) {
      return { classification: 'auto', reason: `Action "${auto}" is safe for automatic execution` };
    }
  }

  // Unknown actions default to confirm
  return { classification: 'confirm', reason: 'Unknown action defaults to user confirmation' };
}
