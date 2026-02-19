# Security Policy

## Supported Versions / 지원 버전

| Version | Supported | Notes |
|---------|-----------|-------|
| 1.4.x   | Yes (current) | Full support including security patches |
| 1.3.x   | Yes | Security and critical bug fixes |
| 1.2.x   | Security fixes only | End-of-life scheduled |
| < 1.2   | No | Upgrade recommended |

---

## Reporting a Vulnerability / 취약점 신고

**Please do not report security vulnerabilities through public GitHub Issues.**

보안 취약점을 공개 GitHub Issues를 통해 신고하지 마세요.

### How to Report / 신고 방법

1. **Preferred method**: Open a **private** security advisory at:
   ```
   https://github.com/artience/artibot/security/advisories/new
   ```

2. **Alternative**: Send an email to **security@artience.dev** with subject line:
   ```
   [SECURITY] Artibot - Brief description of vulnerability
   ```

3. Include in your report / 리포트에 포함할 내용:

   | Field | Description |
   |-------|-------------|
   | **Description** | Clear description of the vulnerability |
   | **Steps to reproduce** | Minimal steps to reproduce the issue |
   | **Affected versions** | Which versions of Artibot are affected |
   | **Impact assessment** | Potential severity and blast radius |
   | **Affected components** | Which modules/files are involved |
   | **Suggested fix** | If available, proposed remediation |
   | **Environment** | OS, Node.js version, Claude Code version |

### Response Timeline / 응답 일정

| Stage | Timeline | Action |
|-------|----------|--------|
| **Acknowledgment** | Within **48 hours** | We confirm receipt of your report |
| **Initial triage** | Within **72 hours** | We assess severity and assign priority |
| **Full response** | Within **7 days** | We provide a detailed assessment and remediation plan |
| **Patch release** | Within **14 days** (Critical) | Security patch is released |
| **Patch release** | Within **30 days** (High) | Security fix is included in next release |

### Responsible Disclosure Policy / 책임 있는 공개 정책

We follow **responsible disclosure**:

1. Vulnerabilities are patched **before** public disclosure
2. Reporters receive advance notice of the fix timeline
3. Credit is given to reporters in the CHANGELOG (unless anonymity is requested)
4. We coordinate disclosure timing with the reporter
5. A CVE identifier is requested for critical vulnerabilities when appropriate

### Severity Classification / 심각도 분류

| Severity | Description | Example |
|----------|-------------|---------|
| **Critical** | Remote code execution, data exfiltration | Arbitrary code execution via hook injection |
| **High** | Privilege escalation, PII exposure | PII scrubber bypass allowing data leakage |
| **Medium** | Denial of service, information disclosure | Unhandled exception crashing the plugin |
| **Low** | Minor information leak, configuration issue | Debug log exposing non-sensitive file paths |

---

## Security Architecture / 보안 아키텍처

Artibot is designed with security and privacy as foundational principles. The following protections are built into the core architecture.

### Zero Runtime Dependencies / 무런타임 의존성

Artibot's `lib/` and `scripts/` directories use **only Node.js built-in modules**:

- `node:fs` / `node:fs/promises` -- File system operations
- `node:path` -- Path manipulation
- `node:crypto` -- Cryptographic operations (checksums, hashing)
- `node:os` -- Operating system information
- `node:http` / `node:https` -- Network requests (swarm client only, opt-in)

This design eliminates the entire npm supply chain attack surface for runtime code. There are no third-party packages that can be compromised, typosquatted, or inject malicious code at runtime.

DevDependencies (`vitest`, `eslint`, `@vitest/coverage-v8`, `@eslint/js`) are used only during development and CI. They are never loaded or executed in the Claude Code plugin runtime.

### Agent Isolation / 에이전트 격리

Each agent operates in its own isolated context:

- The orchestrator (CTO) delegates work via the Agent Teams API without granting agents access to other agents' contexts
- Task data is shared only through the structured `TaskCreate`/`TaskList` API, not through direct memory access
- Agents cannot read other agents' intermediate state or working memory
- The `SendMessage` API provides controlled communication channels

### Cognitive Sandbox / 인지 샌드박스

The System 2 cognitive processor (`lib/cognitive/sandbox.js`) executes deliberate reasoning in a sandboxed environment:

- Maximum 3 retry attempts to prevent infinite loops
- No access to system-level operations from within the sandbox
- Evaluation results are validated before being applied

---

## Privacy Protections / 개인정보 보호

### PII Scrubber (`lib/privacy/pii-scrubber.js`)

Before any data leaves local storage (e.g., for Federated Swarm aggregation), the PII scrubber applies 50+ regex patterns to detect and redact sensitive information:

| Category | What is redacted | Replacement token |
|----------|-----------------|-------------------|
| Home directory paths | OS-specific user home paths | `{USER_HOME}` |
| API keys | `sk-`, `pk-`, `AKIA`, and similar key prefixes | `[REDACTED_KEY]` |
| Secrets | `password=`, `secret=`, `token=` query params | `[REDACTED_SECRET]` |
| Bearer tokens | Authorization header values | `[REDACTED_TOKEN]` |
| IP addresses | IPv4 and IPv6 addresses | `[IP]` |
| Email addresses | Standard email format | `[EMAIL]` |
| Phone numbers | International and local formats | `[PHONE]` |
| Credit card numbers | 13-16 digit sequences with Luhn validation | `[CREDIT_CARD]` |
| Social Security Numbers | US SSN format | `[SSN]` |
| MAC addresses | Network interface identifiers | `[MAC_ADDR]` |
| Private keys | PEM-encoded private key blocks | `[PRIVATE_KEY]` |
| Connection strings | Database and service connection URIs | `[CONNECTION_STRING]` |
| UUIDs | Version 4 UUIDs | `[UUID]` |
| Cryptographic hashes | SHA/MD5 hash strings | `[HASH]` |
| Environment variables | `process.env.FOO=bar` style assignments | `[ENV_VAR]` |
| File system paths | Absolute OS paths (Windows + Unix) | `[PATH]` |

The scrubber runs **before** any pattern is serialized for transmission and **cannot be disabled** for federated operations.

### Differential Privacy (Federated Swarm) / 차분 프라이버시

The Federated Swarm Intelligence feature (`lib/swarm/`) uses differential privacy noise injection:

- Gradient noise is added **before** weight aggregation
- Individual contributions cannot be reverse-engineered from aggregated model updates
- No raw session data or code content is transmitted -- only statistical weight deltas
- SHA-256 checksum verification on all uploads and downloads
- Maximum upload payload size: 5MB

### Local-First Data Storage / 로컬 우선 데이터 저장

All Artibot learning data is stored locally on the user's machine:

| Data type | Location | Persistence |
|-----------|----------|-------------|
| User-level memory | `~/.claude/artibot/` | Permanent, all projects |
| Project-level memory | `.artibot/` (project root) | Per-project |
| Session memory | In-memory only | Cleared on session exit |
| Swarm offline queue | `~/.claude/artibot/swarm-offline-queue.json` | Until flushed |
| Team configs | `~/.claude/teams/{team-name}/config.json` | Per-team |
| Task lists | `~/.claude/tasks/{team-name}/` | Per-team |
| GRPO history | `~/.claude/artibot/grpo-history.json` | Permanent |
| System 1 patterns | `~/.claude/artibot/system1-patterns.json` | Permanent |
| Transfer log | `~/.claude/artibot/transfer-log.json` | Permanent |

No data is written outside these directories. No cloud synchronization occurs without explicit user action.

### Zero External API Calls for Learning / 학습 데이터 외부 미전송

The continuous learning subsystem (`lib/learning/`) operates entirely locally:

- **Pattern extraction**: Runs in-process using Node.js built-ins
- **GRPO optimization**: Computed locally using rule-based evaluation
- **Knowledge transfer**: Promotes/demotes patterns using local thresholds
- **Lifelong learner**: Persists to `~/.claude/artibot/` only
- **Self evaluator**: Scores stored locally in `evaluations.json`
- **Tool learner**: History stored locally in `tool-history.json`

No learning data is sent to external services unless the user explicitly configures a Federated Swarm server.

### No Telemetry Without Opt-In / 옵트인 없는 텔레메트리 미수집

The telemetry collector (`lib/system/telemetry-collector.js`) is opt-in only:

```json
// artibot.config.json - telemetry is disabled by default
{
  "telemetry": {
    "enabled": false,
    "endpoint": null
  }
}
```

Artibot collects **zero usage statistics** by default. If telemetry is enabled by the user, only anonymized performance metrics are sent (no code content, no file paths, no PII).

---

## Hook Security / 훅 보안

The hook system (`scripts/hooks/`) includes built-in protections:

| Hook | Event | Protection |
|------|-------|------------|
| `pre-write.js` | PreToolUse (Write/Edit) | Blocks writes to `.env`, `.pem`, `.key`, and other sensitive file extensions |
| `pre-bash.js` | PreToolUse (Bash) | Blocks execution of `rm -rf`, `git push --force`, and other destructive commands |
| `check-console-log.js` | Stop | Warns on `console.log` presence to prevent accidental data logging |
| `quality-gate.js` | PostToolUse (Edit/Write) | Validates code quality after modifications |
| `cognitive-router.js` | UserPromptSubmit | Routes through complexity analysis for safety |

### Hook Execution Constraints / 훅 실행 제약

- All hooks have a **timeout** (3000-15000ms) to prevent hanging
- Hooks run in separate Node.js processes (process isolation)
- Hook failures are logged but do not crash the main session
- The `${CLAUDE_PLUGIN_ROOT}` variable is resolved at runtime to prevent path injection

---

## Data Handling Principles / 데이터 처리 원칙

1. **Minimum necessary data**: Artibot only stores what is needed for its learning and orchestration functions
2. **Local by default**: All storage is on the user's own machine under `~/.claude/artibot/`
3. **Scrubbed before transmission**: PII scrubber runs on all outbound data
4. **User in control**: Users can delete all Artibot data by removing `~/.claude/artibot/` and `.artibot/`
5. **No persistent identifiers**: Artibot does not generate or store device fingerprints or persistent user IDs
6. **Open source**: The full source code is available for audit at any time

### Complete Data Deletion / 완전한 데이터 삭제

To remove all Artibot data from your machine:

```bash
# Remove user-level data
rm -rf ~/.claude/artibot/

# Remove project-level data (run from project root)
rm -rf .artibot/

# Remove team data
rm -rf ~/.claude/teams/
rm -rf ~/.claude/tasks/
```

---

## Security Best Practices for Plugin Users / 플러그인 사용자를 위한 보안 모범 사례

When using Artibot:

- Do not store API keys, passwords, or secrets in files that Artibot agents will read
- Review hook configurations in `hooks/hooks.json` before enabling in production environments
- If using Federated Swarm, only connect to trusted aggregation servers
- Keep Claude Code and Node.js updated to receive security patches
- Use `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` only in trusted environments
- Regularly review the contents of `~/.claude/artibot/` to understand what data is being stored
- Do not disable the PII scrubber when configuring Federated Swarm

---

## Vulnerability Disclosure History / 취약점 공개 이력

See [CHANGELOG.md](CHANGELOG.md) for a history of security fixes by version.
