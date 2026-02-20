/**
 * TUI (Text User Interface) workflow visualization module.
 * Zero dependencies - uses only Node.js built-ins and UTF-8 characters.
 * @module lib/core/tui
 */

// ─────────────────────────────────────────────
// ANSI color helpers
// ─────────────────────────────────────────────

const ESC = '\x1b[';

const COLORS = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  // Foreground
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,
  // Background
  bgRed: `${ESC}41m`,
  bgGreen: `${ESC}42m`,
  bgYellow: `${ESC}43m`,
  bgBlue: `${ESC}44m`,
  bgMagenta: `${ESC}45m`,
  bgCyan: `${ESC}46m`,
  bgWhite: `${ESC}47m`,
};

/**
 * Apply ANSI color to text. Returns plain text when colors are disabled.
 * @param {string} text
 * @param {...string} styles - Color/style names from COLORS
 * @returns {string}
 */
function color(text, ...styles) {
  if (!supportsColor()) return text;
  const prefix = styles.map((s) => COLORS[s] || '').join('');
  return `${prefix}${text}${COLORS.reset}`;
}

/**
 * Check if the terminal supports colors.
 * Respects NO_COLOR and FORCE_COLOR environment variables.
 * @returns {boolean}
 */
function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

/**
 * Get the current terminal width, with a safe default.
 * @returns {number}
 */
function getTermWidth() {
  return process.stdout.columns || 80;
}

// ─────────────────────────────────────────────
// Box drawing characters
// ─────────────────────────────────────────────

const BOX = {
  topLeft: '\u250C',     // ┌
  topRight: '\u2510',    // ┐
  bottomLeft: '\u2514',  // └
  bottomRight: '\u2518', // ┘
  horizontal: '\u2500',  // ─
  vertical: '\u2502',    // │
  teeRight: '\u251C',    // ├
  teeLeft: '\u2524',     // ┤
  teeDown: '\u252C',     // ┬
  teeUp: '\u2534',       // ┴
  cross: '\u253C',       // ┼
};

const BLOCK = {
  full: '\u2588',   // █
  light: '\u2591',  // ░
  medium: '\u2592', // ▒
  dark: '\u2593',   // ▓
};

const SYMBOLS = {
  bullet: '\u25CF',    // ●
  circle: '\u25CB',    // ○
  arrow: '\u2192',     // →
  arrowBold: '\u25B6', // ▶
  check: '\u2713',     // ✓
  cross: '\u2717',     // ✗
  dash: '\u2500',      // ─
  ellipsis: '\u2026',  // …
};

// ─────────────────────────────────────────────
// Status light indicators
// ─────────────────────────────────────────────

const STATUS_MAP = {
  ready: { icon: '\uD83D\uDFE2', label: 'READY', color: 'green' },      // 🟢
  active: { icon: '\uD83D\uDFE1', label: 'ACTIVE', color: 'yellow' },    // 🟡
  in_progress: { icon: '\uD83D\uDFE1', label: 'IN_PROGRESS', color: 'yellow' },
  blocked: { icon: '\uD83D\uDD34', label: 'BLOCKED', color: 'red' },     // 🔴
  idle: { icon: '\u26AA', label: 'IDLE', color: 'gray' },                // ⚪
  completed: { icon: '\uD83D\uDFE2', label: 'DONE', color: 'green' },
  pending: { icon: '\u26AA', label: 'PENDING', color: 'gray' },
  error: { icon: '\uD83D\uDD34', label: 'ERROR', color: 'red' },
};

/**
 * Render a status light indicator.
 * @param {'ready'|'active'|'in_progress'|'blocked'|'idle'|'completed'|'pending'|'error'} status
 * @returns {string} Formatted status string (e.g. "🟢 READY")
 */
export function statusLight(status) {
  const entry = STATUS_MAP[status] || STATUS_MAP.idle;
  return `${entry.icon} ${color(entry.label, entry.color, 'bold')}`;
}

// ─────────────────────────────────────────────
// Progress bar
// ─────────────────────────────────────────────

/**
 * Render a progress bar with percentage and label.
 * @param {number} current - Current progress value
 * @param {number} total - Total value (100%)
 * @param {string} [label=''] - Optional label text
 * @param {object} [opts] - Options
 * @param {number} [opts.width=30] - Bar width in characters
 * @returns {string} e.g. "████████░░ 80% Building..."
 */
export function progressBar(current, total, label = '', opts = {}) {
  const width = opts.width || 30;
  const ratio = total > 0 ? Math.min(current / total, 1) : 0;
  const percent = Math.round(ratio * 100);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  const filledStr = BLOCK.full.repeat(filled);
  const emptyStr = BLOCK.light.repeat(empty);

  let barColor = 'green';
  if (percent < 30) barColor = 'red';
  else if (percent < 70) barColor = 'yellow';

  const bar = color(filledStr, barColor) + color(emptyStr, 'gray');
  const pctStr = color(`${String(percent).padStart(3)}%`, 'bold');
  const labelStr = label ? ` ${color(label, 'cyan')}` : '';

  return `${bar} ${pctStr}${labelStr}`;
}

// ─────────────────────────────────────────────
// Team dashboard
// ─────────────────────────────────────────────

/**
 * @typedef {object} TeammateInfo
 * @property {string} name - Agent name/identifier
 * @property {string} role - Agent role
 * @property {'ready'|'active'|'in_progress'|'blocked'|'idle'|'completed'|'error'} status
 * @property {string} [currentTask] - Current task description
 * @property {number} [progress] - Progress percentage 0-100
 * @property {number} [tasksCompleted] - Number of completed tasks
 * @property {number} [tasksTotal] - Total assigned tasks
 */

/**
 * Render a team dashboard showing all teammates with status and progress.
 * @param {TeammateInfo[]} teammates
 * @param {object} [opts]
 * @param {string} [opts.teamName='Agent Team']
 * @param {string} [opts.pattern] - Team pattern name
 * @returns {string} Multi-line dashboard string
 */
export function teamDashboard(teammates, opts = {}) {
  const teamName = opts.teamName || 'Agent Team';
  const pattern = opts.pattern || '';
  const width = Math.min(getTermWidth(), 100);
  const hr = BOX.horizontal.repeat(width - 2);

  const lines = [];

  // Header
  lines.push(`${BOX.topLeft}${hr}${BOX.topRight}`);
  const title = ` ${teamName}${pattern ? ` [${pattern}]` : ''} `;
  const titlePad = Math.max(0, width - 2 - stripAnsi(title).length);
  lines.push(
    `${BOX.vertical}${color(title, 'cyan', 'bold')}${' '.repeat(titlePad)}${BOX.vertical}`
  );
  lines.push(`${BOX.teeRight}${hr}${BOX.teeLeft}`);

  // Summary counts
  const counts = countStatuses(teammates);
  const summaryParts = [];
  if (counts.active > 0) summaryParts.push(color(`${counts.active} active`, 'yellow'));
  if (counts.ready > 0) summaryParts.push(color(`${counts.ready} ready`, 'green'));
  if (counts.blocked > 0) summaryParts.push(color(`${counts.blocked} blocked`, 'red'));
  if (counts.idle > 0) summaryParts.push(color(`${counts.idle} idle`, 'gray'));
  if (counts.completed > 0) summaryParts.push(color(`${counts.completed} done`, 'green'));

  const summaryLine = ` ${summaryParts.join(color(' | ', 'gray'))} `;
  const summaryPad = Math.max(0, width - 2 - stripAnsi(summaryLine).length);
  lines.push(`${BOX.vertical}${summaryLine}${' '.repeat(summaryPad)}${BOX.vertical}`);
  lines.push(`${BOX.teeRight}${hr}${BOX.teeLeft}`);

  // Teammate rows
  for (const mate of teammates) {
    const status = statusLight(mate.status);
    const nameStr = color(padRight(mate.name, 16), 'white', 'bold');
    const roleStr = color(padRight(mate.role || '', 14), 'gray');

    let taskStr = '';
    if (mate.currentTask) {
      taskStr = truncate(mate.currentTask, 30);
    }

    let progressStr = '';
    if (typeof mate.progress === 'number') {
      progressStr = progressBar(mate.progress, 100, '', { width: 12 });
    } else if (typeof mate.tasksCompleted === 'number' && typeof mate.tasksTotal === 'number') {
      progressStr = progressBar(mate.tasksCompleted, mate.tasksTotal, '', { width: 12 });
    }

    const row = ` ${status} ${nameStr} ${roleStr} ${taskStr}`;
    const rowWithProgress = progressStr ? `${row} ${progressStr}` : row;
    const rowPad = Math.max(0, width - 2 - stripAnsi(rowWithProgress).length);
    lines.push(`${BOX.vertical}${rowWithProgress}${' '.repeat(rowPad)}${BOX.vertical}`);
  }

  // Footer
  lines.push(`${BOX.bottomLeft}${hr}${BOX.bottomRight}`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Workflow visualizer
// ─────────────────────────────────────────────

/**
 * @typedef {object} WorkflowStep
 * @property {string} name - Step name
 * @property {'pending'|'active'|'completed'|'error'|'skipped'} status
 */

/**
 * Render a linear workflow pipeline visualization.
 * @param {WorkflowStep[]} steps
 * @param {number} [currentIndex=-1] - Index of the current active step (auto-detected if not provided)
 * @returns {string} e.g. "[Plan ✓]─→[Design ✓]─→[Implement ●]─→[Review]─→[Merge]"
 */
export function workflowVisualizer(steps, currentIndex) {
  if (!steps || steps.length === 0) return '';

  // Auto-detect current step if not provided
  if (typeof currentIndex !== 'number') {
    currentIndex = steps.findIndex((s) => s.status === 'active' || s.status === 'in_progress');
  }

  const rendered = steps.map((step, idx) => {
    const isCurrent = idx === currentIndex;
    let icon, nameColor;

    switch (step.status) {
      case 'completed':
        icon = SYMBOLS.check;
        nameColor = 'green';
        break;
      case 'active':
      case 'in_progress':
        icon = SYMBOLS.bullet;
        nameColor = 'yellow';
        break;
      case 'error':
        icon = SYMBOLS.cross;
        nameColor = 'red';
        break;
      case 'skipped':
        icon = SYMBOLS.dash;
        nameColor = 'gray';
        break;
      default: // pending
        icon = SYMBOLS.circle;
        nameColor = 'gray';
        break;
    }

    const name = step.name;
    if (isCurrent) {
      return color(`[${name} ${icon}]`, nameColor, 'bold');
    }
    return color(`[${name} ${icon}]`, nameColor);
  });

  const connector = color(`${SYMBOLS.dash}${SYMBOLS.arrow}`, 'gray');
  return rendered.join(connector);
}

/**
 * Render a playbook workflow with named phases.
 * Convenience wrapper for common Artibot playbooks.
 * @param {'feature'|'bugfix'|'refactor'|'security'} playbookName
 * @param {number} currentPhase - 0-based index of current phase
 * @returns {string}
 */
export function playbookVisualizer(playbookName, currentPhase) {
  const playbooks = {
    feature: ['Plan', 'Design', 'Implement', 'Review', 'Test', 'Merge'],
    bugfix: ['Triage', 'Reproduce', 'Fix', 'Test', 'Review', 'Merge'],
    refactor: ['Analyze', 'Plan', 'Refactor', 'Test', 'Review', 'Merge'],
    security: ['Scan', 'Assess', 'Fix', 'Verify', 'Audit', 'Merge'],
  };

  const phases = playbooks[playbookName] || playbooks.feature;
  const steps = phases.map((name, idx) => ({
    name,
    status: idx < currentPhase ? 'completed' : idx === currentPhase ? 'active' : 'pending',
  }));

  return workflowVisualizer(steps, currentPhase);
}

// ─────────────────────────────────────────────
// Task board (Kanban style)
// ─────────────────────────────────────────────

/**
 * @typedef {object} TaskItem
 * @property {string|number} id
 * @property {string} subject - Short task title
 * @property {'pending'|'in_progress'|'completed'|'blocked'} status
 * @property {string} [owner] - Assigned agent name
 */

/**
 * Render a Kanban-style task board.
 * @param {TaskItem[]} tasks
 * @param {object} [opts]
 * @param {number} [opts.columnWidth=24] - Width of each column
 * @returns {string} Multi-line kanban board
 */
export function taskBoard(tasks, opts = {}) {
  const colWidth = opts.columnWidth || 24;
  const columns = {
    pending: { title: 'Pending', color: 'gray', tasks: [] },
    in_progress: { title: 'In Progress', color: 'yellow', tasks: [] },
    completed: { title: 'Done', color: 'green', tasks: [] },
    blocked: { title: 'Blocked', color: 'red', tasks: [] },
  };

  for (const task of tasks) {
    const col = columns[task.status] || columns.pending;
    col.tasks.push(task);
  }

  // Filter out empty columns except the core three
  const activeCols = ['pending', 'in_progress', 'completed', 'blocked']
    .filter((key) => columns[key].tasks.length > 0 || key !== 'blocked')
    .filter((key) => key !== 'blocked' || columns[key].tasks.length > 0)
    .map((key) => columns[key]);

  if (activeCols.length === 0) return color('  No tasks', 'gray');

  const lines = [];
  const colHr = BOX.horizontal.repeat(colWidth);
  const colSep = '  ';

  // Headers
  const headerLine = activeCols
    .map((col) => {
      const title = centerText(` ${col.title} (${col.tasks.length}) `, colWidth);
      return color(title, col.color, 'bold');
    })
    .join(colSep);
  lines.push(headerLine);

  const hrLine = activeCols.map(() => colHr).join(colSep);
  lines.push(hrLine);

  // Task rows
  const maxRows = Math.max(...activeCols.map((c) => c.tasks.length));
  for (let i = 0; i < maxRows; i++) {
    const rowParts = activeCols.map((col) => {
      const task = col.tasks[i];
      if (!task) return ' '.repeat(colWidth);

      const id = `#${task.id}`;
      const subject = truncate(task.subject, colWidth - id.length - 3);
      const line1 = ` ${color(id, 'dim')} ${subject}`;
      const pad = Math.max(0, colWidth - stripAnsi(line1).length);
      return `${line1}${' '.repeat(pad)}`;
    });
    lines.push(rowParts.join(colSep));

    // Owner sub-row
    const ownerParts = activeCols.map((col) => {
      const task = col.tasks[i];
      if (!task || !task.owner) return ' '.repeat(colWidth);
      const ownerLine = `   ${color(`@${truncate(task.owner, colWidth - 5)}`, 'cyan')}`;
      const pad = Math.max(0, colWidth - stripAnsi(ownerLine).length);
      return `${ownerLine}${' '.repeat(pad)}`;
    });
    const hasOwner = activeCols.some((col) => col.tasks[i]?.owner);
    if (hasOwner) lines.push(ownerParts.join(colSep));
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Timeline log
// ─────────────────────────────────────────────

/**
 * @typedef {object} TimelineEvent
 * @property {string|Date} timestamp
 * @property {'info'|'success'|'warning'|'error'|'action'} type
 * @property {string} agent - Agent name
 * @property {string} message
 */

/**
 * Render a chronological timeline of events.
 * @param {TimelineEvent[]} events
 * @param {object} [opts]
 * @param {number} [opts.maxEvents=20] - Maximum events to display
 * @returns {string} Multi-line timeline
 */
export function timeline(events, opts = {}) {
  const maxEvents = opts.maxEvents || 20;
  const display = events.slice(-maxEvents);

  if (display.length === 0) return color('  No events recorded', 'gray');

  const typeStyle = {
    info: { icon: '\u25CB', color: 'cyan' },        // ○
    success: { icon: '\u25CF', color: 'green' },     // ●
    warning: { icon: '\u25B2', color: 'yellow' },    // ▲
    error: { icon: '\u25A0', color: 'red' },         // ■
    action: { icon: '\u25B6', color: 'blue' },       // ▶
  };

  const lines = [];
  for (let i = 0; i < display.length; i++) {
    const evt = display[i];
    const style = typeStyle[evt.type] || typeStyle.info;
    const isLast = i === display.length - 1;

    const ts = formatTimestamp(evt.timestamp);
    const connector = isLast ? BOX.bottomLeft : BOX.teeRight;

    const icon = color(style.icon, style.color);
    const timeStr = color(ts, 'gray');
    const agentStr = evt.agent ? color(`[${evt.agent}]`, 'cyan') : '';
    const msgStr = color(evt.message, style.color);

    lines.push(`  ${connector}${BOX.horizontal}${icon} ${timeStr} ${agentStr} ${msgStr}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Orchestration mode indicator
// ─────────────────────────────────────────────

const MODE_DISPLAY = {
  'agent-teams': { icon: '\uD83D\uDE80', label: 'AGENT TEAMS', barColor: 'green', desc: 'Full P2P team orchestration' },
  'sub-agent': { icon: '\u26A1', label: 'SUB-AGENT', barColor: 'yellow', desc: 'Parallel delegation (no P2P)' },
  'direct': { icon: '\uD83D\uDD27', label: 'DIRECT', barColor: 'cyan', desc: 'Sequential self-execution' },
};

/**
 * Render an orchestration mode indicator bar.
 * @param {'agent-teams'|'sub-agent'|'direct'} mode
 * @param {object} [opts]
 * @param {string} [opts.platform] - Platform name (e.g. 'Claude Code', 'Gemini CLI')
 * @param {boolean} [opts.envConfigured] - Whether Agent Teams env is configured in settings
 * @returns {string}
 */
export function modeIndicator(mode, opts = {}) {
  const m = MODE_DISPLAY[mode] || MODE_DISPLAY.direct;
  const platform = opts.platform || 'Unknown';
  const width = Math.min(getTermWidth(), 80);
  const hr = BOX.horizontal.repeat(width - 2);

  const lines = [];
  lines.push(color(`${BOX.topLeft}${hr}${BOX.topRight}`, m.barColor));

  const modeLine = ` ${m.icon} ${color(m.label, m.barColor, 'bold')} ${color(m.desc, 'gray')}`;
  const platLine = color(` ${platform}`, 'white');
  const content = `${modeLine} ${color('|', 'gray')}${platLine}`;
  const contentPad = Math.max(0, width - 2 - stripAnsi(content).length);
  lines.push(`${color(BOX.vertical, m.barColor)}${content}${' '.repeat(contentPad)}${color(BOX.vertical, m.barColor)}`);

  if (mode !== 'agent-teams' && opts.envConfigured === false) {
    const hint = ` ${color(SYMBOLS.arrow, 'yellow')} ${color('Enable full team mode:', 'yellow')} ${color('settings.json', 'white', 'bold')} ${color('{"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}', 'gray')}`;
    const hintPad = Math.max(0, width - 2 - stripAnsi(hint).length);
    lines.push(`${color(BOX.vertical, m.barColor)}${hint}${' '.repeat(hintPad)}${color(BOX.vertical, m.barColor)}`);
  }

  lines.push(color(`${BOX.bottomLeft}${hr}${BOX.bottomRight}`, m.barColor));
  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Overall project progress
// ─────────────────────────────────────────────

/**
 * Render a large overall progress bar with phase details.
 * @param {object} data
 * @param {number} data.completed - Completed tasks
 * @param {number} data.total - Total tasks
 * @param {string} [data.phase] - Current phase name
 * @param {string} [data.eta] - Estimated time remaining
 * @param {object} [data.breakdown] - Per-status counts
 * @param {number} [data.breakdown.in_progress]
 * @param {number} [data.breakdown.blocked]
 * @param {number} [data.breakdown.pending]
 * @returns {string}
 */
export function overallProgress(data) {
  const { completed, total, phase, eta, breakdown } = data;
  const width = Math.min(getTermWidth(), 80);
  const barWidth = width - 16; // room for percentage and decorations
  const ratio = total > 0 ? Math.min(completed / total, 1) : 0;
  const percent = Math.round(ratio * 100);

  const filled = Math.round(ratio * barWidth);
  const empty = barWidth - filled;

  let barColor = 'green';
  if (percent < 30) barColor = 'red';
  else if (percent < 70) barColor = 'yellow';

  const lines = [];

  // Phase label line
  if (phase) {
    lines.push(color(` ${SYMBOLS.arrowBold} ${phase}`, 'white', 'bold') + (eta ? color(`  ~${eta}`, 'gray') : ''));
  }

  // Main progress bar with decorations
  const leftCap = color('[', 'gray');
  const rightCap = color(']', 'gray');
  const filledBar = color(BLOCK.full.repeat(filled), barColor);
  const emptyBar = color(BLOCK.light.repeat(empty), 'gray');
  const pctStr = color(` ${String(percent).padStart(3)}%`, barColor, 'bold');
  const countStr = color(` ${completed}/${total}`, 'gray');

  lines.push(`  ${leftCap}${filledBar}${emptyBar}${rightCap}${pctStr}${countStr}`);

  // Breakdown line
  if (breakdown) {
    const parts = [];
    if (breakdown.in_progress) parts.push(color(`${breakdown.in_progress} running`, 'yellow'));
    if (breakdown.blocked) parts.push(color(`${breakdown.blocked} blocked`, 'red'));
    if (breakdown.pending) parts.push(color(`${breakdown.pending} queued`, 'gray'));
    if (parts.length > 0) {
      lines.push(`  ${parts.join(color(' | ', 'gray'))}`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Composite views
// ─────────────────────────────────────────────

/**
 * Render a full team status view combining dashboard, workflow, and task board.
 * @param {object} data
 * @param {TeammateInfo[]} data.teammates
 * @param {WorkflowStep[]} [data.workflow]
 * @param {TaskItem[]} [data.tasks]
 * @param {TimelineEvent[]} [data.events]
 * @param {object} [data.meta]
 * @param {string} [data.meta.teamName]
 * @param {string} [data.meta.pattern]
 * @param {string} [data.meta.playbook]
 * @param {number} [data.meta.playbookPhase]
 * @param {string} [data.meta.mode] - Orchestration mode: 'agent-teams' | 'sub-agent' | 'direct'
 * @param {string} [data.meta.platform] - Platform name
 * @param {boolean} [data.meta.envConfigured] - Whether Agent Teams env is configured
 * @returns {string}
 */
export function fullDashboard(data) {
  const sections = [];

  // Orchestration mode indicator
  if (data.meta?.mode) {
    sections.push(modeIndicator(data.meta.mode, {
      platform: data.meta.platform,
      envConfigured: data.meta.envConfigured,
    }));
  }

  // Team dashboard
  if (data.teammates && data.teammates.length > 0) {
    sections.push(teamDashboard(data.teammates, {
      teamName: data.meta?.teamName,
      pattern: data.meta?.pattern,
    }));
  }

  // Overall progress bar
  if (data.tasks && data.tasks.length > 0) {
    const completed = data.tasks.filter((t) => t.status === 'completed').length;
    const total = data.tasks.length;
    const inProgress = data.tasks.filter((t) => t.status === 'in_progress').length;
    const blocked = data.tasks.filter((t) => t.status === 'blocked').length;
    const pending = data.tasks.filter((t) => t.status === 'pending').length;

    sections.push('');
    sections.push(overallProgress({
      completed,
      total,
      phase: data.meta?.playbook
        ? `Phase ${(data.meta.playbookPhase || 0) + 1}: ${['Plan', 'Design', 'Implement', 'Review', 'Test', 'Merge'][data.meta.playbookPhase || 0] || 'Unknown'}`
        : undefined,
      breakdown: { in_progress: inProgress, blocked, pending },
    }));
  }

  // Workflow
  if (data.workflow && data.workflow.length > 0) {
    sections.push('');
    sections.push(color(' Workflow', 'white', 'bold'));
    sections.push(` ${workflowVisualizer(data.workflow)}`);
  } else if (data.meta?.playbook) {
    sections.push('');
    sections.push(color(' Workflow', 'white', 'bold'));
    sections.push(` ${playbookVisualizer(data.meta.playbook, data.meta.playbookPhase || 0)}`);
  }

  // Task board
  if (data.tasks && data.tasks.length > 0) {
    sections.push('');
    sections.push(color(' Tasks', 'white', 'bold'));
    sections.push(taskBoard(data.tasks));
  }

  // Timeline
  if (data.events && data.events.length > 0) {
    sections.push('');
    sections.push(color(' Timeline', 'white', 'bold'));
    sections.push(timeline(data.events));
  }

  return sections.join('\n');
}

// ─────────────────────────────────────────────
// Section header / box utilities
// ─────────────────────────────────────────────

/**
 * Render a section header with box drawing.
 * @param {string} title
 * @param {object} [opts]
 * @param {number} [opts.width] - Override width
 * @param {string} [opts.color='cyan']
 * @returns {string}
 */
export function sectionHeader(title, opts = {}) {
  const width = opts.width || Math.min(getTermWidth(), 80);
  const headerColor = opts.color || 'cyan';
  const hr = BOX.horizontal.repeat(width - 2);
  const titleStr = ` ${title} `;
  const pad = Math.max(0, width - 2 - titleStr.length);

  return [
    `${BOX.topLeft}${hr}${BOX.topRight}`,
    `${BOX.vertical}${color(titleStr, headerColor, 'bold')}${' '.repeat(pad)}${BOX.vertical}`,
    `${BOX.bottomLeft}${hr}${BOX.bottomRight}`,
  ].join('\n');
}

// ─────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────

/**
 * Strip ANSI escape sequences from a string.
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Truncate a string to maxLen, adding ellipsis if needed.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + SYMBOLS.ellipsis;
}

/**
 * Pad a string to the right to a fixed width.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function padRight(str, width) {
  if (!str) return ' '.repeat(width);
  const visible = stripAnsi(str);
  if (visible.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - visible.length);
}

/**
 * Center text within a given width.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function centerText(str, width) {
  const visible = stripAnsi(str);
  if (visible.length >= width) return str;
  const left = Math.floor((width - visible.length) / 2);
  const right = width - visible.length - left;
  return ' '.repeat(left) + str + ' '.repeat(right);
}

/**
 * Count teammates by status.
 * @param {TeammateInfo[]} teammates
 * @returns {object}
 */
function countStatuses(teammates) {
  const counts = { active: 0, ready: 0, blocked: 0, idle: 0, completed: 0 };
  for (const t of teammates) {
    const s = t.status;
    if (s === 'active' || s === 'in_progress') counts.active++;
    else if (s === 'ready') counts.ready++;
    else if (s === 'blocked') counts.blocked++;
    else if (s === 'completed') counts.completed++;
    else counts.idle++;
  }
  return counts;
}

/**
 * Format a timestamp for display.
 * @param {string|Date} ts
 * @returns {string}
 */
function formatTimestamp(ts) {
  if (!ts) return '--:--:--';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toTimeString().slice(0, 8);
}

// Re-export utilities for external use
export { color, supportsColor, getTermWidth, stripAnsi, BOX, BLOCK, SYMBOLS, COLORS, STATUS_MAP, MODE_DISPLAY };
