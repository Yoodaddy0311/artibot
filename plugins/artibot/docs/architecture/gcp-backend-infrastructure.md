# GCP Backend Infrastructure - Federated Swarm Intelligence

> Version: 1.0.0 | Status: Architecture Design | Last Updated: 2026-02-19

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Service Architecture (Cloud Run)](#2-service-architecture-cloud-run)
3. [API Endpoint Specification](#3-api-endpoint-specification)
4. [Data Flow Architecture](#4-data-flow-architecture)
5. [Storage Design](#5-storage-design)
6. [Security Architecture](#6-security-architecture)
7. [Networking & CDN](#7-networking--cdn)
8. [Monitoring & Alerting](#8-monitoring--alerting)
9. [CI/CD Pipeline (Cloud Build)](#9-cicd-pipeline-cloud-build)
10. [Terraform / IaC Structure](#10-terraform--iac-structure)
11. [Cost Estimation](#11-cost-estimation)
12. [Environment Configuration](#12-environment-configuration)
13. [Disaster Recovery & SLA](#13-disaster-recovery--sla)

---

## 1. System Architecture Overview

### High-Level Architecture Diagram

```
                          Artibot Federated Swarm Intelligence - GCP Backend
                          ===================================================

    [Plugin Clients]                    [GCP Cloud]                        [Analytics]
    ================              =====================                   ==========

    +---------------+             +-------------------+
    | Artibot       |  HTTPS/gRPC | Cloud Load        |
    | Plugin        |------------>| Balancer (GLB)    |
    | Instance A    |             | + Cloud Armor     |
    +---------------+             +--------+----------+
                                           |
    +---------------+                      |
    | Artibot       |                      v
    | Plugin        |-------->  +----------+----------+
    | Instance B    |           |   Cloud Run Services |
    +---------------+           |   ==================|
                                |                     |
    +---------------+           | +-----------------+ |        +------------------+
    | Artibot       |           | | Weight Ingestion| |------->| Cloud Pub/Sub    |
    | Plugin        |-------->  | | Service         | |        | (weight-queue)   |
    | Instance N    |           | +-----------------+ |        +--------+---------+
    +---------------+           |                     |                 |
                                | +-----------------+ |                 v
                                | | Aggregation     |<|----  +------------------+
                                | | Service         | |      | Cloud Scheduler  |
                                | +-----------------+ |      | (6h / N-trigger) |
                                |         |           |      +------------------+
                                | +-----------------+ |
                                | | Distribution    | |----> +------------------+
                                | | Service         | |      | Cloud CDN        |
                                | +-----------------+ |      | (Global Cache)   |
                                |                     |      +------------------+
                                | +-----------------+ |
                                | | Telemetry       | |----> +------------------+
                                | | Service         | |      | BigQuery         |
                                | +-----------------+ |      | (Analytics)      |
                                |                     |      +------------------+
                                | +-----------------+ |
                                | | Health / Auth   | |
                                | | Service         | |
                                | +-----------------+ |
                                +---------------------+
                                           |
                          +----------------+----------------+
                          |                |                |
                    +-----+-----+   +------+------+  +-----+------+
                    | Cloud      |   | Firestore   |  | Secret     |
                    | Storage    |   | (Metadata)  |  | Manager    |
                    | (Weights)  |   |             |  |            |
                    +------------+   +-------------+  +------------+
```

### Design Principles

| Principle | Implementation |
|-----------|---------------|
| **Serverless-First** | Cloud Run auto-scales 0-to-N; zero cost at idle |
| **Event-Driven** | Pub/Sub decouples ingestion from aggregation |
| **Privacy-by-Design** | No raw user data stored; differential privacy on weights |
| **Global Distribution** | Cloud CDN for low-latency weight distribution |
| **Cost Efficiency** | Pay-per-request model; free tier maximization |
| **Infrastructure as Code** | Terraform modules for reproducible deployments |

---

## 2. Service Architecture (Cloud Run)

### Service Catalog

| Service | Image | Min/Max Instances | CPU | Memory | Concurrency | Timeout |
|---------|-------|-------------------|-----|--------|-------------|---------|
| `weight-ingestion` | `gcr.io/{project}/weight-ingestion` | 0 / 10 | 1 | 512Mi | 80 | 300s |
| `aggregation` | `gcr.io/{project}/aggregation` | 0 / 3 | 2 | 2Gi | 1 | 900s |
| `distribution` | `gcr.io/{project}/distribution` | 1 / 20 | 1 | 256Mi | 200 | 60s |
| `telemetry` | `gcr.io/{project}/telemetry` | 0 / 5 | 1 | 256Mi | 100 | 30s |
| `health-auth` | `gcr.io/{project}/health-auth` | 1 / 5 | 0.5 | 128Mi | 200 | 10s |

### Service Details

#### 2.1 Weight Ingestion Service

**Responsibility**: Receive, validate, and queue local pattern weights from plugin instances.

```
Request Flow:
  Client --[POST /weights/upload]--> Ingestion Service
    1. API Key validation (via health-auth)
    2. Request body schema validation (JSON Schema)
    3. Weight tensor shape verification
    4. Size limit check (max 10MB per upload)
    5. Anomaly detection (statistical outlier filtering)
    6. Store raw weights to Cloud Storage (temp bucket)
    7. Publish message to Pub/Sub (weight-processing-queue)
    8. Return acknowledgment with upload_id
```

**Anomaly Detection Rules**:
- Weight magnitude: reject if any value > 3 standard deviations from running mean
- Tensor shape: must match expected model architecture dimensions
- Upload frequency: rate limit per client (max 1 upload per hour per instance)
- Checksum: SHA-256 integrity verification

#### 2.2 Aggregation Service

**Responsibility**: Execute Federated Averaging (FedAvg) to produce global weights.

```
Trigger Conditions (OR):
  - Cloud Scheduler: every 6 hours (cron: 0 */6 * * *)
  - Pub/Sub threshold: N >= 50 accumulated uploads
  - Manual trigger: admin API call

Aggregation Pipeline:
  1. Pull pending weight uploads from Cloud Storage
  2. Validate minimum contribution threshold (>= 5 clients)
  3. Apply differential privacy noise (epsilon = 1.0, delta = 1e-5)
  4. Execute weighted FedAvg:
     w_global = SUM(n_k / n_total * w_k) for k in clients
  5. Compute delta from previous global version
  6. Store new global weights to Cloud Storage (versioned)
  7. Update Firestore metadata (version, timestamp, contributors)
  8. Invalidate Cloud CDN cache
  9. Publish aggregation-complete event
  10. Clean up temporary upload files
```

**FedAvg Configuration**:
```json
{
  "algorithm": "federated_averaging",
  "min_clients_per_round": 5,
  "max_clients_per_round": 1000,
  "weight_decay": 0.001,
  "learning_rate_global": 1.0,
  "clipping_norm": 1.0,
  "differential_privacy": {
    "enabled": true,
    "epsilon": 1.0,
    "delta": 1e-5,
    "noise_multiplier": 1.1
  }
}
```

#### 2.3 Distribution Service

**Responsibility**: Serve global weights to plugin instances with CDN caching.

```
Request Flow:
  Client --[GET /weights/latest]--> Cloud CDN
    Cache HIT  --> Return cached global weights (< 50ms)
    Cache MISS --> Distribution Service
      1. Fetch latest version metadata from Firestore
      2. Generate signed URL for Cloud Storage object
      3. Return weights with version info and ETag
      4. CDN caches response (TTL: 1 hour)

  Client --[GET /weights/diff/{from_version}]--> Distribution Service
    1. Validate from_version exists
    2. Compute binary diff (bsdiff algorithm)
    3. Return delta weights (typically 60-80% smaller)
    4. Cache diff for popular version transitions
```

**Caching Strategy**:
- Cloud CDN TTL: 1 hour for `/latest`, 24 hours for `/diff/{version}`
- ETag-based conditional requests for bandwidth savings
- Regional cache keys for geo-distributed performance

#### 2.4 Telemetry Service

**Responsibility**: Collect anonymized usage statistics for analytics.

```
Data Pipeline:
  Client --[POST /telemetry/report]--> Telemetry Service
    1. Strip all PII (enforced at schema level)
    2. Validate against telemetry schema
    3. Assign anonymous session hash (SHA-256 of random nonce)
    4. Batch write to BigQuery (streaming insert)
    5. Return acknowledgment

Collected Metrics (anonymized):
  - Pattern match accuracy (aggregate)
  - Weight convergence rate
  - Client version distribution
  - Feature usage frequency
  - Error rates by category
```

---

## 3. API Endpoint Specification

### Base URL

```
Production:  https://api.artibot-swarm.run.app/api/v1
Staging:     https://api-staging.artibot-swarm.run.app/api/v1
Development: https://api-dev.artibot-swarm.run.app/api/v1
```

### Endpoint Reference (OpenAPI 3.1)

```yaml
openapi: "3.1.0"
info:
  title: Artibot Federated Swarm Intelligence API
  version: "1.0.0"
  description: Backend API for federated learning weight exchange

servers:
  - url: https://api.artibot-swarm.run.app/api/v1
    description: Production

security:
  - ApiKeyAuth: []

paths:
  /weights/upload:
    post:
      operationId: uploadWeights
      summary: Upload local pattern weights
      tags: [Weights]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/WeightUploadRequest"
      responses:
        "202":
          description: Accepted for processing
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/UploadAcknowledgment"
        "400":
          description: Validation error
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "413":
          description: Payload too large (>10MB)
        "429":
          description: Rate limit exceeded
          headers:
            Retry-After:
              schema:
                type: integer

  /weights/latest:
    get:
      operationId: getLatestWeights
      summary: Retrieve latest global weights
      tags: [Weights]
      parameters:
        - name: format
          in: query
          schema:
            type: string
            enum: [full, compressed, metadata_only]
            default: full
        - name: If-None-Match
          in: header
          schema:
            type: string
          description: ETag for conditional request
      responses:
        "200":
          description: Global weights returned
          headers:
            ETag:
              schema:
                type: string
            X-Weight-Version:
              schema:
                type: string
            Cache-Control:
              schema:
                type: string
                example: "public, max-age=3600"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/GlobalWeightsResponse"
        "304":
          description: Not modified (ETag match)

  /weights/diff/{from_version}:
    get:
      operationId: getWeightDiff
      summary: Retrieve delta weights from a specific version
      tags: [Weights]
      parameters:
        - name: from_version
          in: path
          required: true
          schema:
            type: string
            pattern: "^v\\d+\\.\\d+\\.\\d+$"
      responses:
        "200":
          description: Delta weights returned
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/DeltaWeightsResponse"
        "404":
          description: Version not found
        "410":
          description: Version expired (older than 30 days)

  /telemetry/report:
    post:
      operationId: reportTelemetry
      summary: Submit anonymized usage telemetry
      tags: [Telemetry]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/TelemetryReport"
      responses:
        "204":
          description: Telemetry accepted
        "400":
          description: Invalid telemetry format

  /health:
    get:
      operationId: healthCheck
      summary: Service health check
      tags: [System]
      security: []
      responses:
        "200":
          description: Healthy
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/HealthResponse"

  /weights/versions:
    get:
      operationId: listWeightVersions
      summary: List available weight versions
      tags: [Weights]
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
            default: 10
            maximum: 100
        - name: cursor
          in: query
          schema:
            type: string
      responses:
        "200":
          description: Version list returned
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/VersionListResponse"

components:
  securitySchemes:
    ApiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key

  schemas:
    WeightUploadRequest:
      type: object
      required: [client_id, model_version, weights, metadata]
      properties:
        client_id:
          type: string
          format: uuid
          description: Anonymous client identifier (rotated periodically)
        model_version:
          type: string
          pattern: "^v\\d+\\.\\d+\\.\\d+$"
        weights:
          type: object
          properties:
            format:
              type: string
              enum: [dense, sparse, quantized]
            data:
              type: string
              format: byte
              description: Base64-encoded weight tensor
            shape:
              type: array
              items:
                type: integer
            checksum:
              type: string
              description: SHA-256 of raw weight data
        metadata:
          type: object
          properties:
            sample_count:
              type: integer
              minimum: 1
            training_rounds:
              type: integer
            timestamp:
              type: string
              format: date-time

    UploadAcknowledgment:
      type: object
      properties:
        upload_id:
          type: string
          format: uuid
        status:
          type: string
          enum: [accepted, queued, processing]
        estimated_aggregation:
          type: string
          format: date-time
        current_queue_depth:
          type: integer

    GlobalWeightsResponse:
      type: object
      properties:
        version:
          type: string
        weights:
          type: object
          properties:
            format:
              type: string
            data:
              type: string
              format: byte
            shape:
              type: array
              items:
                type: integer
        metadata:
          type: object
          properties:
            aggregated_at:
              type: string
              format: date-time
            contributor_count:
              type: integer
            total_samples:
              type: integer
            algorithm:
              type: string

    DeltaWeightsResponse:
      type: object
      properties:
        from_version:
          type: string
        to_version:
          type: string
        delta:
          type: object
          properties:
            format:
              type: string
              enum: [bsdiff, xdelta3]
            data:
              type: string
              format: byte
            compression_ratio:
              type: number

    TelemetryReport:
      type: object
      required: [session_hash, events]
      properties:
        session_hash:
          type: string
          description: SHA-256 anonymous session identifier
        events:
          type: array
          items:
            type: object
            properties:
              event_type:
                type: string
                enum: [pattern_match, weight_update, error, feature_use]
              timestamp:
                type: string
                format: date-time
              value:
                type: number
              category:
                type: string

    HealthResponse:
      type: object
      properties:
        status:
          type: string
          enum: [healthy, degraded, unhealthy]
        version:
          type: string
        services:
          type: object
          additionalProperties:
            type: string
            enum: [up, down, degraded]
        uptime_seconds:
          type: integer

    VersionListResponse:
      type: object
      properties:
        versions:
          type: array
          items:
            type: object
            properties:
              version:
                type: string
              created_at:
                type: string
                format: date-time
              contributor_count:
                type: integer
              total_samples:
                type: integer
        next_cursor:
          type: string

    ErrorResponse:
      type: object
      properties:
        error:
          type: string
        code:
          type: string
        details:
          type: object
```

---

## 4. Data Flow Architecture

### Weight Lifecycle Flow

```
Phase 1: INGESTION
========================
  Plugin Instance
       |
       | POST /weights/upload (HTTPS, API Key)
       v
  Cloud Load Balancer + Cloud Armor (DDoS filter)
       |
       v
  Weight Ingestion Service (Cloud Run)
       |
       |-- [1] Validate API key (via IAM / Secret Manager)
       |-- [2] Schema validation (JSON Schema v7)
       |-- [3] Tensor shape check (must match model arch)
       |-- [4] Size check (max 10MB)
       |-- [5] Anomaly detection (z-score > 3 = reject)
       |-- [6] SHA-256 checksum verification
       |
       v
  Cloud Storage (gs://artibot-weights-temp/{upload_id}.bin)
       |
       v
  Cloud Pub/Sub (topic: weight-processing-queue)
       |
       | message: { upload_id, client_id, timestamp, storage_path }
       v
  [Queued for Aggregation]


Phase 2: AGGREGATION
========================
  Trigger: Cloud Scheduler (every 6h) OR Pub/Sub count >= 50
       |
       v
  Aggregation Service (Cloud Run)
       |
       |-- [1] Pull pending uploads from Pub/Sub
       |-- [2] Fetch weight files from Cloud Storage (temp)
       |-- [3] Validate min threshold (>= 5 unique clients)
       |-- [4] Apply secure aggregation (client weights masked)
       |-- [5] Apply differential privacy noise
       |-- [6] Execute FedAvg algorithm
       |-- [7] Generate new global weight version
       |
       v
  Cloud Storage (gs://artibot-weights-global/v{N}.bin)
       |
       |-- [8] Update Firestore version metadata
       |-- [9] Compute and store delta from v{N-1}
       |-- [10] Invalidate CDN cache
       |-- [11] Publish aggregation-complete event
       |-- [12] Delete processed temp files
       |
       v
  [Global Weights Updated]


Phase 3: DISTRIBUTION
========================
  Plugin Instance
       |
       | GET /weights/latest (with ETag)
       v
  Cloud CDN (Edge Cache)
       |
       |-- Cache HIT --> Return cached (< 50ms global)
       |-- Cache MISS:
       |       |
       |       v
       |   Distribution Service (Cloud Run)
       |       |
       |       |-- Fetch metadata from Firestore
       |       |-- Generate signed URL for Cloud Storage
       |       |-- Set Cache-Control headers
       |       |
       |       v
       |   Response (with ETag, version headers)
       |
       v
  Plugin applies global weights locally


Phase 4: TELEMETRY
========================
  Plugin Instance
       |
       | POST /telemetry/report (anonymized)
       v
  Telemetry Service (Cloud Run)
       |
       |-- [1] PII scrub (enforce empty PII fields)
       |-- [2] Schema validation
       |-- [3] Assign anonymous session hash
       |-- [4] BigQuery streaming insert
       |
       v
  BigQuery (dataset: artibot_telemetry)
       |
       v
  Looker Studio Dashboard (analytics)
```

### Event-Driven Architecture (Pub/Sub Topics)

```
Topics:
  weight-processing-queue     -> Ingestion --> Aggregation
  aggregation-complete        -> Aggregation --> CDN Invalidation, Notifications
  telemetry-events            -> Telemetry --> BigQuery (dead letter)
  system-alerts               -> Monitoring --> Cloud Functions (alerts)

Dead Letter Topics:
  weight-processing-dlq       -> Failed weight processing (retry 3x, then DLQ)
  telemetry-events-dlq        -> Failed telemetry inserts
```

---

## 5. Storage Design

### Cloud Storage Buckets

| Bucket | Purpose | Lifecycle | Access |
|--------|---------|-----------|--------|
| `artibot-weights-temp` | Temporary upload storage | Delete after 7 days | Write: Ingestion Service only |
| `artibot-weights-global` | Versioned global weights | Keep last 30 versions | Read: Distribution Service, CDN |
| `artibot-weights-delta` | Pre-computed version diffs | Keep last 10 diffs | Read: Distribution Service |
| `artibot-backups` | Disaster recovery backups | Nearline: 90 days, Coldline: 1 year | Admin only |

**Bucket Configuration**:
```yaml
artibot-weights-global:
  location: US-CENTRAL1 (multi-region: US for CDN)
  storage_class: STANDARD
  versioning: enabled
  lifecycle:
    - condition:
        num_newer_versions: 30
      action:
        type: Delete
    - condition:
        age: 90
        matches_storage_class: [STANDARD]
      action:
        type: SetStorageClass
        storage_class: NEARLINE
  uniform_bucket_level_access: true
  cors:
    - origin: ["*"]
      method: ["GET", "HEAD"]
      responseHeader: ["Content-Type", "ETag"]
      maxAgeSeconds: 3600
```

### Firestore Collections

```
artibot-swarm (database)
|
+-- weights_metadata (collection)
|   +-- {version_id} (document)
|       |- version: string          "v1.2.0"
|       |- created_at: timestamp
|       |- storage_path: string     "gs://artibot-weights-global/v1.2.0.bin"
|       |- contributor_count: int   42
|       |- total_samples: int       125000
|       |- algorithm: string        "fedavg"
|       |- checksum: string         "sha256:abc..."
|       |- file_size_bytes: int
|       |- dp_epsilon: float        1.0
|       |- dp_delta: float          1e-5
|       |- is_latest: boolean
|       |- previous_version: string "v1.1.0"
|
+-- contribution_stats (collection)
|   +-- {anonymous_client_hash} (document)
|       |- total_contributions: int
|       |- last_contribution: timestamp
|       |- accepted_count: int
|       |- rejected_count: int
|       |- quality_score: float     0.0-1.0
|
+-- system_config (collection)
|   +-- aggregation (document)
|       |- min_clients: int         5
|       |- batch_interval_hours: int 6
|       |- batch_threshold: int     50
|       |- current_queue_depth: int
|       |- last_aggregation: timestamp
|   +-- rate_limits (document)
|       |- upload_per_hour: int     1
|       |- download_per_minute: int 10
|       |- telemetry_per_minute: int 5
```

### BigQuery Schema

```sql
-- Dataset: artibot_telemetry

-- Table: events (partitioned by timestamp, clustered by event_type)
CREATE TABLE artibot_telemetry.events (
  event_id        STRING NOT NULL,
  session_hash    STRING NOT NULL,
  event_type      STRING NOT NULL,    -- pattern_match | weight_update | error | feature_use
  category        STRING,
  value           FLOAT64,
  timestamp       TIMESTAMP NOT NULL,
  client_version  STRING,
  platform        STRING,             -- win32 | darwin | linux
  ingested_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(timestamp)
CLUSTER BY event_type, category;

-- Table: aggregation_history
CREATE TABLE artibot_telemetry.aggregation_history (
  version         STRING NOT NULL,
  aggregated_at   TIMESTAMP NOT NULL,
  contributor_count INT64,
  total_samples   INT64,
  convergence_rate FLOAT64,
  dp_epsilon      FLOAT64,
  dp_delta        FLOAT64,
  duration_seconds FLOAT64,
  file_size_bytes INT64
)
PARTITION BY DATE(aggregated_at);

-- Table: system_metrics
CREATE TABLE artibot_telemetry.system_metrics (
  metric_name     STRING NOT NULL,
  metric_value    FLOAT64,
  labels          JSON,
  timestamp       TIMESTAMP NOT NULL
)
PARTITION BY DATE(timestamp)
CLUSTER BY metric_name;

-- Materialized View: daily_summary
CREATE MATERIALIZED VIEW artibot_telemetry.daily_summary AS
SELECT
  DATE(timestamp) as date,
  event_type,
  COUNT(*) as event_count,
  COUNT(DISTINCT session_hash) as unique_sessions,
  AVG(value) as avg_value,
  APPROX_QUANTILES(value, 100)[OFFSET(50)] as median_value,
  APPROX_QUANTILES(value, 100)[OFFSET(95)] as p95_value
FROM artibot_telemetry.events
GROUP BY date, event_type;
```

---

## 6. Security Architecture

### Defense-in-Depth Layers

```
Layer 1: Edge Protection
  +-- Cloud Armor (WAF)
  |   +-- DDoS protection (auto)
  |   +-- IP allowlist/denylist
  |   +-- Geo-restriction (optional)
  |   +-- Rate limiting rules
  |   +-- OWASP Top 10 rule set
  |
Layer 2: Network Security
  +-- VPC Service Controls
  |   +-- Service perimeter around all GCP resources
  |   +-- Restrict data exfiltration
  |   +-- Access levels based on identity
  +-- Private Google Access
  |   +-- Cloud Run to GCS/Firestore via private network
  |
Layer 3: Identity & Access
  +-- Cloud IAM
  |   +-- Service accounts per microservice (least privilege)
  |   +-- Workload Identity for Cloud Run
  |   +-- No user-facing GCP credentials
  +-- API Key Management
  |   +-- Secret Manager for API key storage
  |   +-- Key rotation every 90 days
  |   +-- Per-client API keys (anonymous, rotatable)
  |
Layer 4: Application Security
  +-- Input Validation
  |   +-- JSON Schema v7 strict validation
  |   +-- Tensor shape enforcement
  |   +-- Size limits (10MB upload max)
  +-- Data Privacy
  |   +-- No PII collection or storage
  |   +-- Differential privacy on aggregated weights
  |   +-- Anonymous client identifiers (rotated)
  |   +-- Secure aggregation protocol
  |
Layer 5: Data Protection
  +-- Encryption
  |   +-- At rest: Google-managed keys (default)
  |   +-- In transit: TLS 1.3 (Cloud Run default)
  |   +-- Optional: CMEK for regulated environments
  +-- Access Logging
      +-- Cloud Audit Logs (admin + data access)
      +-- Cloud Storage access logs
```

### IAM Service Account Matrix

| Service Account | Roles | Scope |
|----------------|-------|-------|
| `weight-ingestion-sa` | Storage Object Creator (temp bucket), Pub/Sub Publisher | Ingestion only |
| `aggregation-sa` | Storage Object Admin (all buckets), Pub/Sub Subscriber, Firestore User | Aggregation only |
| `distribution-sa` | Storage Object Viewer (global bucket), Firestore Viewer | Read-only |
| `telemetry-sa` | BigQuery Data Editor, Pub/Sub Subscriber | Telemetry only |
| `health-auth-sa` | Secret Manager Accessor, Firestore Viewer | Auth checks |
| `cloud-build-sa` | Cloud Run Admin, Storage Admin, Artifact Registry Writer | CI/CD only |

### Cloud Armor Security Policy

```yaml
security_policy:
  name: artibot-edge-policy
  rules:
    - priority: 1000
      description: "Block known bad IPs"
      action: deny(403)
      match:
        expr: "evaluateThreatIntelligence('iplist-known-malicious-ips')"

    - priority: 2000
      description: "Rate limit uploads"
      action: throttle
      match:
        expr: "request.path.matches('/api/v1/weights/upload')"
      rate_limit:
        conform_action: allow
        exceed_action: deny(429)
        rate_limit_threshold:
          count: 10
          interval_sec: 3600

    - priority: 3000
      description: "Rate limit downloads"
      action: throttle
      match:
        expr: "request.path.matches('/api/v1/weights/')"
      rate_limit:
        conform_action: allow
        exceed_action: deny(429)
        rate_limit_threshold:
          count: 60
          interval_sec: 60

    - priority: 4000
      description: "OWASP Top 10 protection"
      action: deny(403)
      match:
        expr: "evaluatePreconfiguredWaf('sqli-v33-stable') || evaluatePreconfiguredWaf('xss-v33-stable')"

    - priority: 2147483647
      description: "Default allow"
      action: allow
      match:
        expr: "true"
```

---

## 7. Networking & CDN

### Global Load Balancer Configuration

```
External HTTPS Load Balancer
  |
  +-- Frontend
  |   +-- IP: Static global IPv4
  |   +-- Port: 443 (HTTPS)
  |   +-- SSL: Google-managed certificate
  |   +-- Domain: api.artibot-swarm.run.app
  |
  +-- URL Map (path-based routing)
  |   +-- /api/v1/weights/*     --> weight-services-backend
  |   +-- /api/v1/telemetry/*   --> telemetry-backend
  |   +-- /api/v1/health        --> health-backend
  |   +-- default               --> 404
  |
  +-- Backend Services
  |   +-- weight-services-backend
  |   |   +-- Cloud Run NEG: weight-ingestion (POST)
  |   |   +-- Cloud Run NEG: distribution (GET)
  |   |   +-- Cloud CDN: enabled (GET only)
  |   |   +-- Health check: /api/v1/health (interval: 30s)
  |   |
  |   +-- telemetry-backend
  |   |   +-- Cloud Run NEG: telemetry
  |   |   +-- Cloud CDN: disabled
  |   |
  |   +-- health-backend
  |       +-- Cloud Run NEG: health-auth
  |       +-- Cloud CDN: disabled
  |
  +-- Cloud Armor policy: artibot-edge-policy
```

### CDN Configuration

```yaml
cdn_policy:
  cache_mode: CACHE_ALL_STATIC
  default_ttl: 3600          # 1 hour
  max_ttl: 86400             # 24 hours
  client_ttl: 1800           # 30 minutes
  negative_caching: true
  negative_caching_policy:
    - code: 404
      ttl: 60
  serve_while_stale: 86400   # Serve stale for 24h during origin failure
  cache_key_policy:
    include_host: true
    include_protocol: true
    include_query_string: true
    query_string_whitelist:
      - format
      - version
```

---

## 8. Monitoring & Alerting

### Monitoring Stack

```
Cloud Monitoring
  |
  +-- Dashboards
  |   +-- Service Health Overview
  |   |   +-- Request rate (per service)
  |   |   +-- Error rate (4xx, 5xx)
  |   |   +-- Latency (p50, p95, p99)
  |   |   +-- Instance count
  |   |
  |   +-- Aggregation Pipeline
  |   |   +-- Queue depth
  |   |   +-- Processing time
  |   |   +-- Success/failure rate
  |   |   +-- Weight version history
  |   |
  |   +-- Cost Tracker
  |       +-- Daily spend by service
  |       +-- Projected monthly cost
  |       +-- Budget alerts
  |
  +-- Alerting Policies
  |   +-- [P1 - Critical]
  |   |   +-- Error rate > 5% for 5 minutes
  |   |   +-- All instances down
  |   |   +-- Aggregation failure 2x consecutive
  |   |   +-- Storage bucket inaccessible
  |   |
  |   +-- [P2 - Warning]
  |   |   +-- Latency p95 > 2s for 10 minutes
  |   |   +-- Queue depth > 200
  |   |   +-- Daily cost > 150% of budget
  |   |   +-- Certificate expiring in 14 days
  |   |
  |   +-- [P3 - Info]
  |       +-- New weight version published
  |       +-- Daily aggregation summary
  |       +-- Weekly cost report
  |
  +-- Notification Channels
      +-- Email: ops team
      +-- Slack: #artibot-alerts (via webhook)
      +-- PagerDuty: P1 alerts only
```

### Custom Metrics

```yaml
custom_metrics:
  - name: artibot/weights/upload_count
    type: CUMULATIVE
    labels: [status, client_version]
    description: "Total weight uploads"

  - name: artibot/weights/upload_size_bytes
    type: DISTRIBUTION
    labels: [format]
    description: "Weight upload size distribution"

  - name: artibot/aggregation/duration_seconds
    type: GAUGE
    labels: [algorithm]
    description: "Aggregation processing time"

  - name: artibot/aggregation/contributor_count
    type: GAUGE
    labels: [version]
    description: "Contributors per aggregation round"

  - name: artibot/distribution/cache_hit_ratio
    type: GAUGE
    labels: [endpoint]
    description: "CDN cache hit ratio"

  - name: artibot/anomaly/rejected_uploads
    type: CUMULATIVE
    labels: [reason]
    description: "Rejected uploads by anomaly detection"
```

### Structured Logging

```json
{
  "severity": "INFO",
  "component": "weight-ingestion",
  "trace_id": "projects/{project}/traces/{trace_id}",
  "span_id": "{span_id}",
  "message": "Weight upload processed",
  "labels": {
    "upload_id": "uuid",
    "client_id_hash": "sha256-truncated",
    "weight_format": "dense",
    "size_bytes": 4096000,
    "validation_result": "accepted",
    "processing_ms": 145
  }
}
```

---

## 9. CI/CD Pipeline (Cloud Build)

### Pipeline Architecture

```
GitHub Repository
       |
       | Push / PR trigger
       v
Cloud Build
       |
       +-- [Stage 1: Validate]  (parallel)
       |   +-- Lint (ESLint / Ruff)
       |   +-- Type check (tsc / mypy)
       |   +-- Unit tests
       |   +-- Security scan (trivy)
       |
       +-- [Stage 2: Build]
       |   +-- Docker build (multi-stage)
       |   +-- Push to Artifact Registry
       |   +-- Tag with git SHA + semantic version
       |
       +-- [Stage 3: Deploy to Dev]
       |   +-- Terraform plan (dev)
       |   +-- Cloud Run deploy (dev)
       |   +-- Smoke tests
       |
       +-- [Stage 4: Integration Test]
       |   +-- API integration tests
       |   +-- Load test (k6, 100 concurrent)
       |   +-- Security test (OWASP ZAP)
       |
       +-- [Stage 5: Deploy to Staging]  (manual approval)
       |   +-- Terraform plan (staging)
       |   +-- Cloud Run deploy (staging)
       |   +-- E2E tests
       |
       +-- [Stage 6: Deploy to Prod]  (manual approval)
           +-- Terraform plan (prod)
           +-- Cloud Run deploy (prod, canary 10%)
           +-- Health check (5 minutes)
           +-- Full rollout (100%)
           +-- Post-deploy validation
```

### Cloud Build Configuration

```yaml
# cloudbuild.yaml
steps:
  # Stage 1: Validate (parallel)
  - id: lint
    name: node:20-slim
    entrypoint: npm
    args: ["run", "lint"]
    waitFor: ["-"]

  - id: typecheck
    name: node:20-slim
    entrypoint: npm
    args: ["run", "typecheck"]
    waitFor: ["-"]

  - id: unit-test
    name: node:20-slim
    entrypoint: npm
    args: ["run", "test:unit"]
    waitFor: ["-"]

  - id: security-scan
    name: aquasec/trivy
    args: ["fs", "--severity", "HIGH,CRITICAL", "--exit-code", "1", "."]
    waitFor: ["-"]

  # Stage 2: Build
  - id: build-image
    name: gcr.io/cloud-builders/docker
    args:
      - build
      - -t
      - ${_REGION}-docker.pkg.dev/${PROJECT_ID}/artibot/${_SERVICE}:${SHORT_SHA}
      - -t
      - ${_REGION}-docker.pkg.dev/${PROJECT_ID}/artibot/${_SERVICE}:latest
      - --build-arg=VERSION=${SHORT_SHA}
      - -f
      - services/${_SERVICE}/Dockerfile
      - .
    waitFor: [lint, typecheck, unit-test, security-scan]

  - id: push-image
    name: gcr.io/cloud-builders/docker
    args:
      - push
      - --all-tags
      - ${_REGION}-docker.pkg.dev/${PROJECT_ID}/artibot/${_SERVICE}

  # Stage 3: Deploy to Dev
  - id: deploy-dev
    name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      - run
      - deploy
      - ${_SERVICE}
      - --image=${_REGION}-docker.pkg.dev/${PROJECT_ID}/artibot/${_SERVICE}:${SHORT_SHA}
      - --region=${_REGION}
      - --platform=managed
      - --no-traffic
      - --tag=canary
    waitFor: [push-image]

substitutions:
  _SERVICE: weight-ingestion
  _REGION: us-central1

options:
  logging: CLOUD_LOGGING_ONLY
  machineType: E2_HIGHCPU_8
```

---

## 10. Terraform / IaC Structure

### Directory Layout

```
infra/
├── terraform/
│   ├── main.tf                    # Root module, backend config
│   ├── variables.tf               # Global variables
│   ├── outputs.tf                 # Root outputs
│   ├── versions.tf                # Provider version constraints
│   ├── backend.tf                 # GCS remote state backend
│   │
│   ├── modules/
│   │   ├── cloud-run/
│   │   │   ├── main.tf            # Cloud Run service definition
│   │   │   ├── variables.tf       # Service name, image, scaling config
│   │   │   ├── outputs.tf         # Service URL, revision
│   │   │   └── iam.tf             # Service account, IAM bindings
│   │   │
│   │   ├── storage/
│   │   │   ├── main.tf            # GCS buckets, Firestore, BigQuery
│   │   │   ├── variables.tf       # Bucket names, retention policies
│   │   │   ├── outputs.tf         # Bucket URLs, dataset IDs
│   │   │   └── lifecycle.tf       # Object lifecycle rules
│   │   │
│   │   ├── networking/
│   │   │   ├── main.tf            # VPC, Load Balancer, Cloud Armor
│   │   │   ├── variables.tf       # CIDR ranges, domain config
│   │   │   ├── outputs.tf         # LB IP, VPC ID
│   │   │   ├── cdn.tf             # Cloud CDN configuration
│   │   │   ├── ssl.tf             # Managed SSL certificates
│   │   │   └── armor.tf           # Cloud Armor WAF rules
│   │   │
│   │   ├── pubsub/
│   │   │   ├── main.tf            # Topics, subscriptions, DLQ
│   │   │   ├── variables.tf       # Topic names, retention
│   │   │   └── outputs.tf         # Topic/subscription IDs
│   │   │
│   │   ├── monitoring/
│   │   │   ├── main.tf            # Dashboards, alert policies
│   │   │   ├── variables.tf       # Thresholds, notification channels
│   │   │   ├── outputs.tf         # Dashboard URLs
│   │   │   ├── alerts.tf          # Alert policy definitions
│   │   │   └── uptime.tf          # Uptime check configurations
│   │   │
│   │   ├── security/
│   │   │   ├── main.tf            # IAM, Secret Manager, VPC SC
│   │   │   ├── variables.tf       # Service account names, secrets
│   │   │   ├── outputs.tf         # SA emails, secret versions
│   │   │   └── vpc-sc.tf          # VPC Service Controls perimeter
│   │   │
│   │   └── ci-cd/
│   │       ├── main.tf            # Cloud Build triggers, Artifact Registry
│   │       ├── variables.tf       # Repo config, build settings
│   │       └── outputs.tf         # Build trigger IDs
│   │
│   └── environments/
│       ├── dev/
│       │   ├── main.tf            # Dev environment composition
│       │   ├── terraform.tfvars   # Dev-specific values
│       │   └── backend.tf         # Dev state bucket
│       │
│       ├── staging/
│       │   ├── main.tf            # Staging environment composition
│       │   ├── terraform.tfvars   # Staging-specific values
│       │   └── backend.tf         # Staging state bucket
│       │
│       └── prod/
│           ├── main.tf            # Prod environment composition
│           ├── terraform.tfvars   # Prod-specific values
│           └── backend.tf         # Prod state bucket
│
├── scripts/
│   ├── init-project.sh            # GCP project setup
│   ├── create-state-bucket.sh     # Terraform state bucket
│   └── rotate-keys.sh            # API key rotation script
│
└── docs/
    ├── runbook.md                 # Operational runbook
    └── disaster-recovery.md       # DR procedures
```

### Module Composition Example

```hcl
# environments/prod/main.tf

module "networking" {
  source = "../../modules/networking"

  project_id   = var.project_id
  region       = var.region
  domain       = "api.artibot-swarm.run.app"
  enable_cdn   = true
  enable_armor = true
}

module "security" {
  source = "../../modules/security"

  project_id = var.project_id
  services   = ["weight-ingestion", "aggregation", "distribution", "telemetry", "health-auth"]
}

module "storage" {
  source = "../../modules/storage"

  project_id             = var.project_id
  region                 = var.region
  global_weight_versions = 30
  temp_retention_days    = 7
  backup_retention_days  = 365
}

module "pubsub" {
  source = "../../modules/pubsub"

  project_id            = var.project_id
  weight_queue_retention = "7d"
  max_delivery_attempts = 3
}

module "weight_ingestion" {
  source = "../../modules/cloud-run"

  project_id      = var.project_id
  region          = var.region
  service_name    = "weight-ingestion"
  image           = "${var.region}-docker.pkg.dev/${var.project_id}/artibot/weight-ingestion:${var.image_tag}"
  min_instances   = 0
  max_instances   = 10
  cpu             = "1000m"
  memory          = "512Mi"
  concurrency     = 80
  timeout         = "300s"
  service_account = module.security.service_accounts["weight-ingestion"]

  env_vars = {
    TEMP_BUCKET       = module.storage.temp_bucket_name
    PUBSUB_TOPIC      = module.pubsub.weight_queue_topic
    ANOMALY_THRESHOLD = "3.0"
  }
}

module "aggregation" {
  source = "../../modules/cloud-run"

  project_id      = var.project_id
  region          = var.region
  service_name    = "aggregation"
  image           = "${var.region}-docker.pkg.dev/${var.project_id}/artibot/aggregation:${var.image_tag}"
  min_instances   = 0
  max_instances   = 3
  cpu             = "2000m"
  memory          = "2Gi"
  concurrency     = 1
  timeout         = "900s"
  service_account = module.security.service_accounts["aggregation"]

  env_vars = {
    TEMP_BUCKET        = module.storage.temp_bucket_name
    GLOBAL_BUCKET      = module.storage.global_bucket_name
    FIRESTORE_DB       = module.storage.firestore_database
    MIN_CLIENTS        = "5"
    DP_EPSILON         = "1.0"
    DP_DELTA           = "1e-5"
  }
}

module "monitoring" {
  source = "../../modules/monitoring"

  project_id           = var.project_id
  notification_email   = var.ops_email
  slack_webhook        = var.slack_webhook_url
  error_rate_threshold = 0.05
  latency_threshold_ms = 2000
}
```

---

## 11. Cost Estimation

### Monthly Cost by User Scale

All estimates assume Cloud Run serverless pricing (us-central1), standard storage, and Firestore Native mode.

#### Assumptions

| Parameter | Value |
|-----------|-------|
| Avg weight upload size | 5 MB |
| Uploads per user per day | 1 |
| Weight downloads per user per day | 4 |
| Telemetry reports per user per day | 10 |
| Aggregation frequency | 4x per day |
| CDN cache hit ratio | 80% |
| Avg Cloud Run request duration | 200ms |

#### Cost Breakdown

| Component | 100 Users | 1,000 Users | 10,000 Users | 100,000 Users |
|-----------|-----------|-------------|--------------|---------------|
| **Cloud Run** | | | | |
| - Weight Ingestion | $0.50 | $5.00 | $50.00 | $500.00 |
| - Aggregation | $2.00 | $5.00 | $15.00 | $50.00 |
| - Distribution | $0.30 | $2.00 | $15.00 | $100.00 |
| - Telemetry | $0.20 | $2.00 | $20.00 | $200.00 |
| **Cloud Storage** | | | | |
| - Temp uploads | $0.10 | $1.00 | $10.00 | $100.00 |
| - Global weights | $0.05 | $0.05 | $0.05 | $0.05 |
| - Egress (CDN miss) | $0.50 | $5.00 | $30.00 | $200.00 |
| **Firestore** | | | | |
| - Reads | Free | $0.50 | $5.00 | $50.00 |
| - Writes | Free | $0.20 | $2.00 | $20.00 |
| **Pub/Sub** | Free | $0.50 | $5.00 | $50.00 |
| **BigQuery** | | | | |
| - Streaming inserts | Free | $1.00 | $10.00 | $100.00 |
| - Queries (on-demand) | Free | $0.50 | $5.00 | $20.00 |
| **Cloud CDN** | $0.10 | $1.00 | $8.00 | $60.00 |
| **Cloud Armor** | $5.00 | $5.00 | $5.00 | $5.00 |
| **Load Balancer** | $18.00 | $18.00 | $18.00 | $25.00 |
| **Secret Manager** | Free | Free | Free | $0.50 |
| **Monitoring** | Free | Free | $5.00 | $20.00 |
| **SSL Certificate** | Free | Free | Free | Free |
| | | | | |
| **Monthly Total** | **~$27** | **~$47** | **~$203** | **~$1,501** |
| **Per User / Month** | **$0.27** | **$0.047** | **$0.020** | **$0.015** |

#### Free Tier Coverage (100 Users)

| Service | Free Tier | Usage (100 users) | Covered? |
|---------|-----------|-------------------|----------|
| Cloud Run | 2M requests, 360K vCPU-sec | ~12K requests | Yes |
| Firestore | 50K reads, 20K writes/day | ~4K reads/day | Yes |
| Cloud Storage | 5GB | ~500MB | Yes |
| Pub/Sub | 10GB/month | ~15MB | Yes |
| BigQuery | 1TB queries, 10GB streaming | ~3GB streaming | Yes |

### Cost Optimization Strategies

| Scale | Strategy | Savings |
|-------|----------|---------|
| 100 | Maximize free tier; single region; no CDN | -50% |
| 1,000 | Enable CDN; batch telemetry writes | -20% |
| 10,000 | Committed Use Discounts; BigQuery flat-rate | -30% |
| 100,000 | Preemptible VMs for aggregation; multi-region CDN; reserved capacity | -40% |

---

## 12. Environment Configuration

### Environment Differences

| Aspect | Dev | Staging | Prod |
|--------|-----|---------|------|
| **Cloud Run min instances** | 0 | 0 | 1 (distribution, health) |
| **Cloud Run max instances** | 2 | 5 | 20 |
| **Cloud Armor** | Disabled | Basic rules | Full WAF |
| **Cloud CDN** | Disabled | Enabled | Enabled + custom cache |
| **VPC Service Controls** | Disabled | Dry-run mode | Enforced |
| **Monitoring alerts** | Email only | Email + Slack | Email + Slack + PagerDuty |
| **Firestore** | Emulator (local) | Native mode | Native mode + backups |
| **BigQuery** | On-demand | On-demand | Flat-rate (if >10K users) |
| **SSL Certificate** | Self-signed | Google-managed | Google-managed |
| **Domain** | api-dev.*.run.app | api-staging.*.run.app | api.artibot-swarm.run.app |
| **Log retention** | 7 days | 30 days | 90 days |
| **Backup schedule** | None | Daily | Daily + cross-region |
| **Aggregation batch** | 3 clients min | 3 clients min | 5 clients min |
| **DP Epsilon** | 10.0 (relaxed) | 2.0 | 1.0 (strict) |
| **Rate limits** | 100/min | 30/min | 10/hour (upload) |

### Environment Variables (per service)

```yaml
# Common (all environments)
common:
  PROJECT_ID: "${project_id}"
  REGION: "us-central1"
  LOG_LEVEL: "info"
  SERVICE_VERSION: "${image_tag}"

# Dev overrides
dev:
  LOG_LEVEL: "debug"
  FIRESTORE_EMULATOR_HOST: "localhost:8080"
  ENABLE_CORS_ALL: "true"
  DP_EPSILON: "10.0"
  MIN_CLIENTS_PER_ROUND: "3"

# Staging overrides
staging:
  LOG_LEVEL: "info"
  ENABLE_CORS_ALL: "false"
  DP_EPSILON: "2.0"
  MIN_CLIENTS_PER_ROUND: "3"

# Prod overrides
prod:
  LOG_LEVEL: "warn"
  ENABLE_CORS_ALL: "false"
  DP_EPSILON: "1.0"
  MIN_CLIENTS_PER_ROUND: "5"
  ENABLE_TRACING: "true"
  SENTRY_DSN: "${sentry_dsn}"
```

---

## 13. Disaster Recovery & SLA

### Recovery Objectives

| Metric | Target | Strategy |
|--------|--------|----------|
| **RPO** (Recovery Point Objective) | 1 hour | Firestore continuous backup, GCS versioning |
| **RTO** (Recovery Time Objective) | 30 minutes | Multi-region failover, Terraform re-deploy |
| **SLA** (Service Level Agreement) | 99.9% uptime | Cloud Run multi-region, health checks |

### Failure Scenarios & Recovery

| Scenario | Impact | Recovery |
|----------|--------|----------|
| Cloud Run service crash | Auto-restart (seconds) | Cloud Run auto-healing |
| Single region outage | Distribution degraded | Cloud CDN serves stale; manual failover |
| Storage bucket corruption | Data loss risk | GCS versioning + cross-region backup restore |
| Firestore unavailable | Metadata inaccessible | Retry with backoff; serve cached weights |
| Pub/Sub failure | Queue disruption | Dead letter queue; manual replay |
| Aggregation timeout | Delayed global update | Cloud Scheduler retries; manual trigger |
| DDoS attack | Service degradation | Cloud Armor auto-mitigation |
| API key compromise | Unauthorized access | Immediate rotation via Secret Manager |

### Backup Schedule

```yaml
backups:
  firestore:
    schedule: "0 2 * * *"     # Daily at 2 AM UTC
    retention: 30              # 30 days
    location: "us"
    export_to: "gs://artibot-backups/firestore/"

  cloud_storage:
    strategy: "versioning"     # Object versioning enabled
    cross_region_copy:
      schedule: "0 4 * * *"   # Daily at 4 AM UTC
      destination: "us-east1"
      retention: 90            # 90 days

  bigquery:
    schedule: "0 3 * * 0"     # Weekly on Sunday at 3 AM UTC
    retention: 90              # 90 days
    export_to: "gs://artibot-backups/bigquery/"
```

### Health Check Endpoints

```yaml
health_checks:
  - name: weight-ingestion-health
    path: /api/v1/health
    interval: 30s
    timeout: 10s
    healthy_threshold: 2
    unhealthy_threshold: 3

  - name: distribution-health
    path: /api/v1/health
    interval: 15s
    timeout: 5s
    healthy_threshold: 2
    unhealthy_threshold: 2

  - name: aggregation-health
    path: /api/v1/health
    interval: 60s
    timeout: 10s
    healthy_threshold: 2
    unhealthy_threshold: 5
```

---

## Appendix: Technology Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Compute | Cloud Run (gen2) | Serverless microservices |
| Messaging | Cloud Pub/Sub | Event-driven decoupling |
| Scheduling | Cloud Scheduler | Periodic aggregation triggers |
| Object Storage | Cloud Storage | Weight files (temp + global) |
| Document DB | Firestore (Native) | Metadata, config, stats |
| Analytics | BigQuery | Telemetry analysis, dashboards |
| CDN | Cloud CDN | Global weight distribution |
| Load Balancer | External HTTPS LB | Traffic routing, SSL termination |
| WAF | Cloud Armor | DDoS, rate limiting, OWASP |
| Secrets | Secret Manager | API keys, credentials |
| IAM | Cloud IAM + Workload Identity | Service-to-service auth |
| Network | VPC Service Controls | Data exfiltration prevention |
| CI/CD | Cloud Build | Automated deployment pipeline |
| Container Registry | Artifact Registry | Docker image storage |
| IaC | Terraform | Infrastructure provisioning |
| Monitoring | Cloud Monitoring + Logging | Observability |
| Dashboards | Looker Studio | Business analytics |
