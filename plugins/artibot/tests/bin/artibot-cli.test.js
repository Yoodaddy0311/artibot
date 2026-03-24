import { describe, expect, it } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(PLUGIN_ROOT, 'bin', 'artibot.js');

async function runCli(...args) {
  const { stdout, stderr } = await execFile(process.execPath, [CLI_PATH, ...args], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    timeout: 30_000,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

describe('Artibot CLI (bin/artibot.js)', () => {
  it('shows version with "version" command', async () => {
    const { stdout } = await runCli('version');
    expect(stdout).toMatch(/^artibot v\d+\.\d+\.\d+/);
    expect(stdout).toContain('Node');
  });

  it('shows version with -v flag', async () => {
    const { stdout } = await runCli('-v');
    expect(stdout).toMatch(/^artibot v/);
  });

  it('shows help with "help" command', async () => {
    const { stdout } = await runCli('help');
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('run <prompt>');
    expect(stdout).toContain('eval');
    expect(stdout).toContain('learn');
  });

  it('shows help with --help flag', async () => {
    const { stdout } = await runCli('--help');
    expect(stdout).toContain('Usage:');
  });

  it('shows help with -h flag', async () => {
    const { stdout } = await runCli('-h');
    expect(stdout).toContain('Usage:');
  });

  it('shows help when no command is given', async () => {
    const { stdout } = await runCli();
    expect(stdout).toContain('Usage:');
  });

  it('runs a prompt with "run" command', async () => {
    const { stdout } = await runCli('run', 'fix typo in readme');
    expect(stdout).toContain('[runtime]');
    expect(stdout).toContain('Route:');
  });

  it('runs a prompt with --json flag', async () => {
    const { stdout } = await runCli('run', 'fix typo', '--json');
    const result = JSON.parse(stdout);
    expect(result.userPrompt).toBeTypeOf('string');
    expect(result.context.routing.system).toBe('system1');
  });

  it('reports error when run command has no prompt', async () => {
    try {
      await runCli('run');
    } catch (err) {
      expect(err.stderr).toContain('prompt is required');
    }
  });

  it('reports error for unknown commands', async () => {
    try {
      await runCli('nonexistent');
    } catch (err) {
      expect(err.stderr).toContain('Unknown command');
    }
  });
});
