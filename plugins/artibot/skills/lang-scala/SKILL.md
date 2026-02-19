---
name: lang-scala
description: "Scala patterns, given/using, opaque types, and framework-specific best practices for Akka, Cats Effect, ZIO, and Spark."
level: 2
triggers:
  - "scala"
  - "Scala"
  - ".scala"
  - ".sc"
  - "akka"
  - "cats effect"
  - "zio"
  - "spark"
  - "sbt"
  - "given"
  - "opaque type"
  - "case class"
  - "play framework"
agents:
  - "backend-developer"
  - "performance-engineer"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Scala Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Scala 3.4+ code
- Functional programming with Cats Effect or ZIO
- Akka actor-based concurrency
- Apache Spark data processing
- SBT build configuration
- Type-level programming with opaque types and given instances

## Core Guidance

### Scala 3 Type System
```scala
// Opaque types (zero-cost abstraction)
object Types:
  opaque type UserId = String
  object UserId:
    def apply(value: String): UserId = value
    extension (id: UserId)
      def value: String = id

  opaque type Email = String
  object Email:
    def apply(value: String): Either[String, Email] =
      if value.contains("@") then Right(value)
      else Left(s"Invalid email: $value")

// Enum with methods (ADT)
enum AppError:
  case NotFound(resource: String, id: String)
  case Validation(errors: List[String])
  case Unauthorized(reason: String)
  case Internal(cause: Throwable)

  def statusCode: Int = this match
    case NotFound(_, _)    => 404
    case Validation(_)     => 422
    case Unauthorized(_)   => 401
    case Internal(_)       => 500

// Union types
type JsonValue = String | Int | Double | Boolean | Null | List[JsonValue] | Map[String, JsonValue]

// Intersection types for composition
trait Logging:
  def log(msg: String): Unit
trait Metrics:
  def record(name: String, value: Double): Unit

type Observable = Logging & Metrics
```

### Given/Using (Context Parameters)
```scala
// Given instances replace implicits
trait JsonEncoder[A]:
  def encode(a: A): String

given JsonEncoder[User] with
  def encode(user: User): String =
    s"""{"id":"${user.id}","name":"${user.name}"}"""

given JsonEncoder[List[User]] with
  def encode(users: List[User]): String =
    users.map(summon[JsonEncoder[User]].encode).mkString("[", ",", "]")

// Using clauses for dependency injection
def respond[A](data: A)(using encoder: JsonEncoder[A]): Response =
  Response(200, encoder.encode(data))

// Context functions
type Transactional[A] = Transaction ?=> A

def transferFunds(from: Account, to: Account, amount: BigDecimal): Transactional[Unit] =
  from.debit(amount)
  to.credit(amount)
```

### Error Handling with Either
```scala
// Railway-oriented programming
def createUser(req: CreateUserRequest): Either[AppError, User] =
  for
    email <- Email(req.email).left.map(e => AppError.Validation(List(e)))
    _     <- validateUnique(email)
    user  <- Right(User(UserId(generateId()), req.name, email))
    _     <- save(user)
  yield user

// Extension methods for ergonomic chaining
extension [A](either: Either[AppError, A])
  def orNotFound(msg: String): Either[AppError, A] =
    either.left.map(_ => AppError.NotFound("resource", msg))

  def tapError(f: AppError => Unit): Either[AppError, A] =
    either.left.map { e => f(e); e }
```

### Testing with MUnit
```scala
import munit.FunSuite
import munit.CatsEffectSuite

class UserServiceSuite extends FunSuite:
  val repo = MockUserRepository()
  val service = UserService(repo)

  test("finds existing user"):
    val user = User(UserId("1"), "Alice", Email("alice@test.com").toOption.get)
    repo.store(user)

    val result = service.findUser(UserId("1"))
    assertEquals(result, Right(user))

  test("returns NotFound for missing user"):
    val result = service.findUser(UserId("999"))
    assert(result.isLeft)
    result.left.foreach:
      case AppError.NotFound(_, _) => () // expected
      case other => fail(s"Unexpected error: $other")

// Cats Effect integration test
class UserServiceIOSuite extends CatsEffectSuite:
  test("creates user concurrently"):
    val program = for
      service <- UserService.make[IO]
      results <- (1 to 10).toList.parTraverse: i =>
        service.createUser(CreateUserRequest(s"User$i", s"user$i@test.com"))
    yield results

    program.map: results =>
      assertEquals(results.count(_.isRight), 10)
```

### Framework Patterns

#### Cats Effect (Pure FP)
```scala
import cats.effect.*
import cats.syntax.all.*

def program: IO[Unit] =
  for
    config <- IO(loadConfig())
    _      <- IO.println(s"Starting with ${config.dbUrl}")
    db     <- Database.connect[IO](config.dbUrl)
    server <- HttpServer.start[IO](config.port, routes(db))
    _      <- server.useForever
  yield ()

// Resource safety with Resource monad
def resources(cfg: Config): Resource[IO, (Database, HttpServer)] =
  for
    db     <- Database.resource[IO](cfg.dbUrl)
    server <- HttpServer.resource[IO](cfg.port)
  yield (db, server)
```

#### ZIO
```scala
import zio.*

val program: ZIO[UserService & Database, AppError, Unit] =
  for
    users  <- ZIO.serviceWithZIO[UserService](_.findAll)
    _      <- ZIO.foreachPar(users)(user => processUser(user))
    _      <- ZIO.logInfo(s"Processed ${users.size} users")
  yield ()

// Layer-based dependency injection
val appLayer: ZLayer[Any, Nothing, UserService & Database] =
  ZLayer.make[UserService & Database](
    UserServiceLive.layer,
    DatabaseLive.layer,
    ConfigLive.layer,
  )
```

#### Apache Spark
```scala
import org.apache.spark.sql.{SparkSession, DataFrame, Dataset}
import org.apache.spark.sql.functions.*

val spark = SparkSession.builder()
  .appName("analytics")
  .config("spark.sql.adaptive.enabled", "true")
  .getOrCreate()

import spark.implicits.*

// Type-safe Dataset API
case class UserEvent(userId: String, action: String, timestamp: Long)

val events: Dataset[UserEvent] = spark.read
  .parquet("s3://data/events/")
  .as[UserEvent]

val dailyActive = events
  .withColumn("date", from_unixtime(col("timestamp"), "yyyy-MM-dd"))
  .groupBy("date")
  .agg(countDistinct("userId").as("dau"))
  .orderBy(desc("date"))
```

## Anti-Patterns
- Using `null` instead of `Option`/`Either`
- Mutable `var` when `val` suffices
- Implicit conversions that obscure behavior
- Blocking inside `IO`/`ZIO` without wrapping in `IO.blocking`
- Untyped `Any` in public APIs instead of proper generics
- Spark `collect()` on large datasets causing OOM

## Framework Integration
- **Cats Effect 3**: Pure functional IO with Resource safety, fiber-based concurrency, and composable effects
- **ZIO 2**: Effect system with typed errors, built-in dependency injection via ZLayer, and structured concurrency
- **Apache Spark 3.5**: Distributed data processing with type-safe Dataset API and adaptive query execution
