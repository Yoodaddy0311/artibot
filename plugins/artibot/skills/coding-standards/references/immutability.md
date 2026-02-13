# Immutability Patterns

## Core Rule
NEVER mutate. ALWAYS create new objects.

## Object Updates
```typescript
// WRONG: Mutation
function updateUser(user: User, name: string) {
  user.name = name  // MUTATION
  return user
}

// CORRECT: Spread
function updateUser(user: User, name: string): User {
  return { ...user, name }
}

// CORRECT: Nested update
function updateAddress(user: User, city: string): User {
  return {
    ...user,
    address: { ...user.address, city }
  }
}
```

## Array Operations
```typescript
// WRONG
items.push(newItem)
items.splice(index, 1)
items[0] = updated

// CORRECT
const added = [...items, newItem]
const removed = items.filter((_, i) => i !== index)
const updated = items.map((item, i) => i === 0 ? newValue : item)
```

## Map/Set Operations
```typescript
// CORRECT: New Map
const updated = new Map(existing)
updated.set(key, value)

// CORRECT: New Set
const updated = new Set([...existing, newItem])
```

## State Management
```typescript
// React state: always return new reference
setState(prev => ({ ...prev, count: prev.count + 1 }))

// Reducer pattern
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'UPDATE':
      return { ...state, ...action.payload }
    default:
      return state  // Return same reference if no change
  }
}
```

## Utility Libraries
- `structuredClone()` for deep cloning (native)
- `Object.freeze()` for development-time enforcement
- Immer for complex nested updates (`produce()`)
