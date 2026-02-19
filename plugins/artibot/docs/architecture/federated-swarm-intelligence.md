# Federated Swarm Intelligence Architecture

> Version 0.1.0 | Status: RFC (Request for Comments)
> Author: Artibot Architecture Team
> Date: 2026-02-19

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Stage 1: Local Training](#3-stage-1-local-training)
4. [Stage 2: Federated Averaging](#4-stage-2-federated-averaging)
5. [Stage 3: Global Update](#5-stage-3-global-update)
6. [Pattern Weight JSON Schema](#6-pattern-weight-json-schema)
7. [Communication Protocol (REST API)](#7-communication-protocol-rest-api)
8. [Synchronization Sequence](#8-synchronization-sequence)
9. [Privacy & Security](#9-privacy--security)
10. [Scaling Strategy](#10-scaling-strategy)
11. [Failure Handling](#11-failure-handling)
12. [Roadmap](#12-roadmap)

---

## 1. Executive Summary

Federated Swarm Intelligence enables Artibot plugin instances across the world to collectively improve their pattern recognition, tool selection, and team orchestration capabilities -- without sharing raw user data.

**What we share**: JSON pattern weights (tool success rates, error-solution mappings, command optimization weights, team composition patterns).

**What we never share**: raw code, file paths, user identifiers, project names, or any PII.

**Core insight**: Each Artibot instance already runs a GRPO-based learning pipeline (lifelong-learner.js) that extracts local patterns. Federated Swarm Intelligence converts these local patterns into privacy-safe weight vectors, aggregates them across all participating instances via Federated Averaging, and distributes the improved global model back to every client.

### Design Constraints

- Artibot is a **Claude Code plugin**, not an LLM. We do not train LoRA adapters or fine-tune model weights.
- All shared artifacts are **JSON pattern weights** -- numerical scores and categorical mappings.
- Zero new runtime dependencies. The client SDK uses Node.js built-in modules only.
- Privacy by design: PII scrubbing happens locally before any data leaves the client.

---

## 2. System Architecture Overview

### High-Level Architecture Diagram

```
+===========================================================================+
|                     FEDERATED SWARM INTELLIGENCE                          |
+===========================================================================+
|                                                                           |
|  +------------------+    +------------------+    +------------------+     |
|  |  Client A        |    |  Client B        |    |  Client N        |     |
|  |  (Tokyo)         |    |  (Berlin)        |    |  (NYC)           |     |
|  |                  |    |                  |    |                  |     |
|  | +==============+ |    | +==============+ |    | +==============+ |     |
|  | | STAGE 1      | |    | | STAGE 1      | |    | | STAGE 1      | |     |
|  | | Local Train  | |    | | Local Train  | |    | | Local Train  | |     |
|  | |              | |    | |              | |    | |              | |     |
|  | | lifelong-    | |    | | lifelong-    | |    | | lifelong-    | |     |
|  | | learner.js   | |    | | learner.js   | |    | | learner.js   | |     |
|  | |   |          | |    | |   |          | |    | |   |          | |     |
|  | |   v          | |    | |   v          | |    | |   v          | |     |
|  | | Pattern      | |    | | Pattern      | |    | | Pattern      | |     |
|  | | Extractor    | |    | | Extractor    | |    | | Extractor    | |     |
|  | |   |          | |    | |   |          | |    | |   |          | |     |
|  | |   v          | |    | |   v          | |    | |   v          | |     |
|  | | PII Scrubber | |    | | PII Scrubber | |    | | PII Scrubber | |     |
|  | +==============+ |    | +==============+ |    | +==============+ |     |
|  |        |         |    |        |         |    |        |         |     |
|  +--------|----------    +--------|----------    +--------|----------     |
|           |                       |                       |               |
|           |    HTTPS + mTLS       |    HTTPS + mTLS       |               |
|           v                       v                       v               |
|  +====================================================================+  |
|  |                    FEDERATION SERVER (GCP)                          |  |
|  |                                                                    |  |
|  |   +------------------+    +-------------------+                    |  |
|  |   | STAGE 2          |    | Weight Registry   |                    |  |
|  |   | FedAvg Engine    |    | (Version Control) |                    |  |
|  |   |                  |    |                   |                    |  |
|  |   | Receive Deltas   |    | v1.0.0            |                    |  |
|  |   |   |              |    | v1.0.1            |                    |  |
|  |   |   v              |    | v1.1.0            |                    |  |
|  |   | Anomaly Detect   |    | ...               |                    |  |
|  |   |   |              |    +-------------------+                    |  |
|  |   |   v              |                                             |  |
|  |   | DP Noise Add     |    +-------------------+                    |  |
|  |   |   |              |    | Anomaly Detector  |                    |  |
|  |   |   v              |    |                   |                    |  |
|  |   | Weighted Avg     |    | Z-score filter    |                    |  |
|  |   |   |              |    | Byzantine detect  |                    |  |
|  |   |   v              |    | Contribution cap  |                    |  |
|  |   | Global Model     |    +-------------------+                    |  |
|  |   +------------------+                                             |  |
|  +====================================================================+  |
|           |                       |                       |               |
|           |    CDN (Cloudflare)   |                       |               |
|           v                       v                       v               |
|  +------------------+    +------------------+    +------------------+     |
|  |  STAGE 3         |    |  STAGE 3         |    |  STAGE 3         |     |
|  |  Hot-Swap Apply  |    |  Hot-Swap Apply  |    |  Hot-Swap Apply  |     |
|  |  Client A        |    |  Client B        |    |  Client N        |     |
|  +------------------+    +------------------+    +------------------+     |
+===========================================================================+
```

### Component Interaction Map

```
+---------------------------------------------------------------------+
|                        CLIENT (Per Instance)                        |
|                                                                     |
|  +-------------+     +-----------------+     +------------------+   |
|  | Session     |---->| lifelong-       |---->| Pattern          |   |
|  | Events      |     | learner.js      |     | Storage          |   |
|  | (tool use,  |     | (GRPO batch)    |     | ~/.claude/       |   |
|  |  errors,    |     |                 |     | artibot/patterns/|   |
|  |  tasks,     |     +-----------------+     +--------+---------+   |
|  |  teams)     |            |                         |             |
|  +-------------+            v                         v             |
|                 +-------------------+     +------------------+      |
|                 | knowledge-        |     | system1.js       |      |
|                 | transfer.js       |     | (fast lookup)    |      |
|                 | (S2->S1 promote)  |     +------------------+      |
|                 +-------------------+                               |
|                            |                                        |
|                            v                                        |
|                 +-------------------+                               |
|                 | swarm-client.js   |  <-- NEW                      |
|                 | (federation SDK)  |                               |
|                 |                   |                                |
|                 | - extractDelta()  |                               |
|                 | - scrubPII()      |                               |
|                 | - pushDelta()     |                               |
|                 | - pullGlobal()    |                               |
|                 | - hotSwapApply()  |                               |
|                 +-------------------+                               |
+---------------------------------------------------------------------+
```

### Data Flow Summary

```
Session Events
  --> lifelong-learner.js (GRPO batch learn)
  --> {type}-patterns.json (local patterns with confidence, bestData, sampleSize)
  --> swarm-client.js::extractDelta()
    --> PII Scrubber (remove paths, names, identifiers)
    --> Delta Weight Vector (JSON)
  --> HTTPS POST /api/v1/weights/submit
  --> Federation Server
    --> Anomaly Detection (Z-score, Byzantine filter)
    --> Differential Privacy (Gaussian noise injection)
    --> FedAvg (weighted average by sample count)
    --> Global Weight Vector (versioned)
  --> CDN publish
  --> Client pulls /api/v1/weights/latest
  --> swarm-client.js::hotSwapApply()
    --> Merge into local patterns (weighted blend)
    --> knowledge-transfer.js::hotSwap() (re-evaluate promotions)
    --> system1.js cache invalidation + warm
```

---

## 3. Stage 1: Local Training

### 3.1 Experience Collection (Existing)

The existing `lifelong-learner.js` collects four types of experiences during each session:

| Type    | Category Examples      | Data Fields                                            |
|---------|------------------------|--------------------------------------------------------|
| `tool`  | Read, Grep, Edit, Task | calls, successes, totalMs, avgMs, successRate          |
| `error` | TypeError, ENOENT      | message, code, tool, recoverable                       |
| `success`| feature, bugfix       | taskId, duration, strategy, filesModified, testsPass   |
| `team`  | leader, swarm, council | pattern, size, agents, domain, successRate, duration   |

### 3.2 GRPO Batch Learning (Existing)

The `batchLearn()` function groups experiences by `type::category`, applies rule-based scoring with weighted dimensions (success: 0.35, speed: 0.25, errorRate: 0.25, resourceEfficiency: 0.15), ranks each group, and extracts patterns where the best entry clearly outperforms the group mean.

**Output**: Pattern objects stored in `~/.claude/artibot/patterns/{type}-patterns.json`:

```json
{
  "key": "tool::Read",
  "type": "tool",
  "category": "Read",
  "confidence": 0.847,
  "bestComposite": 0.912,
  "groupMean": 0.634,
  "sampleSize": 45,
  "insight": "Tool \"Read\" performs 28% above average. Best success rate: 95%.",
  "bestData": { "calls": 120, "successes": 114, "avgMs": 45, "successRate": 0.95 },
  "consecutiveSuccesses": 5,
  "updateCount": 12
}
```

### 3.3 Delta Extraction (NEW)

The new `swarm-client.js` module converts local patterns into a **shareable delta weight vector**:

```
Local Patterns --> extractDelta() --> PII Scrubber --> Delta Vector
```

**Delta extraction algorithm**:

1. Load all pattern files from `~/.claude/artibot/patterns/`
2. For each pattern, extract only the numerical weight fields (no raw data):
   - `confidence` (float 0-1)
   - `bestComposite` (float 0-1)
   - `groupMean` (float 0-1)
   - `sampleSize` (int)
   - `consecutiveSuccesses` (int)
   - `updateCount` (int)
3. Compute **delta** = difference from last submitted weights (first submission = full weights)
4. Run PII scrubber on any string fields
5. Package as `DeltaWeightVector`

### 3.4 PII Scrubber

The PII scrubber operates **locally** before any data leaves the client.

**Scrubbing rules**:

| Field Type       | Action                                             |
|------------------|----------------------------------------------------|
| File paths       | Remove entirely (never transmitted)                |
| User names       | Remove entirely                                    |
| Project names    | Remove entirely                                    |
| Session IDs      | Replace with deterministic hash (SHA-256, salted)  |
| Error messages   | Redact paths, filenames, variable names            |
| Tool names       | Keep (public API names: Read, Grep, Edit, etc.)    |
| Pattern keys     | Keep type::category format (e.g., "tool::Read")    |
| Numeric scores   | Keep (no PII in numbers)                           |
| Strategy names   | Keep if from predefined set; redact otherwise      |
| Team agent names | Replace with role categories (e.g., "frontend")    |
| Timestamps       | Truncate to day granularity (no exact times)       |
| Domain tags      | Keep (predefined set: frontend, backend, security) |

**Implementation approach**:

```javascript
// Scrubbing pipeline (sequential, each stage sees output of previous)
const SCRUB_PIPELINE = [
  scrubFilePaths,       // Remove anything matching path patterns
  scrubUserIdentifiers, // Remove usernames, emails, hostnames
  scrubSessionIds,      // SHA-256 hash with per-client salt
  scrubErrorMessages,   // Redact specifics from error strings
  scrubTimestamps,      // Truncate to YYYY-MM-DD
  scrubAgentNames,      // Map to role categories
  validateAllowlist,    // Final pass: only allowlisted fields survive
];
```

**Allowlisted output fields** (nothing else passes through):

```
key, type, category, confidence, bestComposite, groupMean,
sampleSize, consecutiveSuccesses, updateCount, toolName,
pattern (team pattern type), teamSize, domain
```

---

## 4. Stage 2: Federated Averaging

### 4.1 FedAvg Algorithm

The federation server collects delta weight vectors from participating clients and computes a weighted average to produce a new global model.

**Algorithm**: FedAvg (McMahan et al., 2017) adapted for JSON pattern weights.

```
Given:
  N clients, each submitting delta vector D_i with sample count n_i
  Current global model G_t

For each pattern key k:
  G_{t+1}[k] = sum(n_i * D_i[k]) / sum(n_i)
    for all i where D_i contains key k

  // Only update if sufficient contributors
  if contributors(k) < MIN_CONTRIBUTORS:
    G_{t+1}[k] = G_t[k]  // Keep previous global value
```

**Aggregation parameters**:

| Parameter                | Value  | Rationale                                    |
|--------------------------|--------|----------------------------------------------|
| `MIN_CONTRIBUTORS`       | 5      | Prevent single-client domination             |
| `MAX_WEIGHT_PER_CLIENT`  | 0.20   | Cap any single client's influence at 20%     |
| `ROUND_INTERVAL`         | 6h     | Aggregate every 6 hours                      |
| `MIN_ROUND_PARTICIPANTS` | 10     | Skip round if fewer than 10 deltas received  |
| `STALENESS_THRESHOLD`    | 72h    | Discard deltas older than 72 hours           |

### 4.2 Differential Privacy

Gaussian noise is added to aggregated weights before publication to ensure differential privacy guarantees.

**Mechanism**: (epsilon, delta)-differential privacy via Gaussian mechanism.

```
For each aggregated weight w:
  w_noisy = w + N(0, sigma^2)

Where:
  sigma = sensitivity * sqrt(2 * ln(1.25 / delta)) / epsilon
  sensitivity = MAX_WEIGHT_PER_CLIENT  (0.20)
  epsilon = 1.0   (privacy budget per round)
  delta = 1e-5    (failure probability)
```

**Privacy budget management**:
- Per-round epsilon: 1.0
- Composition: Use R'enyi Differential Privacy (RDP) accountant for tight composition
- Annual budget: Track cumulative privacy loss across rounds
- Budget exhaustion: If annual budget exceeded, pause federation until reset

### 4.3 Anomaly Detection

**Three-layer filtering** to prevent poisoning attacks:

**Layer 1: Statistical Outlier Detection (Z-score)**
```
For each weight w_i in delta D_i:
  z_i = (w_i - mean(all w)) / std(all w)
  if |z_i| > 3.0:
    flag as outlier
  if outlier_ratio(D_i) > 0.30:
    reject entire delta D_i
```

**Layer 2: Byzantine Fault Detection**
```
For each client i:
  cos_sim = cosine_similarity(D_i, median(all D))
  if cos_sim < 0.3:
    flag as potentially Byzantine
  if flagged in 3 consecutive rounds:
    quarantine client (require re-verification)
```

**Layer 3: Contribution Capping**
```
For each client i:
  norm_i = L2_norm(D_i)
  if norm_i > MAX_NORM:
    D_i = D_i * (MAX_NORM / norm_i)   // Clip to max norm
```

### 4.4 Version Control

Global models use semantic versioning:

```
v{MAJOR}.{MINOR}.{PATCH}

MAJOR: Breaking schema changes (new pattern types, removed fields)
MINOR: New pattern categories added
PATCH: Weight updates from federation rounds
```

**Version metadata**:
```json
{
  "version": "1.2.47",
  "round": 47,
  "timestamp": "2026-03-15T06:00:00Z",
  "participants": 342,
  "patternCount": 128,
  "epsilon_spent": 0.98,
  "schema_version": "1.2",
  "checksum": "sha256:abc123...",
  "parent_version": "1.2.46"
}
```

---

## 5. Stage 3: Global Update

### 5.1 CDN Distribution

Global weight vectors are published to a CDN for low-latency worldwide access.

**Distribution flow**:

```
Federation Server
  --> Sign with ed25519 key
  --> Upload to Cloud Storage (GCS)
  --> CDN edge cache (Cloudflare)
  --> Client pulls via HTTPS
```

**Endpoints**:
- `GET /weights/latest.json` -- Current global model
- `GET /weights/v{VERSION}.json` -- Specific version
- `GET /weights/manifest.json` -- Version history + checksums

### 5.2 Client Hot-Swap

The client applies global weights **without restart**, leveraging the existing `knowledge-transfer.js` hot-swap mechanism.

**Hot-swap sequence**:

```
1. Pull latest global weights (if newer than local version)
2. Verify signature (ed25519)
3. Verify checksum (SHA-256)
4. Compute blended weights:
   local_blend = alpha * local_weight + (1 - alpha) * global_weight
   where alpha = LOCAL_WEIGHT_RATIO (default: 0.3)
5. Write blended patterns to ~/.claude/artibot/patterns/
6. Call knowledge-transfer.js::hotSwap()
   --> Re-evaluate promotion/demotion criteria
   --> Update System 1 cache in-memory
7. Invalidate system1.js pattern cache
8. Call system1.js::warmCache()
9. Log sync event to ~/.claude/artibot/sync-log.json
```

**Blending ratio (alpha)** determines how much the client retains its local specialization:

| Scenario                     | alpha | Rationale                                   |
|------------------------------|-------|---------------------------------------------|
| New client (< 100 experiences) | 0.1  | Trust global model more (cold start)        |
| Active client (100-1000 exp)  | 0.3  | Balanced blend (default)                    |
| Expert client (1000+ exp)     | 0.5  | Preserve local specialization               |
| Opt-in local priority         | 0.7  | User explicitly prefers local patterns      |

### 5.3 Rollout Strategy

Graduated rollout to minimize risk from bad global models:

```
Phase 1: Canary     (1% of clients, 2 hours)
  --> Monitor error rates, pattern match scores
  --> Auto-rollback if error_rate increases > 5%

Phase 2: Staged     (10% of clients, 6 hours)
  --> Monitor broader metrics
  --> Manual approval to proceed

Phase 3: General    (50% of clients, 12 hours)
  --> Full metrics validation
  --> Automatic promotion if stable

Phase 4: Full       (100% of clients)
  --> Standard operation
  --> Version locked until next round
```

**Rollback mechanism**:
```
if post_update_error_rate > pre_update_error_rate * 1.05:
  revert to parent_version
  notify federation server
  exclude this round's deltas from next aggregation
```

---

## 6. Pattern Weight JSON Schema

### 6.1 Delta Weight Vector (Client -> Server)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DeltaWeightVector",
  "description": "Privacy-safe pattern weight delta submitted by a client",
  "type": "object",
  "required": ["clientId", "schemaVersion", "timestamp", "weights"],
  "properties": {
    "clientId": {
      "type": "string",
      "description": "SHA-256 hash of client installation ID (not user-identifiable)",
      "pattern": "^[a-f0-9]{64}$"
    },
    "schemaVersion": {
      "type": "string",
      "description": "Schema version for compatibility checking",
      "pattern": "^\\d+\\.\\d+$",
      "examples": ["1.0", "1.2"]
    },
    "baseVersion": {
      "type": "string",
      "description": "Global model version this delta is based on",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "timestamp": {
      "type": "string",
      "format": "date",
      "description": "Day-granularity timestamp (privacy: no exact time)"
    },
    "totalExperiences": {
      "type": "integer",
      "minimum": 0,
      "description": "Total experiences this delta was derived from"
    },
    "weights": {
      "type": "object",
      "description": "Pattern weights keyed by pattern key",
      "additionalProperties": {
        "$ref": "#/$defs/PatternWeight"
      }
    },
    "signature": {
      "type": "string",
      "description": "ed25519 signature of the weights object"
    }
  },
  "$defs": {
    "PatternWeight": {
      "type": "object",
      "required": ["type", "category", "confidence", "sampleSize"],
      "properties": {
        "type": {
          "type": "string",
          "enum": ["tool", "error", "success", "team"],
          "description": "Pattern type"
        },
        "category": {
          "type": "string",
          "description": "Pattern category (tool name, error class, task type, team pattern)",
          "maxLength": 64
        },
        "confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "description": "Pattern confidence score"
        },
        "bestComposite": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "description": "Best GRPO composite score observed"
        },
        "groupMean": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "description": "GRPO group mean score"
        },
        "sampleSize": {
          "type": "integer",
          "minimum": 1,
          "description": "Number of experiences backing this pattern"
        },
        "consecutiveSuccesses": {
          "type": "integer",
          "minimum": 0,
          "description": "Number of consecutive successful applications"
        },
        "toolSuccessRate": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "description": "Tool-specific success rate (tool patterns only)"
        },
        "avgLatencyBucket": {
          "type": "string",
          "enum": ["fast", "medium", "slow"],
          "description": "Latency bucket (quantized for privacy)"
        },
        "teamSize": {
          "type": "integer",
          "minimum": 0,
          "maximum": 20,
          "description": "Optimal team size (team patterns only)"
        },
        "domain": {
          "type": "string",
          "enum": ["frontend", "backend", "security", "infrastructure", "documentation", "general"],
          "description": "Domain classification"
        }
      }
    }
  }
}
```

### 6.2 Global Weight Vector (Server -> Client)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "GlobalWeightVector",
  "description": "Aggregated global pattern weights distributed to clients",
  "type": "object",
  "required": ["version", "schemaVersion", "timestamp", "weights", "metadata", "signature"],
  "properties": {
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$",
      "description": "Semantic version of this global model"
    },
    "schemaVersion": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+$"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "weights": {
      "type": "object",
      "additionalProperties": {
        "$ref": "#/$defs/GlobalPatternWeight"
      }
    },
    "metadata": {
      "type": "object",
      "properties": {
        "round": { "type": "integer" },
        "participants": { "type": "integer" },
        "patternCount": { "type": "integer" },
        "epsilonSpent": { "type": "number" },
        "parentVersion": { "type": "string" },
        "checksum": { "type": "string" }
      }
    },
    "signature": {
      "type": "string",
      "description": "Server ed25519 signature for authenticity verification"
    }
  },
  "$defs": {
    "GlobalPatternWeight": {
      "type": "object",
      "required": ["type", "category", "confidence", "totalSamples", "contributorCount"],
      "properties": {
        "type": { "type": "string", "enum": ["tool", "error", "success", "team"] },
        "category": { "type": "string" },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "bestComposite": { "type": "number", "minimum": 0, "maximum": 1 },
        "groupMean": { "type": "number", "minimum": 0, "maximum": 1 },
        "totalSamples": { "type": "integer", "description": "Aggregate sample count across all contributors" },
        "contributorCount": { "type": "integer", "description": "How many clients contributed to this pattern" },
        "toolSuccessRate": { "type": "number", "minimum": 0, "maximum": 1 },
        "avgLatencyBucket": { "type": "string", "enum": ["fast", "medium", "slow"] },
        "teamSize": { "type": "integer" },
        "domain": { "type": "string" },
        "stability": {
          "type": "number",
          "minimum": 0,
          "maximum": 1,
          "description": "How stable this weight has been across rounds (low variance = high stability)"
        }
      }
    }
  }
}
```

---

## 7. Communication Protocol (REST API)

### 7.1 Base URL

```
Production: https://api.artibot.dev/federation/v1
Staging:    https://api-staging.artibot.dev/federation/v1
```

### 7.2 Authentication

All requests require a **Client Token** issued during opt-in registration.

```
Authorization: Bearer <client-token>
X-Client-ID: <sha256-of-installation-id>
X-Schema-Version: 1.0
```

Client tokens are:
- Issued per installation (not per user)
- Rotated every 90 days automatically
- Revocable by the server (for quarantined clients)
- Not tied to any user identity

### 7.3 Endpoints

#### POST /weights/submit

Submit a delta weight vector from a client.

**Request**:
```http
POST /federation/v1/weights/submit
Content-Type: application/json
Authorization: Bearer <token>
X-Client-ID: <hash>
X-Schema-Version: 1.0

{
  "clientId": "a1b2c3...",
  "schemaVersion": "1.0",
  "baseVersion": "1.2.46",
  "timestamp": "2026-03-15",
  "totalExperiences": 234,
  "weights": {
    "tool::Read": {
      "type": "tool",
      "category": "Read",
      "confidence": 0.847,
      "bestComposite": 0.912,
      "groupMean": 0.634,
      "sampleSize": 45,
      "toolSuccessRate": 0.95,
      "avgLatencyBucket": "fast"
    },
    "team::leader": {
      "type": "team",
      "category": "leader",
      "confidence": 0.78,
      "bestComposite": 0.85,
      "groupMean": 0.62,
      "sampleSize": 12,
      "teamSize": 3,
      "domain": "backend"
    }
  },
  "signature": "ed25519:<sig>"
}
```

**Response**:
```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "status": "accepted",
  "round": 48,
  "estimatedAggregation": "2026-03-15T12:00:00Z",
  "currentVersion": "1.2.47"
}
```

**Error responses**:
| Status | Code                    | Description                          |
|--------|-------------------------|--------------------------------------|
| 400    | `INVALID_SCHEMA`        | Delta does not match JSON schema     |
| 400    | `STALE_BASE_VERSION`    | Base version too old (>5 versions)   |
| 401    | `UNAUTHORIZED`          | Invalid or expired token             |
| 403    | `CLIENT_QUARANTINED`    | Client flagged by anomaly detection  |
| 413    | `PAYLOAD_TOO_LARGE`     | Delta exceeds 256KB limit            |
| 429    | `RATE_LIMITED`          | Too many submissions (max 4/day)     |

#### GET /weights/latest

Retrieve the latest global weight vector.

**Request**:
```http
GET /federation/v1/weights/latest
Authorization: Bearer <token>
X-Client-ID: <hash>
If-None-Match: "v1.2.47"
```

**Response**:
```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "v1.2.48"
Cache-Control: public, max-age=3600
X-Rollout-Group: general

{
  "version": "1.2.48",
  "schemaVersion": "1.0",
  "timestamp": "2026-03-15T12:00:00Z",
  "weights": { ... },
  "metadata": {
    "round": 48,
    "participants": 342,
    "patternCount": 128,
    "epsilonSpent": 0.98,
    "parentVersion": "1.2.47",
    "checksum": "sha256:def456..."
  },
  "signature": "ed25519:<server-sig>"
}
```

**304 Not Modified**: Returned when client already has the latest version (ETag match).

#### GET /weights/v/{version}

Retrieve a specific version (for rollback or diff analysis).

```http
GET /federation/v1/weights/v/1.2.46
```

#### GET /weights/manifest

Version history and metadata for client-side caching decisions.

```http
GET /federation/v1/weights/manifest

{
  "latest": "1.2.48",
  "versions": [
    { "version": "1.2.48", "timestamp": "2026-03-15T12:00:00Z", "participants": 342, "checksum": "sha256:..." },
    { "version": "1.2.47", "timestamp": "2026-03-15T06:00:00Z", "participants": 298, "checksum": "sha256:..." }
  ],
  "schemaVersion": "1.0",
  "minSupportedClient": "0.2.0"
}
```

#### POST /register

Register a new client for federation participation (opt-in).

```http
POST /federation/v1/register
Content-Type: application/json

{
  "installationHash": "sha256:<hash>",
  "pluginVersion": "1.3.0",
  "schemaVersion": "1.0",
  "platform": "win32",
  "consent": {
    "federation": true,
    "analytics": false,
    "timestamp": "2026-03-15T00:00:00Z"
  }
}

Response:
{
  "clientToken": "fed_...",
  "clientId": "sha256:<derived>",
  "expiresAt": "2026-06-15T00:00:00Z",
  "serverPublicKey": "ed25519:<pub>"
}
```

#### GET /health

Server health check (unauthenticated).

```http
GET /federation/v1/health

{
  "status": "healthy",
  "currentRound": 48,
  "activeClients": 1247,
  "latestVersion": "1.2.48",
  "nextAggregation": "2026-03-15T18:00:00Z"
}
```

---

## 8. Synchronization Sequence

### 8.1 Full Sync Cycle (Sequence Diagram)

```
Client                        Federation Server              CDN
  |                                  |                        |
  |  [Session ends]                  |                        |
  |  lifelong-learner.batchLearn()   |                        |
  |  knowledge-transfer.hotSwap()    |                        |
  |                                  |                        |
  |  swarm-client.extractDelta()     |                        |
  |  swarm-client.scrubPII()         |                        |
  |                                  |                        |
  |--- POST /weights/submit -------->|                        |
  |                                  |                        |
  |<-- 202 Accepted -----------------|                        |
  |                                  |                        |
  |        [6 hours pass, round triggers]                     |
  |                                  |                        |
  |                    anomalyDetect(all deltas)              |
  |                    addDPNoise(aggregated)                 |
  |                    fedAvg(filtered deltas)                |
  |                    versionBump(global)                    |
  |                    sign(global, serverKey)                |
  |                                  |                        |
  |                                  |--- publish ----------->|
  |                                  |    (global weights)    |
  |                                  |                        |
  |  [Periodic check, every 1h]      |                        |
  |                                  |                        |
  |--- GET /weights/latest ---------------------------------->|
  |                                  |                        |
  |<-- 200 OK (or 304 Not Modified) -------------------------|
  |                                  |                        |
  |  verifySignature(response)       |                        |
  |  verifyChecksum(response)        |                        |
  |  computeBlend(local, global)     |                        |
  |  writePatterns(blended)          |                        |
  |  knowledge-transfer.hotSwap()    |                        |
  |  system1.warmCache()             |                        |
  |                                  |                        |
  | [Next session starts with        |                        |
  |  improved global knowledge]      |                        |
```

### 8.2 Timing & Cadence

```
CLIENT TIMELINE:
  |----- Session 1 -----|----- idle -----|----- Session 2 -----|
  |                      |                |                      |
  | collect experiences  | submit delta   | pull global          |
  | batch learn          | (if changed)   | hot-swap apply       |
  | hot-swap local       |                | collect experiences  |
  |                      |                | ...                  |

SERVER TIMELINE:
  |------- Round N ---------|------- Round N+1 ---------|
  |                         |                           |
  | collect deltas (6h)     | collect deltas (6h)       |
  | aggregate               | aggregate                 |
  | publish v1.2.N          | publish v1.2.N+1          |
```

### 8.3 Offline & Partial Sync

Clients may be offline for extended periods. The protocol handles this gracefully:

```
if client.baseVersion < server.latestVersion - 5:
  // Client is very stale: download full global weights (not delta)
  GET /weights/latest  (full download, ~50-200KB)
  apply with alpha = 0.1  (heavily favor global)

elif client.baseVersion < server.latestVersion:
  // Client is slightly behind: normal sync
  GET /weights/latest
  apply with alpha = LOCAL_WEIGHT_RATIO

else:
  // Client is up to date: 304 Not Modified
  skip
```

**Network failure handling**:
- Failed submissions are queued locally (max 5 pending deltas)
- Queued deltas are retried with exponential backoff (1min, 5min, 30min, 2h, 12h)
- If queue is full, oldest delta is discarded (it's stale anyway)
- Failed pulls use last-known global weights (stale but safe)

---

## 9. Privacy & Security

### 9.1 Privacy Guarantees

| Guarantee                  | Mechanism                                              |
|----------------------------|--------------------------------------------------------|
| No raw code shared         | PII scrubber removes all code/file content             |
| No file paths shared       | Scrubber strips all path-like strings                  |
| No user identity           | Client ID is SHA-256 of installation ID                |
| Differential privacy       | Gaussian noise (epsilon=1.0) on aggregated weights     |
| Contribution anonymity     | Server cannot reconstruct individual contributions     |
| Opt-in only                | Federation disabled by default; explicit consent needed|
| Revocable consent          | Client can deregister at any time; data purged in 24h  |

### 9.2 Threat Model

| Threat                          | Mitigation                                           |
|---------------------------------|------------------------------------------------------|
| Malicious weight injection      | Z-score filter + Byzantine detection + norm clipping |
| Server compromise               | Client-side signature verification + checksum        |
| Man-in-the-middle               | mTLS + certificate pinning + ed25519 signatures      |
| Privacy leakage from weights    | DP noise + PII scrubber + day-granularity timestamps |
| Model inversion attack          | Aggregation with min 5 contributors per pattern      |
| Sybil attack (fake clients)     | Rate limiting + installation verification + quarantine|
| Replay attack                   | Nonce in submissions + baseVersion validation        |

### 9.3 Security Architecture

```
Client Security:
  - PII scrubber (local, before transmission)
  - Client-side ed25519 key pair (signs deltas)
  - Server public key pinning (verifies global weights)
  - Local encryption at rest (OS keychain for token)

Transport Security:
  - HTTPS (TLS 1.3 minimum)
  - Certificate pinning to federation server
  - Request signing with client key

Server Security:
  - Server-side ed25519 key pair (signs global weights)
  - Anomaly detection pipeline (3-layer)
  - Rate limiting per client
  - Audit logging (actions, not data)
  - No persistent storage of raw deltas after aggregation
```

---

## 10. Scaling Strategy

### 10.1 Scale Tiers

```
+===================================================================+
| TIER 1: MVP (100 clients)                                        |
+===================================================================+
|                                                                   |
| Infrastructure:                                                   |
|   - Single Cloud Run instance (2 vCPU, 4GB RAM)                  |
|   - Cloud Storage for weight files                                |
|   - Firestore for client registry                                 |
|   - No CDN (direct serve from Cloud Run)                          |
|                                                                   |
| Performance:                                                      |
|   - Aggregation: < 1 second                                       |
|   - Storage: < 1 MB global weights                                |
|   - Bandwidth: < 1 GB/month                                       |
|   - Cost: < $50/month                                             |
|                                                                   |
| Limitations:                                                      |
|   - Single region (us-central1)                                   |
|   - No redundancy                                                 |
|   - Manual monitoring                                             |
+===================================================================+

+===================================================================+
| TIER 2: Growth (10,000 clients)                                  |
+===================================================================+
|                                                                   |
| Infrastructure:                                                   |
|   - Cloud Run auto-scaling (2-10 instances)                       |
|   - Cloud Storage + CDN (Cloudflare)                              |
|   - Firestore (auto-scaling)                                      |
|   - Cloud Pub/Sub for async delta processing                      |
|   - Cloud Monitoring + Alerting                                   |
|                                                                   |
| Performance:                                                      |
|   - Aggregation: < 10 seconds                                     |
|   - Storage: < 10 MB global weights                               |
|   - Bandwidth: < 50 GB/month                                      |
|   - Cost: < $500/month                                            |
|                                                                   |
| Architecture changes:                                             |
|   - Async delta ingestion via Pub/Sub                             |
|   - CDN for weight distribution                                   |
|   - Multi-region replication (us, eu, asia)                       |
|   - Automated canary rollouts                                     |
+===================================================================+

+===================================================================+
| TIER 3: Scale (100,000+ clients)                                 |
+===================================================================+
|                                                                   |
| Infrastructure:                                                   |
|   - GKE cluster (auto-scaling node pools)                         |
|   - Cloud Spanner (global consistency)                            |
|   - Cloud CDN + Cloudflare (multi-CDN)                            |
|   - Cloud Pub/Sub + Dataflow (stream processing)                  |
|   - BigQuery (analytics, no PII)                                  |
|   - Artifact Registry (versioned weight artifacts)                |
|                                                                   |
| Performance:                                                      |
|   - Aggregation: < 60 seconds (parallelized)                     |
|   - Storage: < 100 MB global weights                              |
|   - Bandwidth: < 5 TB/month                                       |
|   - Cost: < $5,000/month                                          |
|                                                                   |
| Architecture changes:                                             |
|   - Hierarchical federation (regional -> global)                  |
|   - Streaming aggregation (not batch)                             |
|   - A/B testing of global models                                  |
|   - Automated privacy budget management                           |
|   - Federated analytics dashboard                                 |
+===================================================================+
```

### 10.2 Hierarchical Federation (Tier 3)

At 100K+ clients, a single global aggregation becomes bottlenecked. Hierarchical federation introduces regional aggregation:

```
          +-------------------+
          |  Global FedAvg    |
          |  (6h rounds)      |
          +---+-------+-------+
              |       |       |
     +--------+  +----+----+  +--------+
     | Region |  | Region  |  | Region |
     | US     |  | EU      |  | Asia   |
     | FedAvg |  | FedAvg  |  | FedAvg |
     | (1h)   |  | (1h)    |  | (1h)   |
     +---+----+  +----+----+  +----+---+
         |            |            |
    +----+----+  +----+----+  +---+-----+
    | Clients |  | Clients |  | Clients |
    | 30K     |  | 40K     |  | 30K     |
    +---------+  +---------+  +---------+
```

**Benefits**:
- Lower latency for regional updates (1h vs 6h)
- Reduced bandwidth (deltas travel shorter distances)
- Regional patterns preserved (different tool usage in different regions)
- Global patterns still propagate (6h cadence)

---

## 11. Failure Handling

### 11.1 Client-Side Failures

| Failure                    | Detection            | Recovery                                 |
|----------------------------|----------------------|------------------------------------------|
| Network timeout            | HTTP timeout (30s)   | Queue delta, retry with backoff          |
| Server 5xx error           | HTTP status code     | Queue delta, retry with backoff          |
| Invalid server signature   | ed25519 verify fail  | Reject update, alert user, log event     |
| Checksum mismatch          | SHA-256 verify fail  | Reject update, retry fresh download      |
| Corrupt local patterns     | JSON parse error     | Reset to last known good, re-pull global |
| Disk full                  | Write error          | Skip sync, warn user, continue offline   |
| Token expired              | 401 response         | Auto-refresh via /register               |
| Client quarantined         | 403 response         | Alert user, provide appeal mechanism     |

### 11.2 Server-Side Failures

| Failure                    | Detection                | Recovery                                   |
|----------------------------|--------------------------|--------------------------------------------|
| Insufficient participants  | count < MIN_ROUND_PARTS  | Skip round, extend collection window       |
| Aggregation timeout        | Processing > 5 minutes   | Abort round, retry with smaller batch      |
| Storage write failure      | GCS write error          | Retry 3x, then alert ops, pause publishing |
| CDN propagation failure    | Edge health check fail   | Serve directly from origin, alert ops      |
| Privacy budget exhausted   | epsilon_total > annual   | Pause federation, reset budget at year end |
| Mass anomaly detection     | >30% deltas flagged      | Abort round, investigate, manual review    |
| Database unavailable       | Firestore timeout        | Queue operations, serve cached responses   |

### 11.3 Consistency Guarantees

The system provides **eventual consistency** with the following guarantees:

- **Monotonic version**: Clients never go backwards in version (rollback is a new version)
- **At-least-once delivery**: Deltas may be submitted more than once; server deduplicates by clientId+timestamp
- **Idempotent apply**: Applying the same global weights twice produces the same result
- **Bounded staleness**: Clients are at most `STALENESS_THRESHOLD` (72h) behind the server

---

## 12. Roadmap

### Phase 1: Foundation (MVP)

**Duration**: 4-6 weeks
**Target**: 100 opt-in beta testers

**Deliverables**:
- [ ] `swarm-client.js` -- Client SDK (extractDelta, scrubPII, pushDelta, pullGlobal, hotSwapApply)
- [ ] PII Scrubber module with full allowlist enforcement
- [ ] Federation server MVP (Cloud Run + Cloud Storage + Firestore)
- [ ] REST API: /register, /weights/submit, /weights/latest, /health
- [ ] Client-side signature verification (ed25519)
- [ ] Opt-in consent flow in plugin settings
- [ ] Basic anomaly detection (Z-score filter)
- [ ] Manual aggregation trigger (ops dashboard)
- [ ] `artibot.config.json` federation settings section

**Config addition**:
```json
{
  "federation": {
    "enabled": false,
    "serverUrl": "https://api.artibot.dev/federation/v1",
    "syncInterval": 3600000,
    "localWeightRatio": 0.3,
    "consent": null,
    "autoSync": true,
    "maxPendingDeltas": 5
  }
}
```

### Phase 2: Privacy & Security Hardening

**Duration**: 3-4 weeks
**Target**: Public beta

**Deliverables**:
- [ ] Differential privacy implementation (Gaussian mechanism with RDP accountant)
- [ ] Byzantine fault detection (cosine similarity + quarantine)
- [ ] Contribution norm clipping
- [ ] mTLS for client-server communication
- [ ] Token rotation (automatic 90-day cycle)
- [ ] Client deregistration and data purge
- [ ] Privacy budget dashboard (server-side)
- [ ] Security audit (third-party)

### Phase 3: Scale & Distribution

**Duration**: 4-6 weeks
**Target**: 10,000 clients

**Deliverables**:
- [ ] CDN integration (Cloudflare)
- [ ] Canary/staged/full rollout pipeline
- [ ] Async delta ingestion (Cloud Pub/Sub)
- [ ] Multi-region deployment (us, eu, asia)
- [ ] Automated rollback on error rate spike
- [ ] A/B testing framework for global models
- [ ] Client dashboard (sync status, contribution stats)
- [ ] Monitoring & alerting (Cloud Monitoring + PagerDuty)

### Phase 4: Full Scale & Advanced Features

**Duration**: 6-8 weeks
**Target**: 100,000+ clients

**Deliverables**:
- [ ] Hierarchical federation (regional aggregation)
- [ ] Streaming aggregation (Cloud Dataflow)
- [ ] Domain-specific models (frontend vs backend vs security)
- [ ] Personalization layer (client-specific model blend)
- [ ] Federated analytics dashboard (BigQuery, no PII)
- [ ] Cross-plugin compatibility (weight format standard)
- [ ] Academic paper on federated plugin learning
- [ ] Open-source federation server

---

## Appendix A: Glossary

| Term                  | Definition                                                       |
|-----------------------|------------------------------------------------------------------|
| Delta Weight Vector   | Difference between local patterns and last-submitted weights     |
| FedAvg                | Federated Averaging -- weighted mean of client contributions     |
| GRPO                  | Group Relative Policy Optimization -- rule-based ranking method  |
| Hot-Swap              | Updating patterns in memory without process restart              |
| PII                   | Personally Identifiable Information                              |
| Pattern Weight        | Numerical score representing a learned behavior's effectiveness  |
| System 1              | Fast intuitive response engine (cached patterns)                 |
| System 2              | Slow deliberate reasoning engine (full analysis)                 |
| Differential Privacy  | Mathematical guarantee limiting individual contribution leakage  |
| Byzantine Fault       | Arbitrary/malicious behavior from a participant                  |

## Appendix B: File Map (New & Modified)

```
plugins/artibot/
  lib/
    learning/
      swarm-client.js         [NEW]  Federation client SDK
      pii-scrubber.js         [NEW]  PII removal pipeline
    federation/
      fed-avg.js              [NEW]  Server-side FedAvg engine
      anomaly-detector.js     [NEW]  3-layer anomaly detection
      dp-noise.js             [NEW]  Differential privacy noise
      weight-registry.js      [NEW]  Version control for global weights
      rollout-manager.js      [NEW]  Canary/staged/full rollout
  docs/
    architecture/
      federated-swarm-intelligence.md  [THIS FILE]
  artibot.config.json         [MODIFIED]  Add federation section
```

## Appendix C: Decision Log

| Decision                        | Chosen              | Alternatives Considered      | Rationale                                    |
|---------------------------------|----------------------|------------------------------|----------------------------------------------|
| Aggregation algorithm           | FedAvg               | FedProx, FedMA, SCAFFOLD     | Simplest, well-understood, sufficient for v1 |
| Privacy mechanism               | Gaussian DP          | Local DP, Secure aggregation | Central DP gives better utility at same eps  |
| Transport security              | HTTPS + ed25519      | mTLS-only, JWT               | Lightweight, no PKI infrastructure needed    |
| Storage                         | Cloud Storage + CDN  | S3, R2, self-hosted          | GCP ecosystem integration                    |
| Anomaly detection               | Z-score + Byzantine  | ML-based, reputation         | Deterministic, auditable, low overhead       |
| Client ID scheme                | SHA-256(install_id)  | UUID, session-based          | Unlinkable to user, stable per installation  |
| Rollout strategy                | Canary -> Staged     | Flag-based, instant          | Risk reduction with measurable feedback      |
| Local blend ratio (alpha)       | 0.3 default          | 0.5, 0.1                     | Balanced between local specialization/global |
| Round interval                  | 6 hours              | 1h, 24h                      | Balance between freshness and privacy budget |
| Min contributors per pattern    | 5                    | 3, 10                        | Privacy (k-anonymity) vs pattern coverage    |
