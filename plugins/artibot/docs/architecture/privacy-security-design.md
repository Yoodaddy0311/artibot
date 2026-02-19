# Privacy & Security Architecture Design

## 1. Overview

This document defines the privacy and security layer for Artibot's federated swarm intelligence system. The architecture ensures that no raw PII leaves the local client, aggregation servers never see individual weights in plaintext, and all data flows comply with GDPR/CCPA requirements.

### Design Principles

| Principle | Description |
|-----------|-------------|
| **Privacy by Default** | All telemetry is opt-in. PII scrubbing is always active. |
| **Data Minimization** | Collect only what is needed for model improvement. |
| **Local-First Processing** | PII removal and noise injection happen on-device. |
| **Zero-Knowledge Aggregation** | The server never sees individual client contributions in plaintext. |
| **Auditability** | Every data flow is logged for compliance review. |

### Architecture Layers

```
Layer 0: Governance (opt-in, consent, audit)
Layer 1: PII Scrubber (local regex-based masking)
Layer 2: Differential Privacy (noise injection on weights)
Layer 3: Secure Aggregation (encrypted multi-party sum)
Layer 4: Transport Security (mTLS, certificate pinning)
```

---

## 2. PII Scrubber (Layer 1)

### 2.1 Implementation

**Module**: `lib/privacy/pii-scrubber.js`

The PII scrubber is a zero-dependency, regex-based text sanitizer that processes all outbound data before it leaves the local environment.

### 2.2 Pattern Categories

| Category | Patterns | Examples | Replacement |
|----------|----------|----------|-------------|
| **credentials** | PEM keys, PGP blocks | `-----BEGIN RSA PRIVATE KEY-----` | `[PRIVATE_KEY]` |
| **auth** | API keys, tokens, Bearer | `sk-abc123...`, `ghp_xxx`, `AKIA...` | `[REDACTED_KEY]` |
| **secrets** | Passwords, connection strings | `password=xxx`, `mongodb://...` | `[REDACTED_SECRET]` |
| **env** | Environment variable values | `export API_KEY=xxx`, `process.env.TOKEN` | `[ENV_VAR]` |
| **network** | IPs, internal hostnames, URLs | `192.168.1.1`, `host.internal` | `[IP]`, `[HOST]` |
| **personal** | Emails, phone numbers, SSN, CC | `user@example.com`, `555-123-4567` | `[EMAIL]`, `[PHONE]` |
| **paths** | User home directories, project paths | `C:\Users\john\...`, `/home/jane/...` | `{USER_HOME}\[PATH]` |
| **identifiers** | UUIDs, long hashes, base64 blocks | `550e8400-e29b-...` | `[UUID]`, `[HASH]` |
| **git** | Remote URLs (SSH/HTTPS) | `git@github.com:org/repo.git` | `git@[HOST]:[PATH].git` |
| **code** | Inline secret literals | `"password": "hunter2"` | `"password": "[REDACTED_SECRET]"` |

**Total built-in patterns**: 50+

### 2.3 Processing Pipeline

```
Input Text
  |
  v
[Priority Sort] -- patterns ordered 0..100
  |
  v
[Sequential Application] -- each pattern applied in order
  |               |
  |               +-- stats.totalScrubs++
  |               +-- stats.byCategory[cat]++
  |               +-- stats.byPattern[name]++
  |
  v
[Validation Pass] -- validateScrubbed() checks for residual PII
  |
  v
Scrubbed Output
```

### 2.4 API Surface

```javascript
import {
  scrub,              // (text) => scrubbed text
  scrubPattern,       // (object) => deep-scrubbed object
  scrubPatterns,      // (objects[]) => batch deep-scrub
  addCustomPattern,   // (name, regex, replacement, opts) => { added }
  removeCustomPattern,// (name) => { removed }
  getScrubStats,      // () => { totalScrubs, byCategory, byPattern }
  validateScrubbed,   // (text) => { clean, residual[] }
  createScopedScrubber, // (categories[]) => { scrub }
  listPatterns,       // () => [{ name, category, priority }]
  resetPatterns,      // () => restore defaults
  resetStats,         // () => clear statistics
} from './lib/privacy/pii-scrubber.js';
```

### 2.5 Integration Points

| Component | Integration | Purpose |
|-----------|-------------|---------|
| `memory-manager.js` | `scrubPattern()` on outbound memory entries | Prevent PII in shared memories |
| `knowledge-transfer.js` | `scrub()` on knowledge payloads | Clean knowledge before federation |
| Hooks (`pre-bash.js`) | `scrub()` on command logs | Sanitize audit trails |
| `grpo-optimizer.js` | `scrubPattern()` on gradient metadata | Remove PII from training signals |

---

## 3. Differential Privacy (Layer 2)

### 3.1 Mechanism: Laplacian Noise

The Laplace mechanism adds noise drawn from the Laplace distribution to numerical values before they leave the client.

**Formula**:

```
noisy_value = true_value + Lap(0, Δf / ε)
```

Where:
- `Δf` = sensitivity (maximum change any single record can cause)
- `ε` = privacy parameter (smaller = more privacy, less utility)
- `Lap(0, b)` = Laplace distribution with location 0 and scale b = Δf / ε

### 3.2 Privacy Budget Management

**Budget (ε)**:

| Level | ε Value | Privacy | Utility | Use Case |
|-------|---------|---------|---------|----------|
| Strict | 0.1 | Very High | Low | Sensitive medical/financial data |
| Conservative | 0.5 | High | Medium | Default for most deployments |
| Standard | 1.0 | Moderate | Good | General code pattern learning |
| Relaxed | 3.0 | Lower | High | Non-sensitive aggregate statistics |

**Default**: `ε = 1.0` (configurable via `artibot.config.json`)

### 3.3 Composition Theorem

Sequential queries consume privacy budget cumulatively.

**Sequential Composition**: If mechanisms M1, M2, ..., Mk satisfy ε1, ε2, ..., εk differential privacy respectively, their sequential composition satisfies (ε1 + ε2 + ... + εk)-differential privacy.

**Budget Tracking**:

```
Session Budget = ε_total (configured)
Per-Query Cost = ε_per_query

Remaining = ε_total - Σ(ε_used)

if Remaining < ε_per_query:
  BLOCK query, log budget exhaustion
  Wait for budget renewal (next epoch)
```

**Renewal Policy**: Budget resets per training epoch (configurable: hourly, daily, per-round).

### 3.4 Noise vs. Utility Tradeoff

```
Privacy (ε small)              Utility (ε large)
   |                                |
   |  Noise amplitude ∝ 1/ε        |
   |  More privacy                  |  More accuracy
   |  Less useful gradients         |  Better model convergence
   |  Slower convergence            |  More PII risk
   |                                |
   +--- Sweet spot: ε ∈ [0.5, 1.0] for code patterns ---+
```

**Adaptive ε Strategy**:
1. Start with ε = 0.5 (conservative)
2. Monitor model convergence
3. If convergence stalls, increase ε by 0.1 per round (max 2.0)
4. If privacy audit fails, decrease ε by 50%

### 3.5 Implementation Design (Pseudocode)

```javascript
// Laplace noise generator
function laplace(scale) {
  const u = Math.random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

// Apply differential privacy to weight update
function privatizeWeights(weights, sensitivity, epsilon) {
  const scale = sensitivity / epsilon;
  return weights.map(w => w + laplace(scale));
}

// Budget tracker
class PrivacyBudget {
  constructor(totalEpsilon) {
    this.total = totalEpsilon;
    this.used = 0;
  }

  canSpend(amount) {
    return (this.used + amount) <= this.total;
  }

  spend(amount) {
    if (!this.canSpend(amount)) throw new Error('Privacy budget exhausted');
    this.used += amount;
    return this.total - this.used;
  }

  reset() { this.used = 0; }
}
```

---

## 4. Secure Aggregation (Layer 3)

### 4.1 Protocol Overview

Secure aggregation ensures the server computes the sum of client updates without seeing any individual update.

**Protocol**: Simplified Boneh-style secure sum

```
1. Server broadcasts public parameters for round R
2. Each client C_i:
   a. Computes local gradient update: g_i
   b. Applies differential privacy: g_i' = g_i + Lap(Δf/ε)
   c. Generates random mask: m_i (agreed pairwise with other clients)
   d. Sends masked update: g_i' + m_i  (masks cancel in sum)
3. Server computes: Σ(g_i' + m_i) = Σ(g_i') + Σ(m_i) = Σ(g_i') + 0
4. Server obtains aggregate gradient without individual contributions
```

### 4.2 Threat Model

| Threat | Mitigation |
|--------|------------|
| Honest-but-curious server | Secure aggregation masks individual updates |
| Malicious client (poisoning) | Gradient clipping + anomaly detection |
| Man-in-the-middle | mTLS + certificate pinning |
| Replay attacks | Round-specific nonces + timestamps |
| Collusion (server + k clients) | Threshold masking (requires >k+1 honest clients) |
| Model inversion | Differential privacy + gradient clipping |

### 4.3 Gradient Clipping

Before noise injection, gradients are clipped to bound sensitivity:

```
clip(g, C) = g * min(1, C / ||g||)
```

Where `C` is the clipping threshold. This ensures `Δf <= C`.

**Default clipping threshold**: `C = 1.0`

---

## 5. Governance (Layer 0)

### 5.1 Opt-in / Opt-out Flow

```
Initial State: ALL telemetry OFF (privacy by default)

Opt-in Flow:
  1. User enables "Federated Learning" in settings
  2. System displays data collection summary
  3. User acknowledges privacy policy
  4. System records consent with timestamp + version
  5. Telemetry begins (PII scrubbing always active)

Opt-out Flow:
  1. User disables "Federated Learning" in settings
  2. System immediately stops all data collection
  3. Local learning data is retained (user-owned)
  4. Pending uploads are canceled and purged
  5. Opt-out event logged in audit trail
```

**Configuration** (in `artibot.config.json`):

```json
{
  "privacy": {
    "federatedLearning": false,
    "consentVersion": null,
    "consentTimestamp": null,
    "dataRetentionDays": 90,
    "privacyBudget": {
      "epsilon": 1.0,
      "renewalPolicy": "per-epoch"
    }
  }
}
```

### 5.2 GDPR Compliance

| Right | Implementation |
|-------|---------------|
| **Right to Access** (Art. 15) | `GET /api/v1/user/data-export` returns all stored data |
| **Right to Erasure** (Art. 17) | `DELETE /api/v1/user/data` purges all user data from server + confirms deletion |
| **Right to Rectification** (Art. 16) | `PUT /api/v1/user/data` allows correction of stored preferences |
| **Right to Portability** (Art. 20) | Export in JSON format, machine-readable |
| **Right to Restrict Processing** (Art. 18) | Equivalent to opt-out; data retained but not processed |
| **Transparency** (Art. 12-14) | Privacy dashboard showing what data is collected and how it is used |

**Data Deletion Procedure**:

```
1. User requests deletion (UI or API)
2. System marks user data as "pending_deletion"
3. All aggregated contributions with user's ID are flagged
4. Local data is deleted immediately
5. Server-side deletion completes within 30 days
6. Confirmation sent to user
7. Audit log entry created (without PII)
```

### 5.3 CCPA Compliance

| Right | Implementation |
|-------|---------------|
| **Right to Know** | Disclose categories and specific pieces of personal information collected |
| **Right to Delete** | Same as GDPR erasure |
| **Right to Opt-Out of Sale** | N/A (data is never sold) |
| **Right to Non-Discrimination** | Feature parity for users who opt out |

### 5.4 Audit Trail

All privacy-relevant events are logged in an append-only audit log.

**Logged Events**:
- Consent changes (opt-in, opt-out)
- Data export requests
- Data deletion requests
- PII scrubber activation/deactivation
- Privacy budget consumption
- Failed scrub validations (residual PII detected)
- Configuration changes affecting privacy

**Log Format**:

```json
{
  "timestamp": "2026-02-19T12:00:00Z",
  "event": "consent_change",
  "action": "opt_in",
  "consentVersion": "1.0",
  "metadata": {
    "source": "settings_ui"
  }
}
```

**Retention**: Audit logs are retained for 7 years (regulatory minimum). PII is never included in audit entries.

---

## 6. Transport Security (Layer 4)

### 6.1 Channel Security

| Measure | Details |
|---------|---------|
| **Protocol** | TLS 1.3 minimum |
| **Certificate Pinning** | Pin to known aggregation server certificates |
| **Mutual TLS** | Client certificates for device authentication |
| **Key Rotation** | Certificates rotated every 90 days |

### 6.2 Data at Rest

| Data Type | Encryption | Location |
|-----------|------------|----------|
| Local learning data | AES-256-GCM (OS keychain key) | `~/.claude/artibot/` |
| Consent records | Plaintext (non-sensitive) | `artibot.config.json` |
| Audit logs | Integrity-protected (HMAC) | `~/.claude/artibot/audit/` |

---

## 7. End-to-End Data Flow

```
[Client Device]
  |
  | 1. Local model computes gradient update (g)
  | 2. PII Scrubber sanitizes any text metadata
  | 3. Gradient clipping: g' = clip(g, C)
  | 4. Differential privacy: g'' = g' + Lap(Δf/ε)
  | 5. Secure aggregation mask: g''' = g'' + mask
  |
  |--- mTLS Channel --->
  |
[Aggregation Server]
  |
  | 6. Collect masked updates from N clients
  | 7. Sum: Σ(g''') = Σ(g'') (masks cancel)
  | 8. Update global model with aggregate gradient
  | 9. Broadcast updated model back to clients
  |
  |--- mTLS Channel --->
  |
[Client Device]
  |
  | 10. Receive and apply global model update
```

---

## 8. Configuration Reference

```json
{
  "privacy": {
    "piiScrubber": {
      "enabled": true,
      "customPatterns": [],
      "disabledCategories": []
    },
    "differentialPrivacy": {
      "enabled": true,
      "epsilon": 1.0,
      "mechanism": "laplace",
      "clippingThreshold": 1.0,
      "budgetRenewal": "per-epoch",
      "adaptiveEpsilon": false
    },
    "secureAggregation": {
      "enabled": true,
      "protocol": "secure-sum",
      "minClientsPerRound": 3,
      "thresholdMasking": true
    },
    "governance": {
      "federatedLearning": false,
      "consentRequired": true,
      "dataRetentionDays": 90,
      "auditLogEnabled": true,
      "auditLogRetentionDays": 2555,
      "gdprCompliance": true,
      "ccpaCompliance": true
    },
    "transport": {
      "tlsMinVersion": "1.3",
      "certificatePinning": true,
      "mutualTLS": true,
      "keyRotationDays": 90
    }
  }
}
```

---

## 9. Testing & Validation Strategy

| Test Type | Scope | Criteria |
|-----------|-------|----------|
| **PII Detection** | 50+ pattern unit tests | 100% pattern coverage, zero false negatives on known formats |
| **Scrub Validation** | Post-scrub residual check | `validateScrubbed()` returns clean=true for all test cases |
| **Noise Calibration** | Statistical tests on noise distribution | Laplace distribution validation via Kolmogorov-Smirnov test |
| **Budget Tracking** | Composition theorem compliance | Budget exhaustion blocks further queries |
| **Secure Aggregation** | Protocol correctness | Sum of masked values equals sum of true values |
| **Governance** | Consent flow E2E | Opt-in enables, opt-out disables, deletion purges |
| **Audit** | Log completeness | All privacy events logged, no PII in logs |

---

## 10. Future Considerations

- **Renyi Differential Privacy (RDP)**: Tighter composition bounds for multiple queries
- **Federated Analytics**: Privacy-preserving aggregate statistics without model training
- **Homomorphic Encryption**: Full computation on encrypted data (currently too expensive)
- **TEE (Trusted Execution Environment)**: Hardware-level isolation for aggregation
- **Privacy-Preserving Record Linkage**: Cross-organization learning without identity disclosure
