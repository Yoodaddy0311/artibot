// One-shot finalizer: mark a night session COMPLETED + append success lesson + emit telemetry.
// Used by main Claude when phase 6 REPORT external sub-agent has produced the user-facing report.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const libUrl = pathToFileURL(
  resolve(repoRoot, 'plugins/artibot/lib/autopilot/index.js'),
).href;
const m = await import(libUrl);

const sessionId = process.argv[2];
const reportPath = process.argv[3];
if (!sessionId) {
  console.error('usage: finish-night-session.mjs <sessionId> <reportPath>');
  process.exit(1);
}

const state = m.loadSession(sessionId);
if (!state) {
  console.error('session not found:', sessionId);
  process.exit(1);
}

state.phase = 'COMPLETED';
state.completedAt = new Date().toISOString();
state.reportPath = reportPath || state.reportPath || null;
m.saveSession(state);

m.appendEvent(sessionId, {
  phase: 'COMPLETED',
  type: 'session-complete',
  level: 'info',
  message: 'Autopilot night session completed',
});

if (state.featureKey) {
  m.appendLesson(state.featureKey, {
    sessionId,
    lesson: 'Completed: ' + (state.task || '').slice(0, 160),
    successPattern: 'session-complete',
    sourcePhase: 'REPORT',
    tokenCost: state.tokenUsage || 0,
  });
}

const note = m.notifyCompletion(sessionId, 'COMPLETED');

console.log(JSON.stringify({
  sessionId,
  phase: state.phase,
  mode: state.mode,
  completedAt: state.completedAt,
  reportPath: state.reportPath,
  featureKey: state.featureKey,
  notification: note.suppressed ? 'queued (night mode)' : 'sent',
  queuedQuestions: (state.queuedQuestions || []).length,
  errors: (state.errors || []).length,
}, null, 2));
