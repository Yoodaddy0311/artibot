---
name: lang-javascript
description: "JavaScript patterns, ES2024+ features, async/await, and framework-specific best practices for Node.js 22, Bun, and Deno 2."
level: 2
triggers:
  - "javascript"
  - "JavaScript"
  - ".js"
  - ".mjs"
  - ".cjs"
  - "node.js"
  - "bun"
  - "deno"
  - "ESM"
  - "vitest"
  - "express"
  - "async/await"
  - "ES2024"
agents:
  - "persona-backend"
  - "persona-frontend"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# JavaScript Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing JavaScript code (ES2024+)
- Node.js 22, Bun, or Deno 2 server-side development
- Configuring ESM modules and package.json
- Async/await patterns and error handling
- Vitest or Node test runner usage
- Express, Fastify, or Hono API development

## Core Guidance

### ESM Module Configuration
```json
// package.json - modern ESM setup
{
  "type": "module",
  "engines": { "node": ">=22" },
  "exports": {
    ".": {
      "import": "./src/index.js",
      "types": "./src/index.d.ts"
    }
  }
}
```

### ES2024+ Features
```javascript
// Array grouping
const grouped = Object.groupBy(users, (user) => user.role)

// Promise.withResolvers
const { promise, resolve, reject } = Promise.withResolvers()

// Well-formed Unicode strings
const safe = str.toWellFormed()

// Temporal API (stage 3, available in polyfill)
const now = Temporal.Now.plainDateTimeISO()

// Pipeline operator (stage 2, Bun/Deno support)
const result = value |> double |> increment |> format

// Structured clone for deep copy
const copy = structuredClone(original)

// using declarations for resource management
{
  using file = openFile('data.txt')
  // file auto-disposed at block exit
}
```

### Async Patterns
```javascript
// Parallel execution with error isolation
const results = await Promise.allSettled([
  fetchUsers(),
  fetchPosts(),
  fetchComments(),
])

const [users, posts, comments] = results.map((r) =>
  r.status === 'fulfilled' ? r.value : []
)

// AsyncIterator for streaming
async function* streamLines(url) {
  const response = await fetch(url)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) yield line
  }
  if (buffer) yield buffer
}

// AbortController for cancellation
const controller = new AbortController()
setTimeout(() => controller.abort(), 5000)
const data = await fetch(url, { signal: controller.signal })
```

### Error Handling
```javascript
// Custom error hierarchy
class AppError extends Error {
  constructor(message, { code, cause, status = 500 } = {}) {
    super(message, { cause })
    this.code = code
    this.status = status
    this.name = this.constructor.name
  }
}

class ValidationError extends AppError {
  constructor(message, { fields, cause } = {}) {
    super(message, { code: 'VALIDATION_ERROR', cause, status: 400 })
    this.fields = fields
  }
}

// Safe JSON parse
function safeParse(raw) {
  try {
    return { ok: true, data: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, error }
  }
}
```

### Testing with Vitest
```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('UserService', () => {
  const mockRepo = { findById: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns user when found', async () => {
    mockRepo.findById.mockResolvedValueOnce({ id: '1', name: 'Alice' })
    const service = new UserService(mockRepo)
    const user = await service.getUser('1')
    expect(user).toEqual({ id: '1', name: 'Alice' })
    expect(mockRepo.findById).toHaveBeenCalledWith('1')
  })

  it('throws NotFoundError when missing', async () => {
    mockRepo.findById.mockResolvedValueOnce(null)
    const service = new UserService(mockRepo)
    await expect(service.getUser('999')).rejects.toThrow('Not found')
  })
})
```

### Runtime-Specific Patterns

#### Node.js 22
```javascript
// Built-in test runner
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Built-in watch mode: node --watch app.js

// Native .env support
// node --env-file=.env app.js

// Permission model
// node --experimental-permission --allow-fs-read=./data app.js
```

#### Bun
```javascript
// Bun-native server (fastest JS HTTP server)
Bun.serve({
  port: 3000,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' })
    }
    return new Response('Not Found', { status: 404 })
  },
})

// Bun SQLite (built-in, synchronous)
import { Database } from 'bun:sqlite'
const db = new Database('app.db')
```

#### Deno 2
```javascript
// deno.json - unified config
// { "imports": { "@std/": "jsr:@std/" } }

import { serveDir } from '@std/http/file-server'

Deno.serve((req) => serveDir(req, { fsRoot: './public' }))
```

## Anti-Patterns
- Using `var` instead of `const`/`let`
- Callback hell instead of async/await
- `==` instead of `===` for comparisons
- Mutating function parameters instead of returning new objects
- `for...in` on arrays instead of `for...of` or array methods
- Ignoring unhandled promise rejections
- Using `eval()` or `Function()` constructor

## Framework Integration
- **Express/Fastify/Hono**: Middleware-based HTTP with validation (Zod) and structured error handling
- **Vitest**: Modern test runner with ESM-first, watch mode, and coverage
- **Bun/Deno**: Runtime-native APIs for file I/O, HTTP, SQLite, and testing
