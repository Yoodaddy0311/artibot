---
name: lang-rust
description: "Rust patterns, ownership, lifetimes, traits, error handling, and framework-specific best practices for Axum and Actix-web."
level: 2
triggers:
  - "rust"
  - "Rust"
  - ".rs"
  - "ownership"
  - "borrow"
  - "lifetime"
  - "trait"
  - "enum"
  - "Result"
  - "Option"
  - "cargo"
  - "Axum"
  - "Actix"
  - "tokio"
agents:
  - "backend-developer"
  - "performance-engineer"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Rust Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Rust code
- Understanding ownership and lifetimes
- Implementing traits and enums
- Axum or Actix-web development
- Async code with Tokio
- Writing cargo tests with proptest

## Core Guidance

### Ownership & Borrowing
```rust
// Clone only when necessary - prefer references
fn process(data: &[u8]) -> usize {        // borrow
fn take_ownership(data: Vec<u8>) -> usize  // move
fn return_borrowed<'a>(data: &'a str) -> &'a str  // lifetime

// Rc/Arc for shared ownership
use std::sync::{Arc, Mutex};
let shared = Arc::new(Mutex::new(Vec::<u32>::new()));
let clone = Arc::clone(&shared);

// Interior mutability
use std::cell::RefCell;
let data = RefCell::new(vec![1, 2, 3]);
data.borrow_mut().push(4);
```

### Lifetimes
```rust
// Explicit lifetimes when compiler can't infer
struct StrSplit<'haystack, 'delim> {
    remainder: &'haystack str,
    delimiter: &'delim str,
}

impl<'haystack, 'delim> StrSplit<'haystack, 'delim> {
    fn new(haystack: &'haystack str, delimiter: &'delim str) -> Self {
        Self { remainder: haystack, delimiter }
    }
}

// 'static lifetime for owned or truly static data
fn get_config() -> &'static str {
    "production"
}
```

### Traits
```rust
// Trait definition and blanket implementations
trait Summary {
    fn summarize(&self) -> String;
    fn preview(&self) -> String {  // default implementation
        format!("{}...", &self.summarize()[..50.min(self.summarize().len())])
    }
}

// Trait objects for dynamic dispatch
fn notify(item: &dyn Summary) {
    println!("{}", item.summarize());
}

// Generic bounds (static dispatch - preferred)
fn notify_generic<T: Summary + Display>(item: &T) {
    println!("{}: {}", item, item.summarize());
}

// From/Into for conversions
impl From<String> for UserId {
    fn from(s: String) -> Self {
        UserId(s)
    }
}
```

### Enums for Error Handling
```rust
use thiserror::Error;

#[derive(Debug, Error)]
enum AppError {
    #[error("not found: {resource} with id {id}")]
    NotFound { resource: &'static str, id: String },

    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("validation error: {0}")]
    Validation(String),
}

// Result propagation with ?
async fn get_user(db: &Pool, id: &str) -> Result<User, AppError> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(db)
        .await?  // sqlx::Error -> AppError::Database via From
        .ok_or_else(|| AppError::NotFound {
            resource: "User",
            id: id.to_string(),
        })?;
    Ok(user)
}
```

### Cargo Workspace & Feature Flags
```toml
# Cargo.toml (workspace)
[workspace]
members = ["crates/core", "crates/api", "crates/cli"]
resolver = "2"

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }

# crates/api/Cargo.toml
[features]
default = ["http"]
http = ["axum", "tower"]
grpc = ["tonic"]

[dependencies]
core = { path = "../core" }
tokio = { workspace = true }
serde = { workspace = true }
axum = { version = "0.7", optional = true }
```

### Axum Framework
```rust
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    db: Arc<Database>,
}

async fn get_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<User>, AppError> {
    let user = state.db.find_user(&id).await?;
    Ok(Json(user))
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, msg) = match &self {
            AppError::NotFound { .. } => (StatusCode::NOT_FOUND, self.to_string()),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string()),
        };
        (status, msg).into_response()
    }
}

#[tokio::main]
async fn main() {
    let state = AppState { db: Arc::new(Database::connect().await.unwrap()) };
    let app = Router::new()
        .route("/users/:id", get(get_user))
        .with_state(state);
    axum::serve(tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap(), app)
        .await.unwrap();
}
```

### Actix-web
```rust
use actix_web::{web, App, HttpServer, HttpResponse, Error};

async fn get_user(
    db: web::Data<Database>,
    path: web::Path<String>,
) -> Result<HttpResponse, Error> {
    let id = path.into_inner();
    let user = db.find_user(&id).await
        .map_err(|_| actix_web::error::ErrorNotFound("user not found"))?;
    Ok(HttpResponse::Ok().json(user))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let db = web::Data::new(Database::connect().await.unwrap());
    HttpServer::new(move || {
        App::new()
            .app_data(db.clone())
            .route("/users/{id}", web::get().to(get_user))
    })
    .bind("0.0.0.0:8080")?
    .run()
    .await
}
```

### Testing: cargo test + proptest
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn test_user_creation() {
        let user = User::new("alice", "alice@example.com");
        assert_eq!(user.name, "alice");
    }

    // Property-based testing
    proptest! {
        #[test]
        fn valid_emails_never_panic(s in "[a-z]+@[a-z]+\\.[a-z]+") {
            let _ = validate_email(&s);
        }

        #[test]
        fn sort_is_idempotent(v: Vec<i32>) {
            let mut a = v.clone();
            let mut b = v;
            a.sort();
            b.sort();
            b.sort();
            prop_assert_eq!(a, b);
        }
    }
}

// Integration test (tests/integration_test.rs)
#[tokio::test]
async fn test_api_get_user() {
    let app = create_test_app().await;
    let response = app.get("/users/1").send().await;
    assert_eq!(response.status(), 200);
}
```

## Quick Reference

| Pattern | When to Use |
|---------|------------|
| `Option<T>` | Nullable values (no null) |
| `Result<T, E>` | Fallible operations |
| `?` operator | Error propagation |
| `Arc<Mutex<T>>` | Shared mutable state |
| `impl Trait` | Return-position generics |
| `Box<dyn Trait>` | Heap-allocated trait objects |
| `Pin<Box<...>>` | Self-referential async futures |

**Anti-Patterns**:
- `.unwrap()` in production code (use `?` or explicit handling)
- Cloning to avoid borrow issues (redesign ownership)
- `unsafe` without clear justification
- Blocking in async context (use `spawn_blocking`)
- Overly complex lifetime annotations (often indicates design issue)
