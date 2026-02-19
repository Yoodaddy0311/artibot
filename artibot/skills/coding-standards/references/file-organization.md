# File Organization

> Many small files with high cohesion. Organize by feature, not by type.

## File Size Guidelines

| Category | Ideal | Maximum | Action if Exceeded |
|----------|-------|---------|-------------------|
| Component | 100-200 lines | 400 lines | Extract sub-components |
| Utility | 50-100 lines | 200 lines | Split by domain |
| Service | 100-200 lines | 400 lines | Split by responsibility |
| Test file | 100-300 lines | 500 lines | Split by test group |
| Any file | 200-400 lines | 800 lines | Mandatory refactor |

## Project Structure (Next.js)

```
src/
├── app/                    # Next.js App Router
│   ├── api/               # API routes
│   │   └── users/
│   │       └── route.ts   # GET, POST handlers
│   ├── (auth)/            # Route groups
│   │   ├── login/
│   │   └── register/
│   └── dashboard/
│       ├── page.tsx       # Page component
│       └── layout.tsx     # Layout component
│
├── components/            # Shared React components
│   ├── ui/               # Generic UI (Button, Input, Modal)
│   ├── forms/            # Form components
│   └── layouts/          # Layout components
│
├── features/             # Feature modules (preferred)
│   └── users/
│       ├── components/   # Feature-specific components
│       ├── hooks/        # Feature-specific hooks
│       ├── services/     # Feature-specific services
│       ├── types.ts      # Feature types
│       └── index.ts      # Public API
│
├── hooks/                # Shared custom hooks
├── lib/                  # Utilities and configs
│   ├── api/             # API clients
│   ├── utils/           # Helper functions
│   └── constants.ts     # App-wide constants
│
├── types/               # Global TypeScript types
└── styles/              # Global styles
```

## Feature-Based Organization (Preferred)

Group related files by feature rather than by type:

```
// GOOD: Feature-based
features/
└── checkout/
    ├── components/
    │   ├── CartSummary.tsx
    │   └── PaymentForm.tsx
    ├── hooks/
    │   └── useCheckout.ts
    ├── services/
    │   └── checkoutService.ts
    ├── types.ts
    └── index.ts

// AVOID: Type-based (for large projects)
components/
├── CartSummary.tsx
├── PaymentForm.tsx
├── UserProfile.tsx      # Unrelated to checkout
hooks/
├── useCheckout.ts
├── useProfile.ts        # Unrelated to checkout
```

## Naming Conventions

| File Type | Convention | Example |
|-----------|-----------|---------|
| React component | PascalCase.tsx | `UserProfile.tsx` |
| Custom hook | camelCase.ts | `useAuth.ts` |
| Utility | camelCase.ts | `formatDate.ts` |
| Type definition | camelCase.types.ts | `user.types.ts` |
| Constant | camelCase.ts | `constants.ts` |
| API route | route.ts | `app/api/users/route.ts` |
| Test | *.test.ts(x) | `UserProfile.test.tsx` |
| Style | *.module.css | `UserProfile.module.css` |

## Import Order

```typescript
// 1. External libraries
import { useState, useEffect } from 'react'
import { z } from 'zod'

// 2. Internal modules (absolute paths)
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/useAuth'

// 3. Relative imports (same feature)
import { UserAvatar } from './UserAvatar'
import type { UserProps } from './types'

// 4. Styles
import styles from './UserProfile.module.css'
```

## Barrel Exports (index.ts)

Use index.ts for clean public APIs:

```typescript
// features/users/index.ts
export { UserProfile } from './components/UserProfile'
export { useUser } from './hooks/useUser'
export type { User, UserRole } from './types'
```

## When to Split Files

| Signal | Action |
|--------|--------|
| File > 400 lines | Extract sub-modules |
| Multiple unrelated exports | Split by domain |
| Scrolling to find functions | Split by responsibility |
| Circular imports | Restructure module boundaries |
| Test file > 500 lines | Split by test category |
