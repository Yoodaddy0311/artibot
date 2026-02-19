---
name: lang-php
description: "PHP patterns, typed properties, enums, fibers, and framework-specific best practices for Laravel 11 and Symfony 7."
level: 2
triggers:
  - "php"
  - "PHP"
  - ".php"
  - "laravel"
  - "symfony"
  - "eloquent"
  - "composer"
  - "artisan"
  - "blade"
  - "doctrine"
  - "pest"
  - "phpstan"
agents:
  - "backend-developer"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# PHP Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing PHP 8.3+ code
- Laravel 11 or Symfony 7 application development
- Eloquent ORM or Doctrine usage
- Composer package management and autoloading
- PHPStan/Psalm static analysis configuration
- Pest or PHPUnit testing

## Core Guidance

### Modern PHP 8.3+ Features
```php
// Typed class properties with constructor promotion
readonly class User
{
    public function __construct(
        public string $id,
        public string $name,
        public Email $email,
        public Role $role = Role::Viewer,
        public \DateTimeImmutable $createdAt = new \DateTimeImmutable(),
    ) {}
}

// Enums with methods
enum Role: string
{
    case Admin = 'admin';
    case Editor = 'editor';
    case Viewer = 'viewer';

    public function canEdit(): bool
    {
        return match ($this) {
            self::Admin, self::Editor => true,
            self::Viewer => false,
        };
    }
}

// Typed constants (PHP 8.3)
class Config
{
    const string APP_NAME = 'Artibot';
    const int MAX_RETRIES = 3;
}

// #[Override] attribute (PHP 8.3)
class AdminUser extends User
{
    #[\Override]
    public function permissions(): array
    {
        return ['*'];
    }
}

// json_validate() (PHP 8.3)
if (json_validate($input)) {
    $data = json_decode($input, true);
}

// First-class callables
$names = array_map(strlen(...), $strings);
```

### Error Handling
```php
// Custom exception hierarchy
class AppException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly string $code = 'INTERNAL_ERROR',
        public readonly int $statusCode = 500,
        ?\Throwable $previous = null,
    ) {
        parent::__construct($message, 0, $previous);
    }
}

class ValidationException extends AppException
{
    public function __construct(
        public readonly array $errors,
        ?\Throwable $previous = null,
    ) {
        parent::__construct('Validation failed', 'VALIDATION_ERROR', 422, $previous);
    }
}

// Result pattern (no exceptions for expected cases)
readonly class Result
{
    private function __construct(
        public bool $ok,
        public mixed $value = null,
        public ?string $error = null,
    ) {}

    public static function success(mixed $value): self
    {
        return new self(ok: true, value: $value);
    }

    public static function failure(string $error): self
    {
        return new self(ok: false, error: $error);
    }
}
```

### Testing with Pest
```php
use App\Models\User;

describe('UserService', function () {
    beforeEach(function () {
        $this->service = app(UserService::class);
    });

    it('creates a user with valid data', function () {
        $user = $this->service->create([
            'name' => 'Alice',
            'email' => 'alice@example.com',
        ]);

        expect($user)
            ->toBeInstanceOf(User::class)
            ->name->toBe('Alice')
            ->email->toBe('alice@example.com');
    });

    it('throws validation error for invalid email', function () {
        $this->service->create([
            'name' => 'Bob',
            'email' => 'not-an-email',
        ]);
    })->throws(ValidationException::class);

    it('returns paginated users', function () {
        User::factory()->count(25)->create();

        $result = $this->service->paginate(page: 1, perPage: 10);

        expect($result->items())->toHaveCount(10);
        expect($result->total())->toBe(25);
    });
});
```

### Laravel 11 Patterns
```php
// Slim application bootstrap (Laravel 11)
// bootstrap/app.php
return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
    )
    ->withMiddleware(function (Middleware $middleware) {
        $middleware->api(prepend: [EnsureJsonResponse::class]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        $exceptions->render(function (AppException $e) {
            return response()->json([
                'error' => $e->code,
                'message' => $e->getMessage(),
            ], $e->statusCode);
        });
    })
    ->create();

// Eloquent with typed relations
class Post extends Model
{
    protected $casts = [
        'status' => PostStatus::class, // enum cast
        'metadata' => 'array',
        'published_at' => 'immutable_datetime',
    ];

    public function author(): BelongsTo
    {
        return $this->belongsTo(User::class, 'author_id');
    }

    public function scopePublished(Builder $query): void
    {
        $query->where('status', PostStatus::Published)
              ->whereNotNull('published_at');
    }
}

// Form Request validation
class StorePostRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'title' => ['required', 'string', 'max:255'],
            'body' => ['required', 'string', 'min:50'],
            'status' => ['required', Rule::enum(PostStatus::class)],
        ];
    }
}
```

### Symfony 7 Patterns
```php
// Controller with attributes
#[Route('/api/users', name: 'api_users_')]
class UserController extends AbstractController
{
    public function __construct(
        private readonly UserRepository $users,
    ) {}

    #[Route('/{id}', methods: ['GET'])]
    public function show(string $id): JsonResponse
    {
        $user = $this->users->find($id)
            ?? throw $this->createNotFoundException();

        return $this->json($user);
    }
}

// Typed repository with Doctrine
class UserRepository extends ServiceEntityRepository
{
    /** @return list<User> */
    public function findActiveByRole(Role $role): array
    {
        return $this->createQueryBuilder('u')
            ->where('u.role = :role')
            ->andWhere('u.active = true')
            ->setParameter('role', $role)
            ->getQuery()
            ->getResult();
    }
}
```

## Anti-Patterns
- Using `mixed` when a specific type is available
- Dynamic properties without `#[AllowDynamicProperties]`
- Raw SQL without parameterized queries (SQL injection risk)
- `@` error suppression operator instead of proper handling
- Not using `readonly` for immutable DTOs and value objects
- Ignoring PHPStan/Psalm at level 8+ for type safety

## Framework Integration
- **Laravel 11**: Slim bootstrap, Eloquent ORM with enum casts, Form Request validation, Pest testing
- **Symfony 7**: Attribute-based routing, autowired services, Doctrine ORM, PHPUnit/Pest
- **PHPStan**: Static analysis at level 8+ with strict rules for production codebases
