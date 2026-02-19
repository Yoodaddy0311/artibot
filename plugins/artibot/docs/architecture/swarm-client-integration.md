# Swarm Client SDK - Integration Architecture

## Overview

The Swarm Client SDK enables Artibot instances to participate in Federated Swarm Intelligence -- a privacy-preserving collective learning network where anonymized patterns are shared across all participants.

## Module Architecture

```
lib/swarm/
├── index.js              # Public API (re-exports)
├── swarm-client.js       # HTTP client + retry + offline queue
├── pattern-packager.js   # Pattern <-> weight conversion + merge
└── sync-scheduler.js     # Sync timing + session hooks
```

## Data Flow

```
┌─────────────────────────────────────────────────────┐
│                    Local Instance                    │
│                                                     │
│  lifelong-learner.js ──── patterns/ ────────┐       │
│       │                      │              │       │
│       ▼                      ▼              │       │
│  knowledge-transfer.js   system1.js         │       │
│                                             │       │
│                              ▼              │       │
│                     pattern-packager.js      │       │
│                         │       ▲           │       │
│                    pack │       │ unpack     │       │
│                         ▼       │           │       │
│                     swarm-client.js          │       │
│                      │    ▲                  │       │
│                      │    │ (offline queue)  │       │
│               upload │    │ download         │       │
│                      │    │                  │       │
│               sync-scheduler.js              │       │
│                (session hooks)               │       │
└──────────────────┼────┼─────────────────────┘       │
                   │    │                              │
                   ▼    │                              │
           ┌─────────────────┐                         │
           │  Swarm Server   │                         │
           │  (GCP Cloud Run)│                         │
           │                 │                         │
           │  Aggregation    │                         │
           │  + FedAvg       │                         │
           └─────────────────┘
```

## Component Responsibilities

### swarm-client.js

HTTP client for server communication.

**API Methods**:
| Method | Purpose | Error Strategy |
|--------|---------|---------------|
| `uploadWeights(weights, metadata, options)` | Upload processed weights | 3x retry + offline queue |
| `downloadLatestWeights(currentVersion?, options)` | Download global weights (delta) | 3x retry |
| `reportTelemetry(stats, options)` | Anonymous usage stats | Best-effort, silent fail |
| `checkHealth(options)` | Server health + latency | 10s timeout |
| `getContributionStats(clientId, options)` | Upload/download/rank stats | 3x retry |
| `flushOfflineQueue(options)` | Retry queued uploads | Per-item retry |

**Privacy Pipeline** (applied before upload):
1. `options.scrubPii(weights)` - PII scrubber from security module
2. `options.addNoise(weights)` - Differential privacy from security module

**Retry Strategy**: Exponential backoff (1s, 2s, 4s) with jitter. 4xx errors (except 429) are not retried.

**Offline Queue**: When network is unavailable, uploads are serialized to `~/.claude/artibot/swarm-offline-queue.json` and flushed on next successful connection.

### pattern-packager.js

Bidirectional conversion between local patterns and shareable weights.

**Packaging Pipeline** (`packagePatterns`):
```
Local patterns (tool/error/success/team)
  -> Filter (sampleSize >= 3, confidence >= 0.4)
  -> Normalize numeric values to 0-1 scale
  -> Anonymize keys with SHA-256
  -> Output weight vectors + metadata + checksum
```

**Unpacking Pipeline** (`unpackWeights`):
```
Global weight vectors
  -> Convert to local pattern format
  -> Set source = 'swarm-global'
  -> Output pattern objects for lifelong-learner
```

**Merge Strategy** (`mergeWeights`):
```
local weights + global weights -> weighted average
  Default ratio: local 30%, global 70%
  Numeric fields: blended by ratio
  Sample sizes: summed
  Non-numeric fields: local takes precedence
```

### sync-scheduler.js

Manages synchronization timing and lifecycle.

**Session Hooks**:
- `onSessionStart()` - Downloads latest global weights
- `onSessionEnd()` - Packages and uploads local patterns

**Scheduled Sync**:
- `scheduleSync({ interval })` - Sets up periodic timer
- `forceSync()` - Immediate full sync cycle
- `cancelSync()` - Clears scheduled timer

**Sync State** (persisted to `~/.claude/artibot/swarm-sync-state.json`):
```json
{
  "lastUpload": "2026-02-19T10:00:00Z",
  "lastDownload": "2026-02-19T09:00:00Z",
  "pendingUploads": 0,
  "nextSync": null,
  "currentVersion": "v42",
  "interval": "session",
  "totalUploads": 15,
  "totalDownloads": 20
}
```

## Plugin Integration

### Command: `/sc swarm`

Located at `commands/swarm.md`. Routes through the existing `sc.md` router.

Subcommands: `status`, `sync`, `opt-in`, `opt-out`, `stats`

### Skill: `swarm-intelligence`

Located at `skills/swarm-intelligence/SKILL.md`. Auto-activates on swarm-related keywords.

### Config Section

Added to `artibot.config.json`:
```json
{
  "swarm": {
    "enabled": false,
    "serverUrl": "https://artibot-swarm.run.app",
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

### Routing Table Entry

Added to `sc.md`:
```
| swarm, collective, federated | /swarm | 90% |
```

## Dependencies

**Internal** (within Artibot plugin):
- `lib/core/file.js` - JSON read/write, directory management
- `lib/core/cache.js` - TTL-based caching (via system1.js integration)
- `lib/learning/lifelong-learner.js` - Pattern source
- `lib/learning/knowledge-transfer.js` - Pattern promotion target

**External** (Node.js built-ins only):
- `node:crypto` - SHA-256 checksums and key anonymization
- `node:path` - File path construction
- `node:os` - Home directory resolution

**Zero npm dependencies** -- fully self-contained.

## Security Considerations

1. All data passes through PII scrubber before upload
2. Differential privacy noise prevents individual pattern reconstruction
3. Checksum verification on downloads prevents tampering
4. Offline queue stored locally, never transmitted without PII scrubbing
5. Opt-in only -- no data leaves without explicit consent
6. 5MB upload size limit prevents data exfiltration
7. Server URL configurable via environment variable for enterprise deployments
