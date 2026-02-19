---
name: lang-cpp
description: "C++ patterns, RAII, smart pointers, concepts, ranges, and build system best practices for C++23 and CMake."
level: 2
triggers:
  - "c++"
  - "C++"
  - "cpp"
  - ".cpp"
  - ".hpp"
  - ".h"
  - "cmake"
  - "smart pointer"
  - "RAII"
  - "concepts"
  - "ranges"
  - "constexpr"
  - "move semantics"
agents:
  - "persona-backend"
  - "persona-performance"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# C++ Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing C++20/C++23 code
- Memory management with RAII and smart pointers
- Template metaprogramming with concepts and constraints
- CMake build system configuration
- Performance-critical systems and low-level optimization
- Cross-platform library development

## Core Guidance

### RAII and Smart Pointers
```cpp
#include <memory>
#include <vector>
#include <string>

// RAII: resources tied to object lifetime
class DatabaseConnection {
public:
    explicit DatabaseConnection(std::string_view connStr)
        : handle_{connect(connStr)} {}

    ~DatabaseConnection() { if (handle_) disconnect(handle_); }

    // Rule of five: delete copy, enable move
    DatabaseConnection(const DatabaseConnection&) = delete;
    DatabaseConnection& operator=(const DatabaseConnection&) = delete;
    DatabaseConnection(DatabaseConnection&& other) noexcept
        : handle_{std::exchange(other.handle_, nullptr)} {}
    DatabaseConnection& operator=(DatabaseConnection&& other) noexcept {
        std::swap(handle_, other.handle_);
        return *this;
    }

private:
    DbHandle* handle_;
};

// Smart pointer usage
auto user = std::make_unique<User>("Alice", "alice@example.com");
auto shared = std::make_shared<Config>(loadConfig());

// Factory returning unique_ptr
[[nodiscard]] auto createService(const Config& cfg)
    -> std::unique_ptr<IService>
{
    return std::make_unique<ConcreteService>(cfg);
}
```

### Concepts and Constraints (C++20)
```cpp
#include <concepts>
#include <type_traits>

// Define concept for hashable types
template<typename T>
concept Hashable = requires(T a) {
    { std::hash<T>{}(a) } -> std::convertible_to<std::size_t>;
};

// Constrained template
template<Hashable Key, typename Value>
class Cache {
public:
    void put(const Key& key, Value value) {
        store_[key] = std::move(value);
    }

    [[nodiscard]] auto get(const Key& key) const
        -> std::optional<std::reference_wrapper<const Value>>
    {
        if (auto it = store_.find(key); it != store_.end()) {
            return std::cref(it->second);
        }
        return std::nullopt;
    }

private:
    std::unordered_map<Key, Value> store_;
};

// Concept-constrained auto
void process(std::ranges::range auto&& items) {
    for (const auto& item : items) {
        handle(item);
    }
}
```

### Ranges and Views (C++20/23)
```cpp
#include <ranges>
#include <algorithm>
#include <vector>
#include <string>
#include <print>  // C++23

namespace rv = std::ranges::views;

std::vector<User> users = getUsers();

// Composable pipeline
auto activeAdminNames = users
    | rv::filter([](const User& u) { return u.isActive(); })
    | rv::filter([](const User& u) { return u.role() == Role::Admin; })
    | rv::transform([](const User& u) { return u.name(); })
    | rv::take(10);

for (const auto& name : activeAdminNames) {
    std::println("Admin: {}", name);  // C++23 print
}

// C++23: zip, enumerate, chunk
for (auto [idx, user] : users | rv::enumerate) {
    std::println("[{}] {}", idx, user.name());
}

// chunk_by for grouping
auto grouped = users
    | rv::chunk_by([](const User& a, const User& b) {
        return a.role() == b.role();
    });
```

### Error Handling with std::expected (C++23)
```cpp
#include <expected>
#include <string>
#include <system_error>

enum class AppError {
    NotFound,
    Validation,
    Internal,
};

template<typename T>
using Result = std::expected<T, AppError>;

[[nodiscard]] auto findUser(std::string_view id)
    -> Result<User>
{
    auto it = store_.find(id);
    if (it == store_.end()) {
        return std::unexpected(AppError::NotFound);
    }
    return it->second;
}

// Monadic operations (C++23)
auto userName = findUser("123")
    .transform([](const User& u) { return u.name(); })
    .or_else([](AppError e) -> Result<std::string> {
        return std::unexpected(e);
    });
```

### Testing with GoogleTest
```cpp
#include <gtest/gtest.h>
#include <gmock/gmock.h>

class MockUserRepo : public IUserRepository {
public:
    MOCK_METHOD(std::optional<User>, findById, (std::string_view), (const, override));
    MOCK_METHOD(void, save, (const User&), (override));
};

class UserServiceTest : public ::testing::Test {
protected:
    MockUserRepo repo_;
    UserService service_{repo_};
};

TEST_F(UserServiceTest, FindsExistingUser) {
    User expected{"1", "Alice", "alice@test.com"};
    EXPECT_CALL(repo_, findById("1"))
        .WillOnce(::testing::Return(expected));

    auto result = service_.getUser("1");

    ASSERT_TRUE(result.has_value());
    EXPECT_EQ(result->name, "Alice");
}

TEST_F(UserServiceTest, ReturnsErrorForMissingUser) {
    EXPECT_CALL(repo_, findById("999"))
        .WillOnce(::testing::Return(std::nullopt));

    auto result = service_.getUser("999");

    ASSERT_FALSE(result.has_value());
    EXPECT_EQ(result.error(), AppError::NotFound);
}
```

### CMake Configuration
```cmake
cmake_minimum_required(VERSION 3.28)
project(myapp VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Main library
add_library(mylib
    src/user.cpp
    src/service.cpp
)
target_include_directories(mylib PUBLIC include)
target_compile_options(mylib PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall -Wextra -Wpedantic -Werror>
    $<$<CXX_COMPILER_ID:MSVC>:/W4 /WX>
)

# Tests
include(FetchContent)
FetchContent_Declare(googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG v1.15.0
)
FetchContent_MakeAvailable(googletest)

enable_testing()
add_executable(tests tests/user_test.cpp)
target_link_libraries(tests PRIVATE mylib GTest::gtest_main GTest::gmock)
include(GoogleTest)
gtest_discover_tests(tests)
```

## Anti-Patterns
- Raw `new`/`delete` instead of smart pointers
- Returning raw pointers for ownership transfer
- `using namespace std;` in header files
- Catching exceptions by value instead of by `const&`
- Implicit conversions via single-argument constructors without `explicit`
- `const_cast` or `reinterpret_cast` without compelling justification

## Framework Integration
- **CMake 3.28+**: Modern target-based build with presets, FetchContent, and compile_commands.json
- **GoogleTest/Catch2**: Unit testing with mocking support and parameterized tests
- **Conan/vcpkg**: Package management for dependency resolution and reproducible builds
