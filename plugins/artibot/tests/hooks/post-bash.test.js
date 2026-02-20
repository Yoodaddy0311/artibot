import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../scripts/utils/index.js', () => ({
  readStdin: vi.fn(),
  writeStdout: vi.fn(),
  parseJSON: vi.fn((str) => {
    try { return JSON.parse(str); }
    catch { return null; }
  }),
}));

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeHookData(stdout = '', stderr = '') {
  return JSON.stringify({
    tool_result: { stdout, stderr },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('post-bash hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('GitHub PR URL detection', () => {
    it('detects a GitHub PR URL in stdout', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'remote: Create a pull request for \'feature\' on GitHub by visiting:\nremote: https://github.com/user/repo/pull/42\n',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('[git] PR URL detected');
      expect(output.message).toContain('https://github.com/user/repo/pull/42');
    });

    it('detects a GitHub PR URL in stderr', async () => {
      readStdin.mockResolvedValue(makeHookData(
        '',
        'remote: https://github.com/org/project/pull/123\n',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('https://github.com/org/project/pull/123');
    });
  });

  describe('GitLab MR URL detection', () => {
    it('detects a GitLab merge request URL', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'https://gitlab.com/group/project/merge_requests/55',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('https://gitlab.com/group/project/merge_requests/55');
    });
  });

  describe('Bitbucket PR URL detection', () => {
    it('detects a Bitbucket pull request URL', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'https://bitbucket.org/team/repo/pull-requests/99',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('https://bitbucket.org/team/repo/pull-requests/99');
    });
  });

  describe('Azure DevOps PR URL detection', () => {
    it('detects an Azure DevOps pull request URL', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'https://dev.azure.com/org/project/pullrequest/7',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('https://dev.azure.com/org/project/pullrequest/7');
    });
  });

  describe('multiple URLs', () => {
    it('detects multiple PR URLs from combined output', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'https://github.com/user/repo/pull/1\nhttps://github.com/user/repo/pull/2',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('https://github.com/user/repo/pull/1');
      expect(output.message).toContain('https://github.com/user/repo/pull/2');
    });

    it('deduplicates identical URLs', async () => {
      const url = 'https://github.com/user/repo/pull/42';
      readStdin.mockResolvedValue(makeHookData(
        `${url}\n${url}\n${url}`,
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      // URL should appear in the message once (in the formatted list)
      const urlMatches = output.message.match(/https:\/\/github\.com\/user\/repo\/pull\/42/g);
      expect(urlMatches).toHaveLength(1);
    });

    it('detects URLs from mixed platforms', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'https://github.com/user/repo/pull/1',
        'https://gitlab.com/group/project/merge_requests/2',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('github.com');
      expect(output.message).toContain('gitlab.com');
    });
  });

  describe('no PR URLs found', () => {
    it('does not call writeStdout when output has no PR URLs', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'Counting objects: 3, done.\nWriting objects: 100%',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does not call writeStdout when output is empty', async () => {
      readStdin.mockResolvedValue(makeHookData('', ''));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });

    it('does not call writeStdout when tool_result is missing', async () => {
      readStdin.mockResolvedValue(JSON.stringify({}));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('handles URLs with long path segments', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'https://github.com/very-long-org-name/very-long-repo-name/pull/999999',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledTimes(1);
      const output = writeStdout.mock.calls[0][0];
      expect(output.message).toContain('pull/999999');
    });

    it('does not match partial URLs (no PR number)', async () => {
      readStdin.mockResolvedValue(makeHookData(
        'Visit https://github.com/user/repo for more info',
      ));

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('exits gracefully when readStdin rejects', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(exitSpy).toHaveBeenCalledWith(0);
      const stderrOutput = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(stderrOutput).toContain('[artibot:post-bash]');

      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('handles null parseJSON result gracefully', async () => {
      readStdin.mockResolvedValue('not valid json');

      await import('../../scripts/hooks/post-bash.js');
      await new Promise((r) => setTimeout(r, 50));

      // No crash, no output
      expect(writeStdout).not.toHaveBeenCalled();
    });
  });
});
