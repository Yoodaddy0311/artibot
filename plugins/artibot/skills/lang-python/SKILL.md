---
name: lang-python
description: "Python patterns, type hints, async/await, dataclasses, and framework-specific best practices for FastAPI and Django."
level: 2
triggers:
  - "python"
  - "Python"
  - ".py"
  - "type hints"
  - "dataclass"
  - "asyncio"
  - "pydantic"
  - "FastAPI"
  - "Django"
  - "pytest"
  - "poetry"
  - "uv"
  - "venv"
agents:
  - "persona-backend"
  - "persona-qa"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Python Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Python code
- Setting up Python environments (venv/poetry/uv)
- Using type hints and dataclasses
- FastAPI or Django development
- Async code with asyncio
- Writing pytest tests

## Core Guidance

### Type Hints
```python
from typing import Optional, Union, TypeVar, Generic
from collections.abc import Sequence, Callable, AsyncGenerator

# Always annotate function signatures
def process_users(
    users: list[dict[str, str]],
    filter_fn: Callable[[dict], bool],
) -> list[str]:
    return [u['name'] for u in users if filter_fn(u)]

# Union types (Python 3.10+)
def find_user(user_id: int) -> dict | None:
    ...

# TypeVar for generic functions
T = TypeVar('T')
def first(items: Sequence[T]) -> T | None:
    return items[0] if items else None
```

### Dataclasses
```python
from dataclasses import dataclass, field
from datetime import datetime

@dataclass(frozen=True)  # immutable
class UserId:
    value: str

@dataclass
class User:
    id: UserId
    name: str
    email: str
    created_at: datetime = field(default_factory=datetime.now)
    tags: list[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.email or '@' not in self.email:
            raise ValueError(f'Invalid email: {self.email}')
```

### Asyncio Patterns
```python
import asyncio
from contextlib import asynccontextmanager

# Async context manager
@asynccontextmanager
async def db_connection():
    conn = await create_connection()
    try:
        yield conn
    finally:
        await conn.close()

# Concurrent tasks
async def fetch_all(urls: list[str]) -> list[bytes]:
    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(fetch(url)) for url in urls]
    return [t.result() for t in tasks]

# Async generator
async def stream_records() -> AsyncGenerator[dict, None]:
    async with db_connection() as conn:
        async for row in conn.execute('SELECT * FROM records'):
            yield dict(row)
```

### Context Manager
```python
from contextlib import contextmanager

@contextmanager
def timer(label: str):
    import time
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        print(f'{label}: {elapsed:.3f}s')

with timer('heavy computation'):
    result = compute()
```

### Environment Management

**uv (recommended - fast)**:
```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create project
uv init myproject && cd myproject
uv add fastapi uvicorn pydantic
uv add --dev pytest ruff mypy

# Run
uv run python main.py
uv run pytest
```

**Poetry**:
```bash
poetry new myproject
poetry add fastapi uvicorn
poetry add --group dev pytest ruff
poetry run pytest
```

**pyproject.toml**:
```toml
[project]
name = "myproject"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["fastapi>=0.115", "pydantic>=2.0"]

[tool.ruff]
line-length = 88
select = ["E", "F", "I", "N", "UP"]

[tool.mypy]
strict = true
```

### FastAPI Patterns
```python
from fastapi import FastAPI, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from contextlib import asynccontextmanager

# Lifespan (startup/shutdown)
@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    yield
    await db.disconnect()

app = FastAPI(lifespan=lifespan)

# Pydantic v2 models
class UserCreate(BaseModel):
    name: str
    email: EmailStr
    model_config = {"str_strip_whitespace": True}

class UserResponse(BaseModel):
    id: int
    name: str
    email: str

# Dependency injection
async def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    user = await verify_token(token)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return user

@app.post('/users', response_model=UserResponse, status_code=201)
async def create_user(
    data: UserCreate,
    current_user: User = Depends(get_current_user),
) -> UserResponse:
    user = await user_service.create(data)
    return UserResponse.model_validate(user)
```

### Django Patterns
```python
# models.py - Use model managers
from django.db import models
from django.utils import timezone

class ActiveManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(is_active=True)

class User(models.Model):
    name = models.CharField(max_length=255)
    email = models.EmailField(unique=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = models.Manager()
    active = ActiveManager()

    class Meta:
        indexes = [models.Index(fields=['email'])]

# Select related to prevent N+1
users = User.active.select_related('profile').prefetch_related('orders')
```

### Testing: pytest + Fixtures
```python
import pytest
from httpx import AsyncClient, ASGITransport

# Fixture with scope
@pytest.fixture(scope='session')
def db():
    # Setup
    engine = create_engine('sqlite:///:memory:')
    Base.metadata.create_all(engine)
    yield engine
    Base.metadata.drop_all(engine)

# Parametrize
@pytest.mark.parametrize('email,valid', [
    ('user@example.com', True),
    ('notanemail', False),
    ('', False),
])
def test_email_validation(email: str, valid: bool):
    if valid:
        assert validate_email(email) == email
    else:
        with pytest.raises(ValueError):
            validate_email(email)

# Async test
@pytest.mark.asyncio
async def test_create_user(db):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url='http://test'
    ) as client:
        response = await client.post('/users', json={'name': 'Alice', 'email': 'alice@example.com'})
    assert response.status_code == 201
    assert response.json()['name'] == 'Alice'
```

## Quick Reference

| Pattern | When to Use |
|---------|------------|
| `@dataclass(frozen=True)` | Value objects, immutable config |
| `TypedDict` | Dict shapes (not validation) |
| `Protocol` | Structural subtyping (duck typing with types) |
| `asyncio.TaskGroup` | Concurrent tasks with error propagation |
| `contextlib.suppress` | Ignore expected exceptions cleanly |
| `functools.cache` | Memoize pure functions |
| `__slots__` | Memory-efficient classes |

**Anti-Patterns**:
- Mutable default arguments (`def f(items=[])`)
- Bare `except:` clauses
- `import *`
- String formatting with `%` (use f-strings)
- Blocking I/O in async functions
