---
name: lang-java
description: "Java patterns, generics, streams, records, sealed classes, and framework-specific best practices for Spring Boot and Quarkus."
level: 2
triggers:
  - "java"
  - "Java"
  - ".java"
  - "generics"
  - "streams"
  - "records"
  - "sealed classes"
  - "Spring Boot"
  - "Quarkus"
  - "JUnit 5"
  - "Mockito"
  - "Maven"
  - "Gradle"
agents:
  - "backend-developer"
  - "tdd-guide"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Java Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Java code (Java 17+)
- Using records, sealed classes, pattern matching
- Stream API and functional patterns
- Spring Boot or Quarkus development
- Writing JUnit 5 tests with Mockito
- Maven or Gradle build configuration

## Core Guidance

### Records (Java 16+)
```java
// Immutable value objects with compact syntax
public record UserId(String value) {
    // Compact constructor for validation
    public UserId {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("UserId cannot be blank");
        }
    }
}

public record User(UserId id, String name, String email, Instant createdAt) {
    // Derived method
    public String displayName() {
        return name + " <" + email + ">";
    }
}

// Records in pattern matching
if (shape instanceof Circle c) {
    return Math.PI * c.radius() * c.radius();
}
```

### Sealed Classes (Java 17+)
```java
// Exhaustive hierarchy for discriminated unions
public sealed interface Result<T>
    permits Result.Success, Result.Failure {

    record Success<T>(T value) implements Result<T> {}
    record Failure<T>(String message, Throwable cause) implements Result<T> {}

    static <T> Result<T> of(Supplier<T> supplier) {
        try {
            return new Success<>(supplier.get());
        } catch (Exception e) {
            return new Failure<>(e.getMessage(), e);
        }
    }
}

// Pattern matching switch (Java 21+)
String describe(Result<?> result) {
    return switch (result) {
        case Result.Success<?> s -> "Success: " + s.value();
        case Result.Failure<?> f -> "Error: " + f.message();
    };
}
```

### Generics & Wildcards
```java
// Bounded type parameters
public <T extends Comparable<T>> T max(List<T> items) {
    return items.stream().max(Comparator.naturalOrder())
        .orElseThrow(() -> new IllegalArgumentException("Empty list"));
}

// PECS: Producer Extends, Consumer Super
void copy(List<? extends Number> source, List<? super Number> dest) {
    dest.addAll(source);
}

// Generic interface
public interface Repository<T, ID> {
    Optional<T> findById(ID id);
    T save(T entity);
    void delete(ID id);
    List<T> findAll();
}
```

### Streams & Functional API
```java
import java.util.stream.*;

// Collect to grouped map
Map<String, List<User>> byDepartment = users.stream()
    .collect(Collectors.groupingBy(User::department));

// FlatMap for nested collections
List<String> allTags = posts.stream()
    .flatMap(p -> p.tags().stream())
    .distinct()
    .sorted()
    .collect(Collectors.toList());

// Custom collector
record Stats(long count, double avg, double max) {}

Stats stats = numbers.stream().collect(Collector.of(
    () -> new double[]{0, 0, Double.MIN_VALUE},
    (a, v) -> { a[0]++; a[1] += v; a[2] = Math.max(a[2], v); },
    (a, b) -> new double[]{a[0]+b[0], a[1]+b[1], Math.max(a[2], b[2])},
    a -> new Stats((long)a[0], a[1]/a[0], a[2])
));
```

### Build Configuration

**Maven (pom.xml)**:
```xml
<project>
  <properties>
    <java.version>21</java.version>
    <maven.compiler.release>21</maven.compiler.release>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
        <configuration>
          <image><name>myapp:${project.version}</name></image>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
```

**Gradle (build.gradle.kts)**:
```kotlin
plugins {
    java
    id("org.springframework.boot") version "3.3.0"
    id("io.spring.dependency-management") version "1.1.6"
}

java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }

dependencies {
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-data-jpa")
    testImplementation("org.springframework.boot:spring-boot-starter-test")
}
```

### Spring Boot Patterns
```java
// REST Controller with validation
@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor
public class UserController {
    private final UserService userService;

    @GetMapping("/{id}")
    public ResponseEntity<UserResponse> getUser(@PathVariable String id) {
        return userService.findById(new UserId(id))
            .map(ResponseEntity::ok)
            .orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "User not found: " + id));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public UserResponse createUser(@Valid @RequestBody CreateUserRequest req) {
        return userService.create(req);
    }
}

// Service with transaction
@Service
@Transactional
@RequiredArgsConstructor
public class UserService {
    private final UserRepository userRepository;

    @Transactional(readOnly = true)
    public Optional<UserResponse> findById(UserId id) {
        return userRepository.findById(id.value())
            .map(UserResponse::from);
    }
}

// Exception handler
@RestControllerAdvice
public class GlobalExceptionHandler {
    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String, String> handleValidation(MethodArgumentNotValidException ex) {
        return ex.getBindingResult().getFieldErrors().stream()
            .collect(Collectors.toMap(
                FieldError::getField,
                fe -> Objects.requireNonNullElse(fe.getDefaultMessage(), "invalid")));
    }
}
```

### Quarkus Patterns
```java
// Reactive REST with Panache
@Path("/users")
@Produces(MediaType.APPLICATION_JSON)
public class UserResource {
    @GET
    @Path("/{id}")
    public Uni<Response> getUser(@PathParam("id") String id) {
        return User.<User>findById(id)
            .onItem().ifNotNull().transform(u -> Response.ok(u).build())
            .onItem().ifNull().continueWith(Response.status(404).build());
    }
}

// Quarkus configuration injection
@ApplicationScoped
public class AppConfig {
    @ConfigProperty(name = "app.feature.enabled", defaultValue = "false")
    boolean featureEnabled;
}
```

### Testing: JUnit 5 + Mockito
```java
@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock UserRepository userRepository;
    @InjectMocks UserService userService;

    @Test
    void findById_existingUser_returnsUser() {
        // Arrange
        var user = new User(new UserId("1"), "Alice", "alice@example.com", Instant.now());
        when(userRepository.findById("1")).thenReturn(Optional.of(user));

        // Act
        var result = userService.findById(new UserId("1"));

        // Assert
        assertThat(result).isPresent().get()
            .extracting(UserResponse::name).isEqualTo("Alice");
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " ", "invalid-id"})
    void findById_invalidId_throwsException(String id) {
        assertThatThrownBy(() -> new UserId(id))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void findById_nonexistentUser_returnsEmpty() {
        when(userRepository.findById(any())).thenReturn(Optional.empty());
        assertThat(userService.findById(new UserId("999"))).isEmpty();
    }
}

// Spring Boot integration test
@SpringBootTest(webEnvironment = RANDOM_PORT)
@Testcontainers
class UserControllerIT {
    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Autowired TestRestTemplate restTemplate;

    @Test
    void createUser_validInput_returns201() {
        var req = new CreateUserRequest("Bob", "bob@example.com");
        var response = restTemplate.postForEntity("/api/v1/users", req, UserResponse.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(response.getBody()).isNotNull()
            .extracting(UserResponse::name).isEqualTo("Bob");
    }
}
```

## Quick Reference

| Feature | When to Use |
|---------|------------|
| `record` | Immutable value objects, DTOs |
| `sealed` | Exhaustive type hierarchies |
| `Optional<T>` | Nullable return values |
| `Stream.parallel()` | CPU-bound bulk operations |
| `CompletableFuture` | Async composition |
| Text blocks `"""` | Multiline strings (SQL, JSON) |
| `var` | Local type inference where clear |

**Anti-Patterns**:
- `null` returns (use `Optional`)
- Checked exceptions for business logic (use unchecked)
- Mutable public fields
- `instanceof` without pattern matching (verbose)
- Raw types (always parameterize generics)
