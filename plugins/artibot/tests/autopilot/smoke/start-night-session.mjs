// One-shot starter: spawn an autopilot:night session and emit JSON.
// Used by main Claude when entering 4h autonomous mode.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const libUrl = pathToFileURL(
  resolve(repoRoot, 'plugins/artibot/lib/autopilot/index.js'),
).href;
const m = await import(libUrl);

const task = process.argv[2] || 'No task provided';
const maxDuration = process.argv[3] || '4h';
const budget = Number(process.argv[4] || 2000000);

const r = await m.startAutopilot({
  task,
  mode: 'night',
  options: { maxDuration, budget, checkpoint: '30m' },
});

const summary = {
  sessionId: r.sessionId,
  prdPath: r.prdPath,
  phase: r.phase,
  instructionType: r.instruction?.type,
  nextPhase: r.instruction?.nextPhase,
};
console.log(JSON.stringify(summary, null, 2));
