---
name: lang-typescript
description: "TypeScript patterns, strict configuration, utility types, and framework-specific best practices for Next.js, Astro, and Remix."
level: 2
triggers:
  - "typescript"
  - "TypeScript"
  - ".ts"
  - ".tsx"
  - "strict mode"
  - "utility types"
  - "discriminated union"
  - "branded types"
  - "tsconfig"
  - "type safety"
  - "generics"
  - "interface"
  - "type alias"
agents:
  - "persona-backend"
  - "persona-frontend"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# TypeScript Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing TypeScript code
- Configuring tsconfig.json
- Using utility types or generics
- Implementing discriminated unions or branded types
- Next.js, Astro, or Remix development
- Type-safe API layer design

## Core Guidance

### Strict Mode Configuration
```json
// tsconfig.json - minimal strict baseline
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

### Utility Types - Key Patterns
```typescript
// Partial for optional updates
function updateUser(id: string, updates: Partial<User>): Promise<User>

// Pick/Omit for shape derivation
type UserPreview = Pick<User, 'id' | 'name' | 'avatar'>
type CreateInput = Omit<User, 'id' | 'createdAt' | 'updatedAt'>

// Record for key-value maps
type PermissionMap = Record<UserRole, Permission[]>

// ReturnType for inferring function output
type ApiResponse = ReturnType<typeof fetchUser>

// Awaited for unwrapping Promise types
type UserData = Awaited<ReturnType<typeof fetchUser>>
```

### Discriminated Unions
```typescript
// Always use discriminated unions for state
type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error }

// Exhaustive check pattern
function render<T>(state: LoadState<T>): string {
  switch (state.status) {
    case 'idle': return ''
    case 'loading': return 'Loading...'
    case 'success': return JSON.stringify(state.data)
    case 'error': return state.error.message
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}
```

### Branded Types (Nominal Typing)
```typescript
// Prevent mixing incompatible IDs
type UserId = string & { readonly __brand: 'UserId' }
type PostId = string & { readonly __brand: 'PostId' }

function createUserId(raw: string): UserId {
  return raw as UserId
}

// Now this won't compile:
// const postId: PostId = createUserId('123')
```

### Path Aliases (tsconfig.json)
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@components/*": ["src/components/*"],
      "@lib/*": ["src/lib/*"],
      "@types/*": ["src/types/*"]
    }
  }
}
```

### Framework Patterns

#### Next.js (App Router)
```typescript
// Server Component - no 'use client', async allowed
export default async function Page({ params }: { params: { id: string } }) {
  const data = await fetchData(params.id)
  return <Component data={data} />
}

// Client Component
'use client'
export function InteractiveWidget({ initialValue }: { initialValue: number }) {
  const [value, setValue] = useState(initialValue)
  return <button onClick={() => setValue(v => v + 1)}>{value}</button>
}

// Route Handler
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  return Response.json({ data: searchParams.get('query') })
}
```

#### Astro
```typescript
// Astro component type-safe props
interface Props {
  title: string
  description?: string
  tags: string[]
}
const { title, description = '', tags } = Astro.props

// Content Collections schema
import { defineCollection, z } from 'astro:content'
const blog = defineCollection({
  schema: z.object({
    title: z.string(),
    pubDate: z.date(),
    tags: z.array(z.string()),
  })
})
```

#### Remix
```typescript
// Loader with typed return
import type { LoaderFunctionArgs } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'

export async function loader({ params }: LoaderFunctionArgs) {
  const user = await getUserById(params.id!)
  if (!user) throw new Response('Not Found', { status: 404 })
  return { user }
}

export default function UserPage() {
  const { user } = useLoaderData<typeof loader>()
  return <div>{user.name}</div>
}
```

### Testing: Vitest + Type Testing
```typescript
import { describe, it, expect, vi } from 'vitest'
import type { Equal, Expect } from '@type-challenges/utils'

// Type test
type test = Expect<Equal<ReturnType<typeof createUserId>, UserId>>

// Unit test
describe('createUserId', () => {
  it('creates a branded UserId', () => {
    const id = createUserId('abc-123')
    expect(id).toBe('abc-123')
  })
})

// Mock with proper types
const mockFetch = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
```

## Quick Reference

| Pattern | When to Use |
|---------|------------|
| Discriminated unions | State machines, result types, API responses |
| Branded types | Preventing ID/unit mixups |
| `satisfies` operator | Validate shape without widening type |
| `const` assertions | Freeze literal types in objects/arrays |
| Template literal types | URL patterns, CSS values, event names |
| Conditional types | Type-level computation, filtering |
| `infer` keyword | Extracting types from complex structures |

**Anti-Patterns**:
- `any` - use `unknown` and narrow
- Type casting with `as` without validation
- `!` non-null assertion without guard
- Overly wide `object` or `{}` types
- Forgetting `readonly` for immutable data
