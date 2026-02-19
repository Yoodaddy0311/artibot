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

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path');
  return { ...actual, default: actual };
});

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');

// ---------------------------------------------------------------------------
// Helpers - build fake secrets dynamically to avoid hook self-blocking
// ---------------------------------------------------------------------------
function makeHookData(filePath, content, toolName = 'Write') {
  const input = { file_path: filePath };
  if (content !== undefined) {
    if (toolName === 'Edit') {
      input.new_string = content;
    } else {
      input.content = content;
    }
  }
  return JSON.stringify({
    tool_name: toolName,
    tool_input: input,
  });
}

/** Build a fake AWS key: AKIA + 16 uppercase chars */
function fakeAwsKey() {
  return 'AKI' + 'AIOSFODNN7EXAMPLE';
}

/** Build a fake GitHub PAT: ghp_ + 36 alphanum chars */
function fakeGhToken() {
  return 'gh' + 'p_' + 'A'.repeat(36);
}

/** Build a fake Anthropic key */
function fakeAnthropicKey() {
  return 'sk-' + 'ant-api03-' + 'A'.repeat(20);
}

/** Build a fake OpenAI key: sk- + 20+ alphanumeric chars (no internal dashes) */
function fakeOpenAiKey() {
  return 'sk' + '-' + 'A'.repeat(30);
}

/** Build a generic api_key assignment */
function fakeGenericSecret() {
  return 'const api' + '_key = "supersecretkey12345678";';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('pre-write hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('approve safe files', () => {
    it.each([
      '/project/src/app.js',
      '/project/src/utils/helpers.ts',
      '/project/README.md',
      '/project/package.json',
      '/project/config/settings.json',
      '/project/src/styles/main.css',
    ])('approves writing to: %s', async (filePath) => {
      readStdin.mockResolvedValue(makeHookData(filePath, 'const x = 1;'));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('approves when file_path is empty', async () => {
      readStdin.mockResolvedValue(JSON.stringify({
        tool_name: 'Write',
        tool_input: {},
      }));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });

  describe('block sensitive file patterns', () => {
    it.each([
      ['/project/.env', '.env'],
      ['/project/.env.local', '.env variant'],
      ['/project/.env.production', '.env variant'],
      ['/project/credentials.json', 'credentials'],
      ['/project/server.pem', '.pem'],
      ['/project/ssl.key', '.key'],
      ['/project/cert.p12', '.p12'],
      ['/project/cert.pfx', '.pfx'],
      ['/project/secrets.json', 'secrets'],
      ['/project/app.secret', '.secret'],
      ['/home/user/.ssh/id_rsa', 'id_rsa'],
      ['/home/user/.ssh/id_ed25519', 'id_ed25519'],
      ['/project/token.json', 'token.json'],
      ['/project/service.account.json', 'service.account.json'],
      ['/home/user/.npmrc', '.npmrc'],
      ['/home/user/.netrc', '.netrc'],
      ['/home/user/_netrc', '_netrc'],
      ['/project/.htpasswd', '.htpasswd'],
      ['/project/keystore.jks', '.jks'],
      ['/project/kubeconfig', 'kubeconfig'],
      ['/project/wp-config.php', 'wp-config.php'],
      ['/project/config/database.yml', 'database.yml'],
    ])('blocks writing to sensitive file: %s (%s)', async (filePath, _desc) => {
      readStdin.mockResolvedValue(makeHookData(filePath, 'some content'));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });
  });

  describe('block sensitive filenames (exact match)', () => {
    it.each([
      '.env',
      '.env.local',
      '.env.production',
      '.env.development',
      'credentials.json',
      'secrets.json',
      'serviceAccountKey.json',
      '.npmrc',
      '.netrc',
      '_netrc',
      '.htpasswd',
      'kubeconfig',
    ])('blocks writing to: %s', async (filename) => {
      readStdin.mockResolvedValue(makeHookData(`/project/${filename}`, 'content'));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });
  });

  describe('block hardcoded secrets in content', () => {
    it('blocks AWS access key pattern (AKIA)', async () => {
      const content = `const key = "${fakeAwsKey()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/config.js', content));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks GitHub personal access token', async () => {
      const content = `const token = "${fakeGhToken()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/gh.js', content));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks Anthropic API key', async () => {
      const content = `const key = "${fakeAnthropicKey()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/api.js', content));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks OpenAI API key', async () => {
      const content = `const key = "${fakeOpenAiKey()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/openai.js', content));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks generic secret assignment pattern', async () => {
      readStdin.mockResolvedValue(
        makeHookData('/project/src/config.js', fakeGenericSecret()),
      );

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks secrets in Edit tool (new_string)', async () => {
      const content = `const token = "${fakeGhToken()}";`;
      readStdin.mockResolvedValue(
        makeHookData('/project/src/api.js', content, 'Edit'),
      );

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });
  });

  describe('approve safe content', () => {
    it('approves code without secrets', async () => {
      readStdin.mockResolvedValue(
        makeHookData('/project/src/app.js', 'function add(a, b) {\n  return a + b;\n}'),
      );

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('ignores secret patterns in // comments', async () => {
      const content = `// ${fakeGenericSecret()}\nconst x = 1;`;
      readStdin.mockResolvedValue(
        makeHookData('/project/src/config.js', content),
      );

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('ignores secret patterns in # comments', async () => {
      const content = `# ${fakeGenericSecret()}\nx = 1`;
      readStdin.mockResolvedValue(
        makeHookData('/project/config.py', content),
      );

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('approves env reference without literal secret', async () => {
      readStdin.mockResolvedValue(
        makeHookData('/project/src/config.js', 'const key = process.env.API_KEY;'),
      );

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });

  describe('block reason includes context', () => {
    it('includes filename in reason for sensitive file', async () => {
      readStdin.mockResolvedValue(makeHookData('/project/.env', 'VAR=1'));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      const call = writeStdout.mock.calls[0][0];
      expect(call.decision).toBe('block');
      expect(call.reason).toContain('SECURITY WARNING');
      expect(call.reason).toContain('.env');
    });

    it('mentions hardcoded secret in content block reason', async () => {
      const content = `const key = "${fakeAwsKey()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/app.js', content));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      const call = writeStdout.mock.calls[0][0];
      expect(call.decision).toBe('block');
      expect(call.reason).toContain('hardcoded secret');
    });
  });

  describe('error handling', () => {
    it('blocks by default when hook errors', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));

      await import('../../scripts/hooks/pre-write.js');
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });
  });
});
