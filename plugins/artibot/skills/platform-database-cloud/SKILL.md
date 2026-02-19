---
name: platform-database-cloud
description: "Cloud database patterns for serverless PostgreSQL, real-time databases, and edge-compatible data access."
level: 2
triggers: ["Neon", "Supabase", "Firebase", "Firestore", "PlanetScale", "serverless database", "connection pooling", "edge functions", "real-time"]
agents: ["persona-backend", "persona-architect"]
tokens: "~4K"
category: "platform"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Cloud Database Patterns

## When This Skill Applies
- Selecting a cloud database for new projects
- Configuring serverless database connections and connection pooling
- Implementing real-time subscriptions and live queries
- Optimizing database access from edge functions and serverless environments
- Migrating from traditional databases to cloud-native alternatives
- Designing multi-region or global database architectures

## Core Guidance

### 1. Cloud Database Selection

| Service | Type | Best For | Edge Support | Real-time |
|---------|------|----------|-------------|-----------|
| Neon | Serverless PostgreSQL | Full PostgreSQL, branching, auto-suspend | Yes (HTTP driver) | No (use triggers) |
| Supabase | PostgreSQL + BaaS | Full-stack, auth + storage + real-time | Yes (edge functions) | Yes (Realtime) |
| Firebase Firestore | Document DB | Mobile-first, offline sync, rapid prototyping | Limited | Yes (native) |
| PlanetScale | Serverless MySQL | MySQL-compatible, schema branching, vitess-based | Yes (HTTP) | No |
| Turso | SQLite (libSQL) | Edge-native, embedded, low-latency reads | Yes (native) | No |
| CockroachDB | Distributed SQL | Multi-region, strong consistency, PostgreSQL wire protocol | Yes | No |

### 2. Neon Serverless PostgreSQL

**Key Features**: Auto-suspend (scale-to-zero), database branching, serverless driver

**Connection Patterns**:
```
Standard (long-lived servers):
  postgresql://user:pass@ep-xxx.region.neon.tech/dbname?sslmode=require

Serverless / Edge (HTTP):
  import { neon } from '@neondatabase/serverless'
  const sql = neon(process.env.DATABASE_URL)
  const result = await sql`SELECT * FROM users WHERE id = ${userId}`

Connection Pooling:
  Use ?pgbouncer=true endpoint for pooled connections
  Recommended for serverless functions with high concurrency
```

**Branching Strategy**:
- `main` branch for production
- Create branch per PR for preview environments (instant, copy-on-write)
- Use branching for safe migration testing
- Auto-delete branches when PR closes

### 3. Supabase

**Key Features**: PostgreSQL + Auth + Storage + Realtime + Edge Functions

**Connection Patterns**:
```
Client SDK (browser/mobile):
  import { createClient } from '@supabase/supabase-js'
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

Server-side (direct connection):
  Use connection pooler URL for serverless
  Use direct connection for long-lived servers

Edge Functions (Deno):
  import { createClient } from '@supabase/supabase-js'
  // Use service_role key for admin operations
```

**Real-time Subscriptions**:
```
supabase
  .channel('table-changes')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' },
    (payload) => handleChange(payload)
  )
  .subscribe()
```

**Row-Level Security (RLS)**:
- Always enable RLS on public-facing tables
- Use `auth.uid()` in policies for user-scoped access
- Create separate policies for SELECT, INSERT, UPDATE, DELETE
- Test policies with different user contexts

### 4. Firebase Firestore

**Key Features**: Document model, offline sync, real-time listeners, global CDN

**Data Modeling**:
```
Collection/Document pattern:
  users/{userId}
  users/{userId}/posts/{postId}
  users/{userId}/posts/{postId}/comments/{commentId}

Design Rules:
  - Denormalize for read performance
  - Keep documents under 1MB
  - Limit subcollection nesting to 3 levels
  - Use collection groups for cross-parent queries
```

**Real-time Listeners**:
```
onSnapshot(collection(db, 'messages'),
  { where: ['roomId', '==', activeRoom] },
  (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      // change.type: 'added' | 'modified' | 'removed'
    })
  }
)
```

**Cost Optimization**:
- Use `getDoc` for one-time reads, `onSnapshot` only when real-time needed
- Limit query results with `limit()` and pagination cursors
- Use composite indexes for complex queries
- Cache aggressively on client side

### 5. Connection Pooling

**Why It Matters**: Serverless functions create/destroy connections per invocation. Without pooling, this exhausts database connection limits.

| Solution | Type | Best For |
|----------|------|----------|
| PgBouncer | External pooler | Traditional PostgreSQL, Neon, Supabase |
| Prisma Accelerate | ORM-level proxy | Prisma users, edge deployments |
| Neon serverless driver | HTTP-based | Edge functions, serverless (no TCP) |
| Supabase connection pooler | Built-in Supavisor | Supabase projects |

**Configuration Best Practices**:
- Set pool size based on expected concurrency (not max connections)
- Use transaction pooling mode for serverless (not session pooling)
- Configure connection timeout (5-10s) and idle timeout (30-60s)
- Monitor active connections and pool utilization
- Use HTTP/WebSocket drivers for edge functions (no TCP support)

### 6. Edge Function Database Access

**Challenge**: Edge runtimes (Vercel Edge, Cloudflare Workers) lack TCP support.

**Solutions**:
```
HTTP-based drivers (recommended for edge):
  - @neondatabase/serverless (Neon HTTP driver)
  - @planetscale/database (PlanetScale HTTP driver)
  - Supabase JS client (REST API)
  - Turso client (libSQL over HTTP)

ORM with edge support:
  - Drizzle ORM (supports all HTTP drivers)
  - Prisma with Accelerate proxy
  - Kysely with HTTP dialects
```

**Latency Optimization**:
- Deploy edge functions in regions close to your database
- Use read replicas for geo-distributed reads
- Cache frequently accessed data at the edge (KV stores)
- Batch queries to reduce round trips
- Use prepared statements for repeated queries

### 7. Migration Strategies

| Approach | Downtime | Safety | Use When |
|----------|----------|--------|----------|
| Expand-contract | None | High | Adding columns, creating tables |
| Shadow migration | None | Very high | Complex schema changes |
| Blue-green DB | Brief | High | Major restructuring |
| Dual-write | None | Moderate | Service migration |

**Migration Rules**:
- Always make migrations backward-compatible
- Add columns as nullable first, backfill, then add constraints
- Never rename or drop columns in the same deployment as code changes
- Test migrations against production-size datasets
- Use database branching (Neon, PlanetScale) for safe testing

### 8. Monitoring & Observability

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| Connection count | >70% max | >90% max | Scale pool, optimize queries |
| Query latency (p95) | >200ms | >1s | Add indexes, optimize queries |
| Error rate | >0.1% | >1% | Investigate connection issues |
| Replication lag | >1s | >10s | Check network, scale replicas |
| Storage usage | >70% | >90% | Archive data, scale storage |

## Anti-Patterns

- Opening new database connections per serverless invocation without pooling
- Using session pooling mode in serverless environments (use transaction mode)
- Storing large blobs in the database instead of object storage
- Missing RLS/security rules on public-facing database tables
- Running unindexed queries on large tables
- Ignoring connection limits and pool exhaustion warnings
- Deeply nested Firestore subcollections (>3 levels)

## Quick Reference

**Database Selection**:
```
Full PostgreSQL + branching? -> Neon
PostgreSQL + Auth + Realtime + Storage? -> Supabase
Document DB + offline sync + mobile? -> Firestore
MySQL + schema branching? -> PlanetScale
Edge-native SQLite? -> Turso
```

**Edge Access Pattern**:
```
Edge function -> HTTP driver (no TCP) -> Connection pooler -> Database
```

**Connection String Checklist**:
```
- [ ] SSL/TLS enabled (sslmode=require)
- [ ] Connection pooling configured
- [ ] Timeouts set (connect: 5s, query: 30s, idle: 60s)
- [ ] Credentials in environment variables
- [ ] Read replica URL for read-heavy workloads
```
