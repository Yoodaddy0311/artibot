# Artibot Swarm Server - Deployment Guide

## Prerequisites

- GCP project with Cloud Run and Container Registry enabled
- `gcloud` CLI authenticated (`gcloud auth login`)
- Docker installed (local testing only)

## Local Development

```bash
cd plugins/artibot/server
node --watch index.js
# Server runs at http://localhost:8080
# Persistence writes to ./data/
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Listen port (Cloud Run sets this) |
| `DATA_DIR` | `./data` | Persistence directory for JSON files |
| `FEDAVG_WINDOW` | `50` | Snapshots kept for FedAvg merge |
| `RATE_LIMIT` | `60` | Max requests/min per IP |
| `MAX_UPLOAD_BYTES` | `5242880` | Max upload size (5MB) |
| `ARTIBOT_SERVER_TOKEN` | *(none)* | Bearer token for auth (localhost-only if unset) |
| `CORS_ALLOWED_ORIGINS` | *(none)* | Comma-separated allowed origins |

## Deploy to Cloud Run

### Option A: Cloud Build (recommended)

```bash
cd plugins/artibot/server
gcloud builds submit --config cloudbuild.yaml .
```

### Option B: Direct deploy

```bash
gcloud run deploy artibot-swarm \
  --source . \
  --region asia-northeast3 \
  --allow-unauthenticated \
  --memory 256Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 1 \
  --timeout 60 \
  --set-env-vars "DATA_DIR=/app/data,FEDAVG_WINDOW=50"
```

## Persistence

- Data files: `weights.json`, `client-stats.json`, `telemetry.json`, `global-weights.json`
- Writes are debounced (2s) to reduce I/O
- Graceful shutdown flushes all pending saves
- Cloud Run: data persists within instance lifetime; lost on cold start unless volume mounted

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/weights` | Upload client weights |
| `GET` | `/api/v1/weights/latest` | Download global weights |
| `POST` | `/api/v1/telemetry` | Report anonymous telemetry |
| `GET` | `/api/v1/health` | Health check |
| `GET` | `/api/v1/stats/:clientId` | Contribution statistics |

## Testing

```bash
# Health check
curl http://localhost:8080/api/v1/health

# Upload weights
curl -X POST http://localhost:8080/api/v1/weights \
  -H "Content-Type: application/json" \
  -d '{"weights":{"tools":{"t1":{"score":0.8,"sampleSize":10}}},"metadata":{"clientId":"test"}}'

# Download latest
curl http://localhost:8080/api/v1/weights/latest
```
