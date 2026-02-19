---
name: lang-flutter
description: "Flutter/Dart patterns, Riverpod state management, go_router navigation, and Material 3 best practices for cross-platform apps."
level: 2
triggers:
  - "flutter"
  - "Flutter"
  - "dart"
  - "Dart"
  - ".dart"
  - "riverpod"
  - "go_router"
  - "material 3"
  - "widget"
  - "pubspec"
  - "freezed"
  - "bloc"
  - "cross-platform"
agents:
  - "frontend-developer"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Flutter/Dart Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Flutter 3.24+/Dart 3.5+ code
- State management with Riverpod or Bloc
- Navigation with go_router
- Material 3 theming and adaptive design
- Cross-platform (iOS, Android, Web, Desktop) development
- Package configuration with pubspec.yaml

## Core Guidance

### Dart 3.5+ Type System
```dart
// Sealed classes for exhaustive pattern matching
sealed class Result<T> {
  const Result();
}

class Success<T> extends Result<T> {
  final T data;
  const Success(this.data);
}

class Failure<T> extends Result<T> {
  final AppError error;
  const Failure(this.error);
}

class Loading<T> extends Result<T> {
  const Loading();
}

// Exhaustive switch
Widget buildResult<T>(Result<T> result, Widget Function(T) builder) {
  return switch (result) {
    Success(:final data) => builder(data),
    Failure(:final error) => ErrorWidget(error: error),
    Loading() => const CircularProgressIndicator(),
  };
}

// Records for lightweight data grouping
typedef UserSummary = ({String name, String email, int postCount});

UserSummary summarize(User user) => (
  name: user.name,
  email: user.email,
  postCount: user.posts.length,
);

// Extension types (zero-cost wrapper)
extension type UserId(String value) {
  factory UserId.generate() => UserId(const Uuid().v4());
}

// Patterns in if-case
void processResponse(Map<String, dynamic> json) {
  if (json case {'status': 'ok', 'data': {'users': List users}}) {
    for (final user in users) {
      processUser(user);
    }
  }
}
```

### Error Handling
```dart
// Typed error hierarchy
sealed class AppError {
  String get message;
}

class NotFoundError extends AppError {
  final String resource;
  final String id;
  NotFoundError(this.resource, this.id);

  @override
  String get message => '$resource with id $id not found';
}

class ValidationError extends AppError {
  final Map<String, String> fields;
  ValidationError(this.fields);

  @override
  String get message => 'Validation failed: ${fields.entries.join(", ")}';
}

class NetworkError extends AppError {
  final int? statusCode;
  final String details;
  NetworkError({this.statusCode, required this.details});

  @override
  String get message => 'Network error ($statusCode): $details';
}

// Safe async operations
Future<Result<T>> safeAsync<T>(Future<T> Function() operation) async {
  try {
    return Success(await operation());
  } on AppError catch (e) {
    return Failure(e);
  } catch (e, stack) {
    log.severe('Unexpected error', e, stack);
    return Failure(NetworkError(details: e.toString()));
  }
}
```

### Testing
```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockUserRepository extends Mock implements UserRepository {}

void main() {
  late MockUserRepository repo;
  late UserService service;

  setUp(() {
    repo = MockUserRepository();
    service = UserService(repo);
  });

  group('UserService', () {
    test('returns user when found', () async {
      final expected = User(id: UserId('1'), name: 'Alice', email: 'alice@test.com');
      when(() => repo.findById(UserId('1'))).thenAnswer((_) async => expected);

      final result = await service.getUser(UserId('1'));

      expect(result, isA<Success<User>>());
      expect((result as Success).data.name, equals('Alice'));
      verify(() => repo.findById(UserId('1'))).called(1);
    });

    test('returns failure when not found', () async {
      when(() => repo.findById(any())).thenAnswer((_) async => null);

      final result = await service.getUser(UserId('999'));

      expect(result, isA<Failure<User>>());
    });
  });

  // Widget test
  testWidgets('UserCard displays name and email', (tester) async {
    final user = User(id: UserId('1'), name: 'Alice', email: 'alice@test.com');

    await tester.pumpWidget(
      MaterialApp(home: Scaffold(body: UserCard(user: user))),
    );

    expect(find.text('Alice'), findsOneWidget);
    expect(find.text('alice@test.com'), findsOneWidget);
  });
}
```

### Riverpod State Management
```dart
// Provider definitions
@riverpod
class UserNotifier extends _$UserNotifier {
  @override
  Future<List<User>> build() async {
    final repo = ref.watch(userRepositoryProvider);
    return repo.findAll();
  }

  Future<void> addUser(CreateUserRequest request) async {
    final repo = ref.read(userRepositoryProvider);
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await repo.create(request);
      return repo.findAll();
    });
  }

  Future<void> deleteUser(UserId id) async {
    final repo = ref.read(userRepositoryProvider);
    state = await AsyncValue.guard(() async {
      await repo.delete(id);
      return repo.findAll();
    });
  }
}

// Consuming in widgets
class UserListPage extends ConsumerWidget {
  const UserListPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final usersAsync = ref.watch(userNotifierProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Users')),
      body: usersAsync.when(
        data: (users) => ListView.builder(
          itemCount: users.length,
          itemBuilder: (context, index) => UserTile(user: users[index]),
        ),
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text('Error: $error'),
              ElevatedButton(
                onPressed: () => ref.invalidate(userNotifierProvider),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => context.push('/users/create'),
        child: const Icon(Icons.add),
      ),
    );
  }
}
```

### go_router Navigation
```dart
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/users',
    redirect: (context, state) {
      final isAuthenticated = ref.read(authProvider).isAuthenticated;
      if (!isAuthenticated && !state.matchedLocation.startsWith('/login')) {
        return '/login';
      }
      return null;
    },
    routes: [
      GoRoute(
        path: '/login',
        builder: (context, state) => const LoginPage(),
      ),
      ShellRoute(
        builder: (context, state, child) => AppShell(child: child),
        routes: [
          GoRoute(
            path: '/users',
            builder: (context, state) => const UserListPage(),
            routes: [
              GoRoute(
                path: ':id',
                builder: (context, state) => UserDetailPage(
                  userId: UserId(state.pathParameters['id']!),
                ),
              ),
              GoRoute(
                path: 'create',
                builder: (context, state) => const CreateUserPage(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
});
```

### Material 3 Theming
```dart
class AppTheme {
  static ThemeData light() => ThemeData(
    useMaterial3: true,
    colorSchemeSeed: const Color(0xFF6750A4),
    brightness: Brightness.light,
    textTheme: GoogleFonts.interTextTheme(),
    cardTheme: const CardTheme(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(12)),
      ),
    ),
    inputDecorationTheme: const InputDecorationTheme(
      filled: true,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.all(Radius.circular(12)),
      ),
    ),
  );

  static ThemeData dark() => ThemeData(
    useMaterial3: true,
    colorSchemeSeed: const Color(0xFF6750A4),
    brightness: Brightness.dark,
    textTheme: GoogleFonts.interTextTheme(ThemeData.dark().textTheme),
  );
}
```

## Anti-Patterns
- Deeply nested widget trees instead of extracting custom widgets
- Using `setState` for complex state instead of Riverpod/Bloc
- `late` variables without guaranteed initialization
- Not disposing controllers and streams in `StatefulWidget.dispose()`
- Hard-coded strings instead of `l10n` localization
- Using `dynamic` when a specific type is available

## Framework Integration
- **Riverpod 2**: Code-generated providers with `@riverpod`, `AsyncValue` for loading states, and `ref.invalidate` for refresh
- **go_router**: Declarative routing with path parameters, redirect guards, and ShellRoute for persistent navigation
- **Material 3**: Adaptive theming with `colorSchemeSeed`, `useMaterial3`, and responsive breakpoints
