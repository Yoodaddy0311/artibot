---
name: lang-swift
description: "Swift patterns, structured concurrency, actors, and framework-specific best practices for SwiftUI, Combine, and server-side Swift."
level: 2
triggers:
  - "swift"
  - "Swift"
  - ".swift"
  - "swiftui"
  - "combine"
  - "async/await"
  - "actor"
  - "xcode"
  - "ios"
  - "macos"
  - "vapor"
  - "swift package"
agents:
  - "persona-frontend"
  - "persona-backend"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Swift Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Swift 6+ code
- SwiftUI declarative UI development
- Structured concurrency with async/await and actors
- Combine reactive programming
- Swift Package Manager configuration
- iOS, macOS, or server-side Swift (Vapor) development

## Core Guidance

### Structured Concurrency
```swift
// async/await with task groups
func fetchDashboard(userId: String) async throws -> Dashboard {
    async let profile = userService.fetchProfile(userId)
    async let posts = postService.fetchPosts(userId)
    async let stats = analyticsService.fetchStats(userId)

    return try Dashboard(
        profile: await profile,
        posts: await posts,
        stats: await stats
    )
}

// TaskGroup for dynamic concurrency
func processImages(_ urls: [URL]) async throws -> [ProcessedImage] {
    try await withThrowingTaskGroup(of: ProcessedImage.self) { group in
        for url in urls {
            group.addTask {
                let data = try await URLSession.shared.data(from: url).0
                return try await ImageProcessor.process(data)
            }
        }
        return try await group.reduce(into: []) { $0.append($1) }
    }
}

// AsyncSequence for streaming
func streamEvents() -> AsyncThrowingStream<Event, Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            for try await line in url.lines {
                let event = try JSONDecoder().decode(Event.self, from: Data(line.utf8))
                continuation.yield(event)
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}
```

### Actors (Data Race Safety)
```swift
// Actor for thread-safe state
actor UserCache {
    private var store: [String: User] = [:]
    private let maxSize: Int

    init(maxSize: Int = 1000) {
        self.maxSize = maxSize
    }

    func get(_ id: String) -> User? {
        store[id]
    }

    func set(_ id: String, user: User) {
        if store.count >= maxSize {
            store.removeAll()
        }
        store[id] = user
    }

    func getOrFetch(_ id: String, fetch: @Sendable () async throws -> User) async throws -> User {
        if let cached = store[id] { return cached }
        let user = try await fetch()
        store[id] = user
        return user
    }
}

// @MainActor for UI state
@MainActor
@Observable
class UserViewModel {
    private(set) var users: [User] = []
    private(set) var isLoading = false
    private(set) var error: AppError?

    private let service: UserService

    init(service: UserService) {
        self.service = service
    }

    func loadUsers() async {
        isLoading = true
        defer { isLoading = false }

        do {
            users = try await service.fetchAll()
        } catch let appError as AppError {
            error = appError
        } catch {
            self.error = .unexpected(error)
        }
    }
}
```

### Error Handling
```swift
// Typed errors (Swift 6)
enum AppError: Error, LocalizedError {
    case notFound(resource: String, id: String)
    case validation(fields: [String: String])
    case unauthorized(reason: String)
    case network(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .notFound(let resource, let id):
            "\(resource) with id '\(id)' was not found"
        case .validation(let fields):
            "Validation failed: \(fields.map { "\($0.key): \($0.value)" }.joined(separator: ", "))"
        case .unauthorized(let reason):
            "Unauthorized: \(reason)"
        case .network(let underlying):
            "Network error: \(underlying.localizedDescription)"
        }
    }
}

// Result type for expected failures
func parseConfig(_ data: Data) -> Result<Config, AppError> {
    do {
        let config = try JSONDecoder().decode(Config.self, from: data)
        return .success(config)
    } catch {
        return .failure(.validation(fields: ["config": error.localizedDescription]))
    }
}
```

### Testing with Swift Testing
```swift
import Testing

@Suite("UserService Tests")
struct UserServiceTests {
    let mockRepo = MockUserRepository()
    let service: UserService

    init() {
        service = UserService(repository: mockRepo)
    }

    @Test("Returns user when found")
    func findsExistingUser() async throws {
        let expected = User(id: "1", name: "Alice", email: "alice@test.com")
        mockRepo.stubbedUsers["1"] = expected

        let user = try await service.getUser(id: "1")
        #expect(user == expected)
        #expect(user.name == "Alice")
    }

    @Test("Throws notFound for missing user")
    func throwsForMissingUser() async {
        await #expect(throws: AppError.self) {
            try await service.getUser(id: "999")
        }
    }

    @Test("Loads multiple users concurrently", arguments: [3, 5, 10])
    func loadsConcurrently(count: Int) async throws {
        for i in 0..<count {
            mockRepo.stubbedUsers["\(i)"] = User(id: "\(i)", name: "User \(i)", email: "u\(i)@test.com")
        }
        let users = try await service.getUsers(ids: (0..<count).map(String.init))
        #expect(users.count == count)
    }
}
```

### SwiftUI Patterns
```swift
struct UserListView: View {
    @State private var viewModel: UserViewModel

    init(service: UserService) {
        _viewModel = State(initialValue: UserViewModel(service: service))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading {
                    ProgressView("Loading users...")
                } else if let error = viewModel.error {
                    ContentUnavailableView {
                        Label("Error", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error.localizedDescription)
                    } actions: {
                        Button("Retry") { Task { await viewModel.loadUsers() } }
                    }
                } else {
                    List(viewModel.users) { user in
                        NavigationLink(value: user) {
                            UserRow(user: user)
                        }
                    }
                }
            }
            .navigationTitle("Users")
            .task { await viewModel.loadUsers() }
            .refreshable { await viewModel.loadUsers() }
        }
    }
}

// Reusable component with environment
struct UserRow: View {
    let user: User
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack {
            AsyncImage(url: user.avatarURL) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Circle().fill(.gray.opacity(0.3))
            }
            .frame(width: 40, height: 40)
            .clipShape(Circle())

            VStack(alignment: .leading) {
                Text(user.name).font(.headline)
                Text(user.email).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}
```

## Anti-Patterns
- Force unwrapping (`!`) without guard/if-let checks
- Reference cycles in closures without `[weak self]` or `[unowned self]`
- Blocking the main thread with synchronous I/O
- Using `class` when `struct` or `actor` is more appropriate
- `@StateObject` in subviews instead of `@ObservedObject` (pre-Observation)
- Not using `Sendable` conformance for types shared across concurrency domains

## Framework Integration
- **SwiftUI**: Declarative UI with `@Observable` macro, navigation stacks, and `.task` modifier
- **Swift Testing**: Modern test framework with `#expect` macros, parameterized tests, and suites
- **Vapor**: Server-side Swift with async routing, Fluent ORM, and structured concurrency
