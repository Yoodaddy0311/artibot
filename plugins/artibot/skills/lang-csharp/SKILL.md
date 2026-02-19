---
name: lang-csharp
description: "C# patterns, pattern matching, primary constructors, and framework-specific best practices for .NET 8, ASP.NET Core, and Blazor."
level: 2
triggers:
  - "csharp"
  - "C#"
  - ".cs"
  - ".csproj"
  - "dotnet"
  - ".NET"
  - "asp.net"
  - "blazor"
  - "entity framework"
  - "LINQ"
  - "minimal api"
  - "pattern matching"
  - "nuget"
agents:
  - "backend-developer"
  - "frontend-developer"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# C# Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing C# 12/.NET 8 code
- ASP.NET Core Minimal API or MVC development
- Entity Framework Core data access patterns
- Blazor interactive web UI development
- Pattern matching and algebraic data modeling
- xUnit or NUnit testing with Moq/NSubstitute

## Core Guidance

### C# 12 Modern Features
```csharp
// Primary constructors (C# 12)
public class UserService(IUserRepository repo, ILogger<UserService> logger)
{
    public async Task<User?> GetUserAsync(string id)
    {
        logger.LogInformation("Fetching user {Id}", id);
        return await repo.FindByIdAsync(id);
    }
}

// Collection expressions (C# 12)
int[] numbers = [1, 2, 3, 4, 5];
List<string> names = ["Alice", "Bob", "Charlie"];
ReadOnlySpan<byte> data = [0x01, 0x02, 0x03];

// Records for immutable data
public record User(string Id, string Name, Email Email, Role Role = Role.Viewer);
public record CreateUserRequest(string Name, string Email);

// Required members
public class Config
{
    public required string ConnectionString { get; init; }
    public required int MaxRetries { get; init; }
    public TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(30);
}
```

### Pattern Matching
```csharp
// Exhaustive pattern matching with switch expressions
public decimal CalculateDiscount(User user) => user.Role switch
{
    Role.Admin => 0.20m,
    Role.Premium when user.YearsActive > 5 => 0.15m,
    Role.Premium => 0.10m,
    Role.Standard => 0.05m,
    _ => 0m,
};

// List patterns (C# 11+)
public string Describe(int[] values) => values switch
{
    [] => "empty",
    [var single] => $"single: {single}",
    [var first, .., var last] => $"from {first} to {last}",
};

// Property patterns for validation
public static bool IsValid(User user) => user is
{
    Name.Length: > 0 and < 256,
    Email.Value: not null,
    Role: Role.Admin or Role.Premium or Role.Standard,
};

// Result type using discriminated unions
public abstract record Result<T>
{
    public record Success(T Value) : Result<T>;
    public record Failure(string Error, string Code = "INTERNAL") : Result<T>;

    public TOut Match<TOut>(Func<T, TOut> onSuccess, Func<string, TOut> onFailure) =>
        this switch
        {
            Success s => onSuccess(s.Value),
            Failure f => onFailure(f.Error),
            _ => throw new InvalidOperationException()
        };
}
```

### Error Handling
```csharp
// Problem Details for API errors (RFC 9457)
public class AppException : Exception
{
    public string Code { get; }
    public int StatusCode { get; }

    public AppException(string message, string code, int statusCode = 500)
        : base(message)
    {
        Code = code;
        StatusCode = statusCode;
    }
}

// Global exception handler in Minimal API
app.UseExceptionHandler(error => error.Run(async context =>
{
    var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
    var (status, code, message) = exception switch
    {
        AppException app => (app.StatusCode, app.Code, app.Message),
        _ => (500, "INTERNAL_ERROR", "An unexpected error occurred")
    };

    context.Response.StatusCode = status;
    await context.Response.WriteAsJsonAsync(new { code, message });
}));
```

### Testing with xUnit
```csharp
public class UserServiceTests
{
    private readonly Mock<IUserRepository> _repo = new();
    private readonly Mock<ILogger<UserService>> _logger = new();
    private readonly UserService _service;

    public UserServiceTests()
    {
        _service = new UserService(_repo.Object, _logger.Object);
    }

    [Fact]
    public async Task GetUser_ReturnsUser_WhenFound()
    {
        var expected = new User("1", "Alice", new Email("alice@test.com"));
        _repo.Setup(r => r.FindByIdAsync("1"))
             .ReturnsAsync(expected);

        var result = await _service.GetUserAsync("1");

        Assert.NotNull(result);
        Assert.Equal("Alice", result.Name);
        _repo.Verify(r => r.FindByIdAsync("1"), Times.Once);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(null)]
    public async Task GetUser_ThrowsValidation_WhenIdInvalid(string? id)
    {
        await Assert.ThrowsAsync<ValidationException>(
            () => _service.GetUserAsync(id!));
    }
}
```

### ASP.NET Core Minimal API
```csharp
var builder = WebApplication.CreateBuilder(args);

// Service registration
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default")));
builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddScoped<UserService>();

var app = builder.Build();

// Typed route groups
var users = app.MapGroup("/api/users")
    .WithTags("Users")
    .RequireAuthorization();

users.MapGet("/", async (UserService service) =>
    Results.Ok(await service.GetAllAsync()));

users.MapGet("/{id}", async (string id, UserService service) =>
    await service.GetUserAsync(id) is { } user
        ? Results.Ok(user)
        : Results.NotFound());

users.MapPost("/", async (CreateUserRequest req, UserService service) =>
{
    var user = await service.CreateAsync(req);
    return Results.Created($"/api/users/{user.Id}", user);
}).WithValidation<CreateUserRequest>();
```

### Entity Framework Core
```csharp
public class AppDbContext(DbContextOptions<AppDbContext> options)
    : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Post> Posts => Set<Post>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<User>(entity =>
        {
            entity.HasIndex(e => e.Email).IsUnique();
            entity.Property(e => e.Role)
                  .HasConversion<string>();
        });
    }
}

// Repository with specification pattern
public class UserRepository(AppDbContext db) : IUserRepository
{
    public async Task<User?> FindByIdAsync(string id) =>
        await db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.Id == id);

    public async Task<List<User>> FindBySpecAsync(ISpecification<User> spec) =>
        await spec.Apply(db.Users.AsNoTracking()).ToListAsync();
}
```

## Anti-Patterns
- `async void` methods (except event handlers) -- use `async Task`
- Blocking async code with `.Result` or `.Wait()`
- `catch (Exception)` without logging or rethrowing
- String concatenation in hot paths instead of `StringBuilder` or interpolation
- Not using `CancellationToken` in async methods
- Entity Framework lazy loading without explicit configuration

## Framework Integration
- **ASP.NET Core Minimal API**: Lightweight HTTP with typed route groups, validation, and OpenAPI
- **Entity Framework Core**: Code-first ORM with migrations, compiled queries, and specification pattern
- **Blazor**: Interactive web UI with server-side or WASM rendering and component model
