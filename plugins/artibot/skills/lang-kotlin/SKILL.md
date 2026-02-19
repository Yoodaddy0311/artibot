---
name: lang-kotlin
description: "Kotlin patterns, coroutines, sealed classes, and framework-specific best practices for Ktor, Compose Multiplatform, and Spring Boot."
level: 2
triggers:
  - "kotlin"
  - "Kotlin"
  - ".kt"
  - ".kts"
  - "coroutines"
  - "ktor"
  - "compose multiplatform"
  - "sealed class"
  - "data class"
  - "spring boot kotlin"
  - "gradle kotlin"
  - "jetpack compose"
agents:
  - "backend-developer"
  - "frontend-developer"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Kotlin Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Kotlin code (2.0+)
- Coroutine-based async programming
- Ktor or Spring Boot server development
- Compose Multiplatform UI development
- Gradle Kotlin DSL configuration
- Android or multiplatform project architecture

## Core Guidance

### Sealed Classes and Exhaustive Matching
```kotlin
// Model domain states exhaustively
sealed interface Result<out T> {
    data class Success<T>(val data: T) : Result<T>
    data class Failure(val error: AppError) : Result<Nothing>
    data object Loading : Result<Nothing>
}

// Compiler enforces exhaustive when
fun <T> Result<T>.fold(
    onSuccess: (T) -> Unit,
    onFailure: (AppError) -> Unit,
    onLoading: () -> Unit = {}
) = when (this) {
    is Result.Success -> onSuccess(data)
    is Result.Failure -> onFailure(error)
    is Result.Loading -> onLoading()
}

// Value classes for type safety (zero runtime overhead)
@JvmInline
value class UserId(val value: String)

@JvmInline
value class Email(val value: String) {
    init { require(value.contains("@")) { "Invalid email: $value" } }
}
```

### Coroutines and Structured Concurrency
```kotlin
// Structured concurrency with supervisorScope
suspend fun fetchDashboard(userId: UserId): Dashboard = coroutineScope {
    val profile = async { userRepo.findById(userId) }
    val posts = async { postRepo.findByAuthor(userId) }
    val stats = async { analyticsService.getStats(userId) }

    Dashboard(
        profile = profile.await(),
        posts = posts.await(),
        stats = stats.await(),
    )
}

// Flow for reactive streams
fun observeUsers(): Flow<List<User>> = flow {
    while (currentCoroutineContext().isActive) {
        emit(userRepo.findAll())
        delay(5_000)
    }
}.flowOn(Dispatchers.IO)
    .distinctUntilChanged()
    .catch { e -> emit(emptyList()) }

// Cancellation-safe resource handling
suspend fun processFile(path: Path) {
    withContext(Dispatchers.IO) {
        path.bufferedReader().use { reader ->
            reader.lineSequence().forEach { line ->
                ensureActive() // check cancellation
                process(line)
            }
        }
    }
}
```

### Error Handling
```kotlin
// Railway-oriented error handling with Result
sealed interface AppError {
    data class NotFound(val id: String) : AppError
    data class Validation(val fields: Map<String, String>) : AppError
    data class Unauthorized(val reason: String) : AppError
}

// Extension for clean error mapping
inline fun <T, R> Result<T>.flatMap(transform: (T) -> Result<R>): Result<R> =
    fold(onSuccess = transform, onFailure = { Result.failure(it) })

// runCatching with typed errors
suspend fun getUser(id: UserId): Result<User> = runCatching {
    userRepo.findById(id) ?: throw NotFoundException("User $id not found")
}
```

### Testing with Kotest
```kotlin
import io.kotest.core.spec.style.DescribeSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import io.mockk.coEvery
import io.mockk.mockk

class UserServiceTest : DescribeSpec({
    val repo = mockk<UserRepository>()
    val service = UserService(repo)

    describe("getUser") {
        it("returns user when found") {
            val expected = User(UserId("1"), "Alice")
            coEvery { repo.findById(UserId("1")) } returns expected

            val result = service.getUser(UserId("1"))
            result.shouldBeInstanceOf<Result.Success<User>>()
            result.data shouldBe expected
        }

        it("returns failure when not found") {
            coEvery { repo.findById(UserId("999")) } returns null

            val result = service.getUser(UserId("999"))
            result.shouldBeInstanceOf<Result.Failure>()
        }
    }
})
```

### Framework Patterns

#### Ktor Server
```kotlin
fun Application.configureRouting() {
    routing {
        route("/api/users") {
            get {
                val users = userService.findAll()
                call.respond(HttpStatusCode.OK, users)
            }
            post {
                val input = call.receive<CreateUserRequest>()
                val user = userService.create(input)
                call.respond(HttpStatusCode.Created, user)
            }
        }
    }
}

// Content negotiation + validation
install(ContentNegotiation) { json() }
install(RequestValidation) {
    validate<CreateUserRequest> { req ->
        if (req.email.isBlank()) ValidationResult.Invalid("Email required")
        else ValidationResult.Valid
    }
}
```

#### Compose Multiplatform
```kotlin
@Composable
fun UserCard(user: User, onEdit: (User) -> Unit) {
    var expanded by remember { mutableStateOf(false) }

    Card(
        modifier = Modifier.fillMaxWidth().padding(8.dp),
        onClick = { expanded = !expanded }
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(user.name, style = MaterialTheme.typography.titleMedium)
            AnimatedVisibility(visible = expanded) {
                Text(user.email, style = MaterialTheme.typography.bodyMedium)
                Button(onClick = { onEdit(user) }) { Text("Edit") }
            }
        }
    }
}
```

## Anti-Patterns
- Using `GlobalScope.launch` instead of structured concurrency
- Mutable data classes instead of immutable `data class` with `copy()`
- Platform types (`Type!`) without null checks at Java boundaries
- Blocking coroutine threads with `Thread.sleep()` instead of `delay()`
- Ignoring `Flow` backpressure with unbounded collectors

## Framework Integration
- **Ktor**: Lightweight async server with coroutine-native routing, serialization, and plugins
- **Spring Boot**: Kotlin-idiomatic DI with coroutine support via `spring-webflux`
- **Compose Multiplatform**: Declarative UI with shared business logic across Android, iOS, Desktop, Web
