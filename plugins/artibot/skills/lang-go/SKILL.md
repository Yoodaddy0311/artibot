---
name: lang-go
description: "Go patterns, interfaces, error handling, goroutines, channels, and framework-specific best practices for Echo, Fiber, and Gin."
level: 2
triggers:
  - "go"
  - "golang"
  - "Go"
  - ".go"
  - "goroutine"
  - "channel"
  - "interface"
  - "error handling"
  - "go modules"
  - "Echo"
  - "Fiber"
  - "Gin"
  - "table-driven test"
agents:
  - "persona-backend"
  - "persona-performance"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Go Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Go code
- Designing interfaces and struct composition
- Implementing error handling patterns
- Using goroutines and channels
- Echo, Fiber, or Gin development
- Writing table-driven tests

## Core Guidance

### Interfaces
```go
// Small, focused interfaces (Go philosophy)
type Reader interface {
    Read(p []byte) (n int, err error)
}

// Accept interfaces, return structs
type UserRepository interface {
    FindByID(ctx context.Context, id string) (*User, error)
    Save(ctx context.Context, user *User) error
}

// Embed interfaces for composition
type ReadWriter interface {
    Reader
    Writer
}

// Implicit implementation - no 'implements' keyword
type FileReader struct { f *os.File }
func (r *FileReader) Read(p []byte) (int, error) { return r.f.Read(p) }
```

### Error Handling
```go
// Custom error types with context
type NotFoundError struct {
    Resource string
    ID       string
}

func (e *NotFoundError) Error() string {
    return fmt.Sprintf("%s with ID %q not found", e.Resource, e.ID)
}

// Wrapping errors (Go 1.13+)
func GetUser(ctx context.Context, id string) (*User, error) {
    user, err := db.FindByID(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("GetUser %s: %w", id, err)
    }
    return user, nil
}

// Checking error types
var notFound *NotFoundError
if errors.As(err, &notFound) {
    // handle not found
}

// Sentinel errors
var ErrNotFound = errors.New("not found")
if errors.Is(err, ErrNotFound) {
    // handle
}
```

### Goroutines & Channels
```go
// WaitGroup for fan-out
func processAll(items []Item) []Result {
    results := make([]Result, len(items))
    var wg sync.WaitGroup
    for i, item := range items {
        wg.Add(1)
        go func(idx int, it Item) {
            defer wg.Done()
            results[idx] = process(it)
        }(i, item)
    }
    wg.Wait()
    return results
}

// errgroup for concurrent error handling
func fetchAll(ctx context.Context, urls []string) ([][]byte, error) {
    g, ctx := errgroup.WithContext(ctx)
    results := make([][]byte, len(urls))
    for i, url := range urls {
        i, url := i, url // capture
        g.Go(func() error {
            data, err := fetch(ctx, url)
            if err != nil {
                return fmt.Errorf("fetch %s: %w", url, err)
            }
            results[i] = data
            return nil
        })
    }
    return results, g.Wait()
}

// Context-aware channel pattern
func worker(ctx context.Context, jobs <-chan Job) <-chan Result {
    out := make(chan Result)
    go func() {
        defer close(out)
        for job := range jobs {
            select {
            case <-ctx.Done():
                return
            case out <- process(job):
            }
        }
    }()
    return out
}
```

### Module System
```bash
# Initialize module
go mod init github.com/user/project

# Add dependency
go get github.com/labstack/echo/v4@latest

# Tidy (remove unused, add missing)
go mod tidy

# Workspace mode (multi-module development)
go work init ./module-a ./module-b
go work sync
```

### Framework Patterns

#### Echo
```go
import "github.com/labstack/echo/v4"
import "github.com/labstack/echo/v4/middleware"

func main() {
    e := echo.New()
    e.Use(middleware.Logger(), middleware.Recover(), middleware.CORS())

    // Route groups
    api := e.Group("/api/v1")
    api.Use(authMiddleware)
    api.GET("/users/:id", getUser)
    api.POST("/users", createUser)

    e.Logger.Fatal(e.Start(":8080"))
}

func getUser(c echo.Context) error {
    id := c.Param("id")
    user, err := userService.FindByID(c.Request().Context(), id)
    if err != nil {
        var notFound *NotFoundError
        if errors.As(err, &notFound) {
            return echo.ErrNotFound
        }
        return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
    }
    return c.JSON(http.StatusOK, user)
}
```

#### Fiber
```go
import "github.com/gofiber/fiber/v2"

app := fiber.New(fiber.Config{
    ErrorHandler: func(c *fiber.Ctx, err error) error {
        code := fiber.StatusInternalServerError
        var e *fiber.Error
        if errors.As(err, &e) {
            code = e.Code
        }
        return c.Status(code).JSON(fiber.Map{"error": err.Error()})
    },
})

app.Get("/users/:id", func(c *fiber.Ctx) error {
    id := c.Params("id")
    user, err := userService.FindByID(c.Context(), id)
    if err != nil {
        return fiber.NewError(fiber.StatusNotFound, "user not found")
    }
    return c.JSON(user)
})
```

#### Gin
```go
import "github.com/gin-gonic/gin"

router := gin.New()
router.Use(gin.Logger(), gin.Recovery())

v1 := router.Group("/api/v1")
v1.Use(authMiddleware())

v1.GET("/users/:id", func(c *gin.Context) {
    id := c.Param("id")
    user, err := userService.FindByID(c.Request.Context(), id)
    if err != nil {
        c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
        return
    }
    c.JSON(http.StatusOK, user)
})
```

### Testing: Table-Driven Tests + testify
```go
import (
    "testing"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
)

func TestValidateEmail(t *testing.T) {
    tests := []struct {
        name    string
        email   string
        wantErr bool
    }{
        {"valid", "user@example.com", false},
        {"no at", "userexample.com", true},
        {"empty", "", true},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            err := validateEmail(tt.email)
            if tt.wantErr {
                require.Error(t, err)
            } else {
                assert.NoError(t, err)
            }
        })
    }
}

// Benchmark
func BenchmarkProcess(b *testing.B) {
    for b.N > 0; b.N-- {
        process(testInput)
    }
}
```

## Quick Reference

| Pattern | When to Use |
|---------|------------|
| `sync.Once` | Lazy initialization, singleton |
| `sync.Map` | Concurrent-safe map |
| `context.WithTimeout` | Deadline for operations |
| `defer` | Cleanup (close, unlock, recover) |
| `io.Reader/Writer` | Stream processing |
| `http.Handler` interface | HTTP middleware chain |
| `option func` pattern | Flexible config |

**Anti-Patterns**:
- Goroutine leaks (always use context or done channel)
- Ignoring errors with `_`
- Shared mutable state without synchronization
- Global variables
- `panic` for expected errors
