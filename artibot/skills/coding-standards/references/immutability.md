# Immutability Patterns

> CRITICAL: Always create new objects. Never mutate existing data.

## Why Immutability

- **Predictability**: Data doesn't change unexpectedly
- **Debugging**: State changes are traceable
- **Concurrency**: No race conditions on shared data
- **React**: Enables efficient re-render detection

## Object Patterns

```typescript
// UPDATE: Spread operator
const updated = { ...user, name: 'New Name' }

// NESTED UPDATE: Spread at each level
const updated = {
  ...state,
  user: {
    ...state.user,
    address: {
      ...state.user.address,
      city: 'New City'
    }
  }
}

// REMOVE KEY: Destructure + rest
const { password, ...userWithoutPassword } = user

// MERGE: Spread multiple
const merged = { ...defaults, ...userConfig, ...overrides }
```

## Array Patterns

```typescript
// ADD: Spread + new item
const added = [...items, newItem]
const prepended = [newItem, ...items]

// REMOVE: Filter
const removed = items.filter(item => item.id !== targetId)

// UPDATE: Map
const updated = items.map(item =>
  item.id === targetId ? { ...item, name: 'Updated' } : item
)

// SORT: Spread + sort (Array.sort mutates!)
const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name))

// UNIQUE: Set + spread
const unique = [...new Set(items)]
```

## Map/Set Patterns

```typescript
// ADD to Map
const newMap = new Map(existingMap)
newMap.set(key, value)

// REMOVE from Map
const newMap = new Map(existingMap)
newMap.delete(key)

// ADD to Set
const newSet = new Set(existingSet)
newSet.add(value)
```

## React State Patterns

```typescript
// CORRECT: Functional update
setCount(prev => prev + 1)
setItems(prev => [...prev, newItem])
setUser(prev => ({ ...prev, name: 'New' }))

// WRONG: Direct mutation
state.count++
state.items.push(newItem)
state.user.name = 'New'
```

## Common Mutation Traps

| Mutating Method | Immutable Alternative |
|----------------|----------------------|
| `array.push(x)` | `[...array, x]` |
| `array.pop()` | `array.slice(0, -1)` |
| `array.shift()` | `array.slice(1)` |
| `array.unshift(x)` | `[x, ...array]` |
| `array.splice(i, 1)` | `array.filter((_, idx) => idx !== i)` |
| `array.sort()` | `[...array].sort()` |
| `array.reverse()` | `[...array].reverse()` |
| `obj.key = value` | `{ ...obj, key: value }` |
| `delete obj.key` | `const { key, ...rest } = obj` |

## When Mutation is Acceptable

- **Local scope only**: Variables created and consumed in same function
- **Performance-critical loops**: Document with comment explaining why
- **Builder patterns**: Where the API is designed for chaining

```typescript
// ACCEPTABLE: Local mutation in builder
function buildQuery(filters: Filter[]) {
  // Deliberately using mutation for performance in tight loop
  const params: string[] = []
  for (const filter of filters) {
    params.push(`${filter.key}=${filter.value}`)
  }
  return params.join('&')
}
```
