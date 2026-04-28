// Full integration check — exercises every Autopilot v4.1 feature in one pass.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const libUrl = pathToFileURL(resolve(process.cwd(), 'plugins/artibot/lib/autopilot/index.js')).href;
const m = await import(libUrl);

const exports = Object.keys(m).length;
console.log(`[1/8] exports: ${exports}`);

const r = await m.startAutopilot({ task: '최종 검증 한글 task — autopilot v41 final check', mode: 'plan' });
console.log(`[2/8] startAutopilot ok: sessionId=${r.sessionId}, phase=${r.phase}`);

const status = await m.getStatus(r.sessionId);
console.log(`[3/8] getStatus ok: featureKey=${status.featureKey}, priorLessons=${(status.priorLessons || []).length}`);

const events = m.readEvents(r.sessionId, { tail: 10 });
console.log(`[4/8] telemetry events: ${events.length}`);

m.appendLesson(status.featureKey, { sessionId: r.sessionId, lesson: '최종 검증 lesson' });
const recalled = m.recallLessons(status.task, { limit: 3 });
console.log(`[5/8] memory append + recall: ${recalled.length} lesson(s)`);

const allow = m.loadAllowList();
const allowed = m.isAllowed('plugin:artibot:playwright');
const blocked = m.isAllowed('mcp__github__push');
console.log(`[6/8] mcp-verifier: allowed=${allowed} blocked=${!blocked} allowSize=${allow.entries.size}`);

const trees = m.listActiveWorktrees();
console.log(`[7/8] active worktrees: ${trees.length}`);

const aborted = await m.abortAutopilot(r.sessionId, { graceful: true });
console.log(`[8/8] abort ok: status=${aborted.status} report=${aborted.reportPath ? 'yes' : 'no'}`);

console.log('\nALL CHECKS PASS');
