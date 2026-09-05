import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// The ledger edge is stubbed so the `human.asked` record can be observed
// without a filesystem. `lib/security/human-gates.js` is deliberately NOT
// stubbed — the gate ids asserted below are real `classify()` output.
const ledger = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock('../../lib/runtime/ledger.js', () => ({ appendLedgerEvent: ledger.append }));
vi.mock('../../lib/git/project-root.js', () => ({ resolveProjectRoot: (cwd) => cwd }));

const { readStdin, writeStdout } = await import('../../scripts/utils/index.js');

// ---------------------------------------------------------------------------
// Helpers - build fake secrets dynamically to avoid hook self-blocking
// ---------------------------------------------------------------------------
/**
 * A Write/Edit PreToolUse payload. `cwd` is OMITTED by default so every
 * pre-existing case in this file keeps the payload shape it was written
 * against — which is also the shape that records nothing (the recorder needs
 * an injected root).
 *
 * @param {string} filePath
 * @param {string} [content]
 * @param {string} [toolName]
 * @param {{cwd?: string, sessionId?: string}} [opts]
 * @returns {string}
 */
function makeHookData(filePath, content, toolName = 'Write', opts = {}) {
  const input = { file_path: filePath };
  if (content !== undefined) {
    if (toolName === 'Edit') {
      input.new_string = content;
    } else {
      input.content = content;
    }
  }
  const data = {
    tool_name: toolName,
    tool_input: input,
  };
  if (opts.cwd !== undefined) data.cwd = opts.cwd;
  if (opts.sessionId !== undefined) data.session_id = opts.sessionId;
  return JSON.stringify(data);
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

/**
 * Import the hook and run its entry point. The module carries a direct-run
 * guard, so importing it no longer executes `main()` — the call has to be
 * explicit here, exactly as the spawned production process makes it.
 *
 * @returns {Promise<void>}
 */
async function runHook() {
  const mod = await import('../../scripts/hooks/pre-write.js');
  // The `.catch` is the module's OWN exported tail, not a copy of it. A
  // hand-rolled `createErrorHandler(...)` here would keep passing after the
  // real tail stopped recording — the error path would be tested against a
  // reimplementation of itself.
  await mod.main().catch(mod.handleHookError);
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

      await runHook();
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

      await runHook();
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

      await runHook();
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

      await runHook();
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

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks GitHub personal access token', async () => {
      const content = `const token = "${fakeGhToken()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/gh.js', content));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks Anthropic API key', async () => {
      const content = `const key = "${fakeAnthropicKey()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/api.js', content));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks OpenAI API key', async () => {
      const content = `const key = "${fakeOpenAiKey()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/openai.js', content));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });

    it('blocks generic secret assignment pattern', async () => {
      readStdin.mockResolvedValue(
        makeHookData('/project/src/config.js', fakeGenericSecret()),
      );

      await runHook();
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

      await runHook();
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

      await runHook();
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

      await runHook();
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

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });

    it('approves env reference without literal secret', async () => {
      readStdin.mockResolvedValue(
        makeHookData('/project/src/config.js', 'const key = process.env.API_KEY;'),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
    });
  });

  describe('block reason includes context', () => {
    it('includes filename in reason for sensitive file', async () => {
      readStdin.mockResolvedValue(makeHookData('/project/.env', 'VAR=1'));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const call = writeStdout.mock.calls[0][0];
      expect(call.decision).toBe('block');
      expect(call.reason).toContain('SECURITY WARNING');
      expect(call.reason).toContain('.env');
    });

    it('mentions hardcoded secret in content block reason', async () => {
      const content = `const key = "${fakeAwsKey()}";`;
      readStdin.mockResolvedValue(makeHookData('/project/src/app.js', content));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const call = writeStdout.mock.calls[0][0];
      expect(call.decision).toBe('block');
      expect(call.reason).toContain('hardcoded secret');
    });
  });

  describe('error handling', () => {
    it('blocks by default when hook errors', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // human.asked record (T-39 symmetry)
  // -------------------------------------------------------------------------
  describe('human.asked record', () => {
    /**
     * The payload cwd MUST name a real Artibot repo, and this is the load-
     * bearing detail of the whole describe.
     *
     * `executeChain` drops every `artibot-policy` guard when the cwd is outside
     * an Artibot repo (`lib/core/guard-registry.js:85-90`), and BOTH pre-phase
     * Write/Edit guards — `sensitive-file` and `content-secret` — are
     * `artibot-policy` (`:572-586`). So for Write/Edit, unlike for Bash, the
     * DECISION itself is cwd-dependent: a payload carrying an invented
     * `/project` cwd is approved, and every "records one line" case below would
     * pass vacuously against an approve that never recorded anything.
     *
     * Using the process cwd — the plugin directory, which holds
     * `artibot.config.json` — makes the injected value identical to the
     * `hookData?.cwd || process.cwd()` fallback the other cases in this file
     * already take. The record is then the ONLY thing the added key changes.
     * Measured 2026-09-05.
     */
    const CWD = process.cwd();
    const SID = 'sess1234abcd';
    const SENSITIVE = '/project/.env';

    it.each(['Write', 'Edit'])('appends exactly one line for a blocked %s', async (tool) => {
      readStdin.mockResolvedValue(
        makeHookData(SENSITIVE, 'VAR=1', tool, { cwd: CWD, sessionId: SID }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(ledger.append).toHaveBeenCalledTimes(1);
      const [root, event] = ledger.append.mock.calls[0];
      expect(root).toBe(CWD);
      expect(event.event).toBe('human.asked');
      expect(event.source).toBe('hook');
      expect(event.session_id).toBe(SID);
      expect(event.data.decision).toBe('block');
      // The tool is recorded as the one that was actually blocked, so a Write
      // and an Edit of the same file are distinguishable in the ledger.
      expect(event.data.tool).toBe(tool);
      expect(event.data.path).toBe(SENSITIVE);
    });

    it('records the reason byte-for-byte as it was sent to stdout', async () => {
      readStdin.mockResolvedValue(
        makeHookData(SENSITIVE, 'VAR=1', 'Write', { cwd: CWD, sessionId: SID }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(ledger.append.mock.calls[0][1].data.reason)
        .toBe(writeStdout.mock.calls[0][0].reason);
    });

    it('carries no gate id for a path no gate row claims', async () => {
      readStdin.mockResolvedValue(
        makeHookData(SENSITIVE, 'VAR=1', 'Write', { cwd: CWD, sessionId: SID }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      const { data } = ledger.append.mock.calls[0][1];
      // HG-11's signature is a COMMAND pattern (`^\s*cat …`), so a Write whose
      // *path* is `.env` matches no row even though this hook blocks it. The
      // key must be ABSENT rather than null: the allowlist types
      // `human.asked.data.gate` as a string, and a null would make the whole
      // line a `ledger.rejected`.
      expect(data.hits).toEqual([]);
      expect(Object.prototype.hasOwnProperty.call(data, 'gate')).toBe(false);
    });

    it('records nothing for a gate-matching path the chain approves', async () => {
      const configPath = '/project/artibot.config.json';
      readStdin.mockResolvedValue(
        makeHookData(configPath, 'x'.repeat(10), 'Edit', { cwd: CWD, sessionId: SID }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      // This payload is APPROVED by the guard chain, so nothing is recorded —
      // which is the point: the record follows the block, not the gate matrix.
      // A gate hit alone never produces a line.
      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
      expect(ledger.append).not.toHaveBeenCalled();
    });

    it('appends nothing on the approve path', async () => {
      readStdin.mockResolvedValue(
        makeHookData('/project/src/app.js', 'const x = 1;', 'Write', { cwd: CWD, sessionId: SID }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'approve' }),
      );
      expect(ledger.append).not.toHaveBeenCalled();
    });

    it('appends nothing when the payload carries no cwd', async () => {
      // NEGATIVE CONTROL for the whole describe: this is the payload shape
      // every other case in this file uses. If the recorder ever anchored on
      // `process.cwd()` instead of the injected root, this case is the one that
      // catches it.
      readStdin.mockResolvedValue(makeHookData(SENSITIVE, 'VAR=1'));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'block' }),
      );
      expect(ledger.append).not.toHaveBeenCalled();
    });

    it('writes the decision to stdout BEFORE it touches the ledger', async () => {
      readStdin.mockResolvedValue(
        makeHookData(SENSITIVE, 'VAR=1', 'Write', { cwd: CWD, sessionId: SID }),
      );

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      // Ordering is the observe contract: bookkeeping may never delay or
      // reorder a security decision.
      expect(writeStdout.mock.invocationCallOrder[0])
        .toBeLessThan(ledger.append.mock.invocationCallOrder[0]);
    });

    it('records nothing from the fail-closed tail, which has no payload', async () => {
      readStdin.mockRejectedValue(new Error('stdin read failed'));

      await runHook();
      await new Promise((r) => setTimeout(r, 50));

      expect(writeStdout).toHaveBeenCalledWith({
        decision: 'block',
        reason: 'Safety check failed due to hook error. Blocking by default.',
      });
      expect(ledger.append).not.toHaveBeenCalled();
    });
  });
});
