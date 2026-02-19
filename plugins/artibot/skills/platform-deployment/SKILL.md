---
name: platform-deployment
description: "Deployment patterns for modern applications including cloud platforms, containers, and CI/CD pipelines."
level: 2
triggers: ["deploy", "deployment", "Vercel", "Railway", "Docker", "Kubernetes", "CI/CD", "blue-green", "zero-downtime"]
agents: ["persona-devops", "persona-backend"]
tokens: "~4K"
category: "platform"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Deployment Patterns

## When This Skill Applies
- Setting up deployment pipelines for new projects
- Configuring cloud platform deployments (Vercel, Railway, Fly.io)
- Containerizing applications with Docker
- Orchestrating containers with Kubernetes
- Implementing CI/CD workflows (GitHub Actions, GitLab CI)
- Designing zero-downtime deployment strategies

## Core Guidance

### 1. Platform Selection

| Platform | Best For | Deploy Model | Scaling |
|----------|----------|-------------|---------|
| Vercel | Next.js, frontends, edge | Git push / CLI | Auto (serverless) |
| Railway | Full-stack, databases, workers | Git push / CLI | Auto + manual |
| Fly.io | Global edge, containers | CLI (`fly deploy`) | Auto + regional |
| AWS ECS/Fargate | Enterprise containers | CI/CD pipeline | Auto + rules |
| Google Cloud Run | Stateless containers | CI/CD / CLI | Auto (request-based) |
| Kubernetes | Complex orchestration | Manifests / Helm | HPA, VPA, custom |

### 2. Docker Best Practices

**Multi-Stage Build Pattern**:
```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine AS runtime
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER appuser
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

**Container Security Rules**:
- Use specific version tags, never `latest`
- Run as non-root user
- Use `.dockerignore` to exclude secrets, node_modules, .git
- Scan images for vulnerabilities (`trivy`, `snyk container`)
- Keep base images minimal (alpine, distroless)
- No secrets in image layers (use build args or runtime env)

### 3. Deployment Strategies

| Strategy | Downtime | Rollback Speed | Risk | Use When |
|----------|----------|---------------|------|----------|
| Rolling update | None | Moderate | Low | Default for most apps |
| Blue-green | None | Instant | Low | Critical services |
| Canary | None | Fast | Very low | High-traffic, risky changes |
| Recreate | Brief | Fast | Moderate | Dev/staging, breaking changes |
| Feature flags | None | Instant | Very low | Gradual rollout, A/B testing |

**Blue-Green Deployment**:
```
Load Balancer
     |
     +-- Blue (current v1.0) <-- traffic
     |
     +-- Green (new v1.1) <-- deploy, test, verify

Switch: Route traffic Blue -> Green
Rollback: Route traffic Green -> Blue (instant)
```

**Canary Deployment**:
```
Load Balancer (weight-based routing)
     |
     +-- Stable (95% traffic) -- v1.0
     |
     +-- Canary (5% traffic)  -- v1.1

Monitor metrics -> increase canary % -> promote or rollback
```

### 4. CI/CD Pipeline Design

**Standard Pipeline Stages**:
```
Trigger (push/PR)
  -> Lint & Format Check
  -> Type Check
  -> Unit Tests
  -> Build
  -> Integration Tests
  -> Security Scan (SAST, dependency audit)
  -> Container Build (if applicable)
  -> Deploy to Staging
  -> E2E Tests (against staging)
  -> Deploy to Production
  -> Smoke Tests
  -> Notify
```

**GitHub Actions Best Practices**:
- Use specific action versions (`@v4`, not `@main`)
- Cache dependencies (`actions/cache`, `setup-node` with cache)
- Run independent jobs in parallel
- Use environments with protection rules for production
- Store secrets in GitHub Secrets, never in workflow files
- Use OIDC for cloud provider auth (no long-lived credentials)

### 5. Kubernetes Essentials

**Resource Configuration**:
```yaml
resources:
  requests:
    cpu: "100m"       # Guaranteed minimum
    memory: "128Mi"
  limits:
    cpu: "500m"       # Maximum allowed
    memory: "512Mi"
```

**Health Checks**:
```yaml
livenessProbe:        # Restart if unhealthy
  httpGet:
    path: /healthz
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 15

readinessProbe:       # Remove from LB if not ready
  httpGet:
    path: /readyz
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

**Key Patterns**:
- Use `Deployment` for stateless, `StatefulSet` for stateful workloads
- Configure HPA (Horizontal Pod Autoscaler) for auto-scaling
- Use `PodDisruptionBudget` for availability during updates
- Store config in `ConfigMap`, secrets in `Secret` (or external vault)
- Use namespaces for environment separation

### 6. Zero-Downtime Checklist

- [ ] Health check endpoints implemented (`/healthz`, `/readyz`)
- [ ] Graceful shutdown handles in-flight requests (SIGTERM handler)
- [ ] Database migrations are backward-compatible
- [ ] Rolling update strategy configured with proper surge/unavailable settings
- [ ] Connection draining configured on load balancer
- [ ] Rollback procedure documented and tested
- [ ] Smoke tests run automatically after deployment
- [ ] Monitoring and alerting active for deployment metrics

### 7. Environment Management

| Environment | Purpose | Deploy Trigger | Data |
|------------|---------|----------------|------|
| Development | Local dev, experiments | Manual | Seed/mock |
| Preview | PR review, feature testing | PR open/update | Seed/clone |
| Staging | Pre-production validation | Merge to main | Sanitized prod |
| Production | Live traffic | Manual approval or tag | Real |

**Environment Variables**:
- Use platform-native secrets management (Vercel env, Railway variables, K8s secrets)
- Validate all required env vars at startup (fail fast)
- Never share secrets between environments
- Rotate secrets on a schedule (90 days minimum)

## Anti-Patterns

- Deploying directly from local machines to production
- Missing health checks or graceful shutdown handlers
- Running database migrations that break backward compatibility
- Using `latest` tag for container images
- Storing secrets in container images or git history
- No rollback strategy or untested rollback procedures
- Skipping staging environment for "small changes"

## Quick Reference

**Deployment Decision**:
```
Static site / frontend? -> Vercel, Cloudflare Pages
Full-stack + DB? -> Railway, Fly.io, Cloud Run
Complex microservices? -> Kubernetes, ECS
```

**Pipeline Minimum**:
```
lint -> typecheck -> test -> build -> deploy-staging -> e2e -> deploy-prod
```
