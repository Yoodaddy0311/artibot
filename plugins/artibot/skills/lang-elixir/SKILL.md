---
name: lang-elixir
description: "Elixir patterns, OTP supervision, GenServer, and framework-specific best practices for Phoenix 1.7, LiveView, and Ecto."
level: 2
triggers:
  - "elixir"
  - "Elixir"
  - ".ex"
  - ".exs"
  - "phoenix"
  - "liveview"
  - "ecto"
  - "genserver"
  - "otp"
  - "mix"
  - "supervisor"
  - "erlang"
  - "beam"
agents:
  - "persona-backend"
  - "persona-architect"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Elixir Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing Elixir 1.17+ code
- Phoenix 1.7 web application development
- LiveView real-time interactive UI
- Ecto database query and schema design
- OTP patterns: GenServer, Supervisor, Agent
- Distributed system design on the BEAM VM

## Core Guidance

### Pattern Matching and Data Modeling
```elixir
# Tagged tuples for result types
defmodule App.Result do
  @type t(value) :: {:ok, value} | {:error, App.Error.t()}

  def map({:ok, value}, fun), do: {:ok, fun.(value)}
  def map({:error, _} = error, _fun), do: error

  def flat_map({:ok, value}, fun), do: fun.(value)
  def flat_map({:error, _} = error, _fun), do: error
end

# Structs with enforced keys
defmodule App.User do
  @enforce_keys [:id, :name, :email]
  defstruct [:id, :name, :email, role: :viewer, active: true]

  @type t :: %__MODULE__{
    id: String.t(),
    name: String.t(),
    email: String.t(),
    role: :admin | :editor | :viewer,
    active: boolean()
  }
end

# Multi-clause functions with guards
defmodule App.Permissions do
  def can_edit?(%App.User{role: :admin}), do: true
  def can_edit?(%App.User{role: :editor}), do: true
  def can_edit?(%App.User{}), do: false

  def authorize(%App.User{} = user, action) when action in [:read, :write, :delete] do
    case {user.role, action} do
      {:admin, _} -> :ok
      {:editor, :delete} -> {:error, :unauthorized}
      {:editor, _} -> :ok
      {:viewer, :read} -> :ok
      _ -> {:error, :unauthorized}
    end
  end
end
```

### OTP Patterns

#### GenServer
```elixir
defmodule App.Cache do
  use GenServer

  # Client API
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    ttl = Keyword.get(opts, :ttl, :timer.minutes(5))
    GenServer.start_link(__MODULE__, %{ttl: ttl}, name: name)
  end

  def get(server \\ __MODULE__, key) do
    GenServer.call(server, {:get, key})
  end

  def put(server \\ __MODULE__, key, value) do
    GenServer.cast(server, {:put, key, value})
  end

  # Server callbacks
  @impl true
  def init(state) do
    schedule_cleanup(state.ttl)
    {:ok, Map.put(state, :store, %{})}
  end

  @impl true
  def handle_call({:get, key}, _from, %{store: store} = state) do
    case Map.get(store, key) do
      {value, expires_at} when expires_at > System.monotonic_time(:millisecond) ->
        {:reply, {:ok, value}, state}
      _ ->
        {:reply, :miss, state}
    end
  end

  @impl true
  def handle_cast({:put, key, value}, %{store: store, ttl: ttl} = state) do
    expires_at = System.monotonic_time(:millisecond) + ttl
    {:noreply, %{state | store: Map.put(store, key, {value, expires_at})}}
  end

  @impl true
  def handle_info(:cleanup, %{store: store} = state) do
    now = System.monotonic_time(:millisecond)
    cleaned = Map.filter(store, fn {_k, {_v, exp}} -> exp > now end)
    schedule_cleanup(state.ttl)
    {:noreply, %{state | store: cleaned}}
  end

  defp schedule_cleanup(ttl), do: Process.send_after(self(), :cleanup, ttl)
end
```

#### Supervisor
```elixir
defmodule App.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      App.Repo,
      {Phoenix.PubSub, name: App.PubSub},
      App.Cache,
      {Task.Supervisor, name: App.TaskSupervisor},
      AppWeb.Endpoint,
    ]

    opts = [strategy: :one_for_one, name: App.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
```

### Error Handling
```elixir
defmodule App.Error do
  @type t :: %__MODULE__{
    code: atom(),
    message: String.t(),
    details: map()
  }

  defexception [:code, :message, :details]

  def not_found(resource, id) do
    %__MODULE__{
      code: :not_found,
      message: "#{resource} #{id} not found",
      details: %{resource: resource, id: id}
    }
  end

  def validation(errors) when is_map(errors) do
    %__MODULE__{
      code: :validation,
      message: "Validation failed",
      details: errors
    }
  end
end

# with for clean error pipelines
defmodule App.UserService do
  def create_user(params) do
    with {:ok, validated} <- validate(params),
         {:ok, user} <- App.Repo.insert(User.changeset(%User{}, validated)),
         :ok <- send_welcome_email(user) do
      {:ok, user}
    end
  end
end
```

### Testing with ExUnit
```elixir
defmodule App.UserServiceTest do
  use App.DataCase, async: true

  alias App.{User, UserService}

  describe "create_user/1" do
    test "creates user with valid params" do
      params = %{name: "Alice", email: "alice@test.com"}

      assert {:ok, %User{} = user} = UserService.create_user(params)
      assert user.name == "Alice"
      assert user.email == "alice@test.com"
      assert user.role == :viewer
    end

    test "returns error for invalid email" do
      params = %{name: "Bob", email: "invalid"}

      assert {:error, %Ecto.Changeset{} = changeset} = UserService.create_user(params)
      assert "is invalid" in errors_on(changeset).email
    end

    test "returns error for duplicate email" do
      insert(:user, email: "taken@test.com")
      params = %{name: "Charlie", email: "taken@test.com"}

      assert {:error, changeset} = UserService.create_user(params)
      assert "has already been taken" in errors_on(changeset).email
    end
  end
end
```

### Phoenix 1.7 / LiveView
```elixir
# LiveView with streams (Phoenix 1.7+)
defmodule AppWeb.UserLive.Index do
  use AppWeb, :live_view

  @impl true
  def mount(_params, _session, socket) do
    if connected?(socket), do: App.PubSub.subscribe("users")

    {:ok,
     socket
     |> assign(:page_title, "Users")
     |> stream(:users, App.Users.list_users())}
  end

  @impl true
  def handle_event("delete", %{"id" => id}, socket) do
    user = App.Users.get_user!(id)
    {:ok, _} = App.Users.delete_user(user)
    {:noreply, stream_delete(socket, :users, user)}
  end

  @impl true
  def handle_info({:user_created, user}, socket) do
    {:noreply, stream_insert(socket, :users, user, at: 0)}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <.header>Users</.header>
    <.table id="users" rows={@streams.users}>
      <:col :let={{_id, user}} label="Name"><%= user.name %></:col>
      <:col :let={{_id, user}} label="Email"><%= user.email %></:col>
      <:action :let={{id, user}}>
        <.link phx-click="delete" phx-value-id={user.id} data-confirm="Are you sure?">
          Delete
        </.link>
      </:action>
    </.table>
    """
  end
end
```

### Ecto Patterns
```elixir
defmodule App.User do
  use Ecto.Schema
  import Ecto.Changeset

  schema "users" do
    field :name, :string
    field :email, :string
    field :role, Ecto.Enum, values: [:admin, :editor, :viewer], default: :viewer
    has_many :posts, App.Post

    timestamps(type: :utc_datetime)
  end

  def changeset(user, attrs) do
    user
    |> cast(attrs, [:name, :email, :role])
    |> validate_required([:name, :email])
    |> validate_format(:email, ~r/^[^\s]+@[^\s]+$/)
    |> unique_constraint(:email)
    |> validate_length(:name, min: 2, max: 255)
  end
end
```

## Anti-Patterns
- Spawning unsupervised processes instead of using `Task.Supervisor`
- Sending large data in GenServer messages instead of using ETS or references
- Blocking GenServer with long-running operations (use `Task.async`)
- Not using `async: true` in test modules when tests are independent
- String keys in maps for internal data instead of atoms
- Deeply nested `case`/`cond` instead of multi-clause functions

## Framework Integration
- **Phoenix 1.7**: Component-based views with HEEx, streams for efficient list rendering, PubSub for real-time
- **LiveView**: Server-rendered interactive UI with streams, async assigns, and hook-based JS interop
- **Ecto**: Composable query builder with changesets, multi-tenancy, and embedded schemas
