---
name: lang-ruby
description: "Ruby patterns, pattern matching, Ractor concurrency, and framework-specific best practices for Rails 7.2 and Hotwire/Turbo."
level: 2
triggers:
  - "ruby"
  - "Ruby"
  - ".rb"
  - "rails"
  - "activerecord"
  - "hotwire"
  - "turbo"
  - "rspec"
  - "bundler"
  - "Gemfile"
  - "ractor"
  - "sidekiq"
agents:
  - "backend-developer"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Ruby Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Ruby 3.3+ code
- Rails 7.2 application development
- ActiveRecord modeling and query optimization
- Hotwire/Turbo real-time UI patterns
- RSpec or Minitest testing
- Background job processing with Sidekiq/Solid Queue

## Core Guidance

### Modern Ruby 3.3+ Features
```ruby
# Pattern matching (find pattern)
case response
in { status: 200, body: { users: [{ name: String => name }, *] } }
  puts "First user: #{name}"
in { status: 404 }
  puts "Not found"
in { status: (500..) }
  puts "Server error"
end

# Data class (immutable value objects, Ruby 3.2+)
User = Data.define(:id, :name, :email) do
  def display_name
    "#{name} <#{email}>"
  end
end

user = User.new(id: "1", name: "Alice", email: "alice@example.com")
updated = user.with(name: "Alice B.")  # immutable copy

# Ractor for true parallelism
workers = 4.times.map do |i|
  Ractor.new(i) do |id|
    result = expensive_computation(id)
    Ractor.yield(result)
  end
end
results = workers.map(&:take)

# Endless method definition
def full_name = "#{first_name} #{last_name}"
def admin? = role == :admin

# Hash#except (built-in)
params.except(:password, :token)
```

### Error Handling
```ruby
# Custom error hierarchy
module App
  class Error < StandardError
    attr_reader :code, :status

    def initialize(message, code: "INTERNAL_ERROR", status: 500)
      @code = code
      @status = status
      super(message)
    end
  end

  class NotFoundError < Error
    def initialize(resource, id)
      super("#{resource} #{id} not found", code: "NOT_FOUND", status: 404)
    end
  end

  class ValidationError < Error
    attr_reader :errors

    def initialize(errors)
      @errors = errors
      super("Validation failed", code: "VALIDATION_ERROR", status: 422)
    end
  end
end

# Result pattern
class Result
  attr_reader :value, :error

  def self.success(value) = new(value: value)
  def self.failure(error) = new(error: error)

  def success? = error.nil?
  def failure? = !success?

  def and_then(&block)
    success? ? block.call(value) : self
  end

  private

  def initialize(value: nil, error: nil)
    @value = value
    @error = error
    freeze
  end
end
```

### Testing with RSpec
```ruby
RSpec.describe UserService do
  subject(:service) { described_class.new(repo: repo) }

  let(:repo) { instance_double(UserRepository) }

  describe "#find_user" do
    context "when user exists" do
      let(:user) { User.new(id: "1", name: "Alice", email: "alice@test.com") }

      before { allow(repo).to receive(:find).with("1").and_return(user) }

      it "returns the user" do
        result = service.find_user("1")
        expect(result).to be_success
        expect(result.value).to eq(user)
      end
    end

    context "when user does not exist" do
      before { allow(repo).to receive(:find).with("999").and_return(nil) }

      it "returns a failure result" do
        result = service.find_user("999")
        expect(result).to be_failure
        expect(result.error).to be_a(App::NotFoundError)
      end
    end
  end
end
```

### Rails 7.2 Patterns

#### ActiveRecord Best Practices
```ruby
class User < ApplicationRecord
  # Enums with validation
  enum :role, { viewer: 0, editor: 1, admin: 2 }, validate: true

  # Scopes
  scope :active, -> { where(active: true) }
  scope :by_role, ->(role) { where(role: role) }
  scope :recent, -> { order(created_at: :desc).limit(10) }

  # Strict loading to prevent N+1 (Rails 7+)
  self.strict_loading_by_default = true

  # Normalizations (Rails 7.1+)
  normalizes :email, with: ->(email) { email.strip.downcase }

  # Validations
  validates :name, presence: true, length: { maximum: 255 }
  validates :email, presence: true, uniqueness: true

  # Associations
  has_many :posts, dependent: :destroy
  has_many :comments, through: :posts
end

# Query objects for complex queries
class ActiveUsersQuery
  def call(since: 30.days.ago)
    User.active
        .where("last_login_at > ?", since)
        .includes(:posts)
        .order(last_login_at: :desc)
  end
end
```

#### Hotwire/Turbo
```ruby
# Controller with Turbo Stream responses
class PostsController < ApplicationController
  def create
    @post = current_user.posts.build(post_params)

    if @post.save
      respond_to do |format|
        format.turbo_stream  # renders create.turbo_stream.erb
        format.html { redirect_to @post }
      end
    else
      render :new, status: :unprocessable_entity
    end
  end
end
```

```erb
<%# create.turbo_stream.erb %>
<%= turbo_stream.prepend "posts" do %>
  <%= render partial: "post", locals: { post: @post } %>
<% end %>
<%= turbo_stream.update "post_count", current_user.posts.count %>
```

#### Solid Queue (Rails 8 default)
```ruby
class ProcessOrderJob < ApplicationJob
  queue_as :default
  retry_on ActiveRecord::Deadlocked, wait: 5.seconds, attempts: 3

  def perform(order_id)
    order = Order.find(order_id)
    OrderProcessor.new(order).call
  end
end
```

## Anti-Patterns
- Using `rescue Exception` instead of `rescue StandardError`
- N+1 queries without `includes`/`preload`/`eager_load`
- Fat controllers instead of service objects/form objects
- Monkey-patching core classes in production code
- Skipping `freeze` on string constants (use `# frozen_string_literal: true`)

## Framework Integration
- **Rails 7.2**: Convention over configuration with strict loading, normalizations, and Solid Queue
- **Hotwire/Turbo**: Server-rendered real-time UI with Turbo Streams and Stimulus controllers
- **RSpec + FactoryBot**: BDD testing with factory-based test data and clean doubles
