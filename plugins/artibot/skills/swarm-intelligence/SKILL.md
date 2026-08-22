---
context: fork
name: swarm-intelligence
description: |
  Federated Swarm Intelligence for collective learning across Artibot instances.
  Shares anonymized learning patterns (tool success rates, error signatures, team compositions)
  with the swarm network while preserving privacy through PII scrubbing and differential privacy.
  Enables all participants to benefit from collective experience without exposing individual data.
  Triggers: swarm, collective, federated, sync patterns, share learning, global weights, opt-in, contribution
lang: [en]
platforms: [claude-code]
level: 2
triggers:
  - "swarm"
  - "collective"
  - "federated"
  - "sync patterns"
  - "share learning"
  - "global weights"
agents:
  - "orchestrator"
tokens: "~3K"
category: "learning"
source_hash: 631ad65d
whenNotToUse: "Isolated single-instance deployments where federated sharing is disabled or no network is available; also not applicable for tasks unrelated to cross-instance pattern sharing."
---

# Federated Swarm Intelligence

## DATA POLICY Notice

> **외부 서버 데이터 전송 포함** — 이 스킬은 Artibot 외부 swarm 서버(`ARTIBOT_SWARM_SERVER` 또는 config `swarm.serverUrl`)로 익명화된 패턴을 업로드합니다.
> - **opt-in 명시 동의 없이 데이터 전송 금지** (`swarm.optIn: false` 기본값 유지)
> - `ARTIBOT_SWARM_SERVER` 환경변수가 설정된 경우, 해당 외부 엔드포인트로 전송됨을 사용자에게 반드시 고지
> - DATA POLICY 예외 조건: 사용자가 직접 `/swarm opt-in`을 실행한 경우에만 허용 (자동 트리거 금지)
> - 데이터는 익명화(SHA-256, 12자 prefix) + Differential Privacy(ε=1.0) 적용 후 전송

## When This Skill Applies
- User wants to participate in collective learning across Artibot instances
- Syncing local patterns with global swarm intelligence
- Managing opt-in/opt-out status for swarm participation
- Checking contribution stats or sync status
- Understanding how pattern sharing works with privacy protections

## Core Guidance

### What Is Swarm Intelligence?

Federated learning approach where individual Artibot instances share anonymized learning patterns. Each instance contributes its local experience (what works, what fails) to a global pool, and in return receives the collective wisdom of all participants.

**Analogy**: Like a beehive where each bee shares information about flower locations without revealing its home.

### Data Flow

```
Local Patterns -> PII Scrubber -> Differential Privacy -> Upload -> Server Aggregation
                                                                         |
Local Merge <- Weight Conversion <- Integrity Check <- Download <--------+
```

### What Gets Shared

| Category | Local Data | Shared Form |
|----------|-----------|-------------|
| Tool Usage | Read: 95% success, 50ms avg | `tools.Read: {successRate: 0.95, avgLatency: 0.99}` |
| Errors | "TypeError in auth.js:42" | `errors.a3f2b1: {frequency: 0.3, recoverable: 1.0}` |
| Commands | "build took 30s, 5 files" | `commands.build: {effectiveness: 0.8, avgDuration: 0.67}` |
| Teams | "leader pattern, 3 agents" | `teams.leader: {effectiveness: 0.85, optimalSize: 3}` |

### Privacy Protections

1. **PII Scrubber**: Removes file paths, usernames, project names, API keys, URLs
2. **Differential Privacy**: Laplacian noise mechanism (epsilon = 1.0 default)
3. **Key Anonymization**: SHA-256 hashing of all identifiers (12-char prefix only)
4. **No Source Code**: Only statistical aggregates, never raw code or content
5. **Size Limit**: Maximum 5MB per upload prevents large data exfiltration
6. **Opt-in Only**: Zero data leaves the machine without explicit user consent

### Sync Lifecycle

**Session Start**:
1. Download latest global weights (delta from current version)
2. Verify checksum integrity
3. Merge into local patterns (30% local, 70% global by default)

**Session End**:
1. Package local patterns into normalized weights
2. Apply PII scrubber and differential privacy noise
3. Upload to swarm server (or queue offline)

**Configurable Intervals**: session (default), hourly, daily

### Merge Strategy

Local and global weights are merged using weighted averaging:
- **Default Ratio**: local 30%, global 70%
- **Configurable**: via `swarm.localGlobalRatio` in config
- **Conflict Resolution**: Numeric values blended, sample sizes summed

### Configuration

```json
{
  "swarm": {
    "enabled": false,
    "serverUrl": "http://localhost:3000",
    "syncInterval": "session",
    "optIn": false,
    "localGlobalRatio": [0.3, 0.7],
    "maxUploadSizeMB": 5,
    "differentialPrivacy": {
      "epsilon": 1.0,
      "mechanism": "laplacian"
    }
  }
}
```

### Commands

| Command | Action |
|---------|--------|
| `/sc swarm status` | View sync state and server health |
| `/sc swarm sync` | Force immediate upload + download |
| `/sc swarm opt-in` | Enable participation with consent |
| `/sc swarm opt-out` | Disable participation |
| `/sc swarm stats` | View contribution statistics |

### Integration Points

- **Lifelong Learner**: Provides the patterns that get packaged for upload
- **Knowledge Transfer**: Receives unpacked global patterns for System 1 promotion
- **System 1 (Cognitive)**: Benefits from merged patterns for faster responses
- **Sync Scheduler**: Hooks into session start/end for automatic sync

## Quick Reference

**Module Locations**:
- `lib/swarm/swarm-client.js` - HTTP client with retry + offline queue
- `lib/swarm/pattern-packager.js` - Pattern <-> weight conversion
- `lib/swarm/sync-scheduler.js` - Sync timing and session hooks
- `lib/swarm/swarm-config.js` - Opt-in state, endpoint, and privacy knobs

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "my instance's learnings are private" | anonymized patterns carry no PII — sharing success rates is epidemiology, not surveillance |
| "federated learning is too complex to set up" | federated simply means "sum gradients locally, share aggregates" — it's a loop, not a framework |
| "other instances learn different things than me" | that's the point — diversity in the swarm exposes you to patterns your session never encountered |
| "swarm updates will poison my local model" | validation gates and version pinning prevent poisoning; "might poison" is an excuse for zero updates |
| "I'll join the swarm once it's mature" | the swarm matures BY people joining; waiting is a coordination failure |
