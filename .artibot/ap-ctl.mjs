// autopilot session control helper — ap-20260611-024451-pz38f5 (세션 종료 시 삭제)
import path from 'node:path';
import fs from 'node:fs';

const toFileUrl = (p) => {
  const f = p.replace(/\\/g, '/');
  return /^[A-Z]:/i.test(f) ? `file:///${f}` : `file://${f}`;
};
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const candidates = [process.env.CLAUDE_PLUGIN_ROOT].filter(Boolean);
const mpDir = path.join(home, '.claude', 'plugins', 'marketplaces');
if (fs.existsSync(mpDir)) {
  for (const mp of fs.readdirSync(mpDir)) candidates.push(path.join(mpDir, mp, 'plugins', 'artibot'));
}
candidates.push(path.join(process.cwd(), 'plugins', 'artibot'));
const pluginRoot = candidates.find((c) => c && fs.existsSync(path.join(c, 'lib/autopilot/index.js')));
const barrel = await import(toFileUrl(path.join(pluginRoot, 'lib/autopilot/index.js')));
const engineMod = await import(toFileUrl(path.join(pluginRoot, 'lib/autopilot/engine.js')));
const engine = { ...barrel, ...engineMod };

const SESSION_ID = 'ap-20260611-024451-pz38f5';
const [cmd, ...args] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

if (cmd === 'record') {
  const [phase, status] = args;
  const state = engine.loadSession(SESSION_ID);
  engine.recordPhaseResult(state, { phase, status });
  engine.appendEvent(SESSION_ID, { phase, type: 'phase-end', level: 'info', message: `${phase} ${status}` });
  out({ recorded: phase, status, shouldPause: engine.shouldPause(state) });
} else if (cmd === 'checkpoint') {
  const [sha, label] = args;
  const state = engine.loadSession(SESSION_ID);
  engine.recordCheckpoint(state, { sha, label });
  out({ checkpoint: sha, label });
} else if (cmd === 'status') {
  out(engine.getStatus(SESSION_ID));
} else if (cmd === 'goal-eval') {
  const { execSync } = await import('node:child_process');
  const state = engine.loadSession(SESSION_ID);
  if (!state.goalContract) {
    state.goalContract = {
      objective: '바이브코딩 특화 7건 — 발동 신뢰도 게이트·자가치유·프리셋·스킬 작성 표준',
      stoppingCondition:
        'description-lint CI 게이트 활성(ratchet: 신규 위반 0) + P1 스킬 위반 0 + doctor --fix/팩/메타스킬 테스트 그린 + npm run ci 그린',
      validationCommand: 'npm run ci',
      forbiddenChanges: ['docs/PRD/**', 'docs/adr/**', 'CHANGELOG.md'],
      maxIterations: 3,
    };
  }
  state.lastReviewedSHA = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  const ciDir = fs.existsSync(path.join(process.cwd(), 'plugins', 'artibot'))
    ? path.join(process.cwd(), 'plugins', 'artibot')
    : process.cwd();
  const runCommand = (line) => {
    try {
      const stdout = execSync(line, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: ciDir,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { exitCode: 0, stdout: String(stdout || ''), stderr: '' };
    } catch (err) {
      return {
        exitCode: typeof err?.status === 'number' ? err.status : 1,
        stdout: String(err?.stdout ?? ''),
        stderr: String(err?.stderr ?? err?.message ?? ''),
      };
    }
  };
  const result = engine.runPhaseGoalEvaluate(state, { runCommand });
  out({
    type: result.type,
    phase: result.phase,
    nextPhase: result.nextPhase ?? null,
    met: result.met ?? result.evaluation?.met ?? null,
    reason: result.reason ?? result.evaluation?.reason ?? null,
    exitCode: result.evaluation?.exitCode ?? null,
  });
} else if (cmd === 'complete') {
  engine.notifyCompletion?.(SESSION_ID);
  engine.releaseAllForSession?.(SESSION_ID);
  out({ completed: true });
} else {
  out({ error: `unknown cmd: ${cmd}` });
}
