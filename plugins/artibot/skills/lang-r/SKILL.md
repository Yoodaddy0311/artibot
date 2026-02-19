---
name: lang-r
description: "R patterns, tidyverse workflows, ggplot2 visualization, and framework-specific best practices for Shiny and statistical modeling."
level: 2
triggers:
  - "r language"
  - "R language"
  - ".R"
  - ".Rmd"
  - "tidyverse"
  - "ggplot2"
  - "dplyr"
  - "shiny"
  - "quarto"
  - "pipe operator"
  - "tibble"
  - "data.frame"
  - "CRAN"
agents:
  - "persona-backend"
  - "persona-performance"
tokens: "~4K"
category: "language"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# R Patterns & Best Practices

## When This Skill Applies
- Writing or reviewing R 4.4+ code
- Data wrangling with tidyverse (dplyr, tidyr, purrr)
- Data visualization with ggplot2
- Interactive dashboards with Shiny
- Statistical modeling and machine learning
- Reproducible research with Quarto/R Markdown

## Core Guidance

### Modern R Pipe and Functional Patterns
```r
# Native pipe operator (R 4.1+)
result <- mtcars |>
  filter(cyl %in% c(4, 6)) |>
  mutate(
    efficiency = mpg / wt,
    category = case_when(
      mpg > 30 ~ "high",
      mpg > 20 ~ "medium",
      .default = "low"
    )
  ) |>
  summarise(
    mean_mpg = mean(mpg),
    mean_efficiency = mean(efficiency),
    count = n(),
    .by = c(cyl, category)
  ) |>
  arrange(cyl, desc(mean_mpg))

# Lambda syntax with pipe (R 4.1+)
transform_data <- \(df, col) {
  df |>
    mutate(normalized = {{ col }} / max({{ col }}, na.rm = TRUE)) |>
    filter(!is.na(normalized))
}

# Tidy evaluation with embrace {{ }}
summarise_by <- \(data, group_col, value_col) {
  data |>
    summarise(
      mean = mean({{ value_col }}, na.rm = TRUE),
      sd = sd({{ value_col }}, na.rm = TRUE),
      n = n(),
      .by = {{ group_col }}
    )
}

mtcars |> summarise_by(cyl, mpg)
```

### Data Wrangling with tidyverse
```r
library(tidyverse)

# Reading and cleaning data
users <- read_csv("data/users.csv") |>
  janitor::clean_names() |>
  mutate(
    created_at = ymd_hms(created_at),
    email = str_to_lower(str_trim(email)),
    age_group = cut(age, breaks = c(0, 18, 35, 55, Inf),
                    labels = c("youth", "young_adult", "middle", "senior"))
  ) |>
  filter(!is.na(email), str_detect(email, "@"))

# Pivoting and reshaping
monthly_metrics <- sales |>
  pivot_longer(
    cols = starts_with("month_"),
    names_to = "month",
    names_prefix = "month_",
    values_to = "revenue"
  ) |>
  mutate(month = as.integer(month))

# Joining and aggregating
user_summary <- users |>
  left_join(orders, by = "user_id") |>
  summarise(
    total_orders = n(),
    total_revenue = sum(amount, na.rm = TRUE),
    avg_order_value = mean(amount, na.rm = TRUE),
    first_order = min(order_date),
    last_order = max(order_date),
    .by = user_id
  ) |>
  mutate(
    lifetime_days = as.numeric(last_order - first_order),
    is_active = last_order > today() - days(90)
  )

# Nested operations with purrr
models <- mtcars |>
  nest(.by = cyl) |>
  mutate(
    model = map(data, \(df) lm(mpg ~ wt + hp, data = df)),
    summary = map(model, broom::tidy),
    r_squared = map_dbl(model, \(m) summary(m)$r.squared)
  ) |>
  unnest(summary)
```

### Data Visualization with ggplot2
```r
library(ggplot2)

# Publication-quality plot
p <- user_summary |>
  filter(total_orders > 0) |>
  ggplot(aes(x = total_orders, y = total_revenue, color = is_active)) +
  geom_point(alpha = 0.6, size = 2) +
  geom_smooth(method = "lm", se = TRUE, linewidth = 0.8) +
  scale_color_manual(
    values = c("TRUE" = "#2563eb", "FALSE" = "#9ca3af"),
    labels = c("Inactive", "Active")
  ) +
  scale_y_continuous(labels = scales::dollar_format()) +
  labs(
    title = "Customer Value Analysis",
    subtitle = "Revenue by order frequency",
    x = "Total Orders",
    y = "Total Revenue",
    color = "Status",
    caption = paste("Data as of", today())
  ) +
  theme_minimal(base_size = 14) +
  theme(
    legend.position = "top",
    plot.title = element_text(face = "bold"),
    plot.subtitle = element_text(color = "gray50")
  )

ggsave("output/customer_value.png", p, width = 10, height = 6, dpi = 300)

# Faceted visualization
ggplot(mtcars, aes(x = wt, y = mpg)) +
  geom_point(aes(color = factor(gear)), size = 2) +
  geom_smooth(method = "loess", se = FALSE, color = "gray30") +
  facet_wrap(~cyl, scales = "free_y", labeller = label_both) +
  theme_minimal()
```

### Error Handling
```r
# Safe function execution with tryCatch
safe_read <- \(path) {
  tryCatch(
    {
      data <- read_csv(path, show_col_types = FALSE)
      list(ok = TRUE, data = data)
    },
    error = \(e) list(ok = FALSE, error = conditionMessage(e)),
    warning = \(w) {
      data <- suppressWarnings(read_csv(path, show_col_types = FALSE))
      list(ok = TRUE, data = data, warning = conditionMessage(w))
    }
  )
}

# purrr::safely for batch operations
safe_model <- safely(lm)

results <- datasets |>
  map(\(df) safe_model(y ~ x, data = df))

successes <- results |>
  keep(\(r) is.null(r$error)) |>
  map("result")

failures <- results |>
  keep(\(r) !is.null(r$error)) |>
  map("error")

# Assertions for data validation
validate_data <- \(df) {
  stopifnot(
    "Missing required columns" = all(c("id", "value") %in% names(df)),
    "No rows in data" = nrow(df) > 0,
    "Negative values found" = all(df$value >= 0, na.rm = TRUE)
  )
  invisible(df)
}
```

### Testing with testthat
```r
library(testthat)

test_that("summarise_by computes correct means", {
  test_data <- tibble(
    group = c("A", "A", "B", "B"),
    value = c(10, 20, 30, 40)
  )

  result <- summarise_by(test_data, group, value)

  expect_equal(nrow(result), 2)
  expect_equal(result$mean[result$group == "A"], 15)
  expect_equal(result$mean[result$group == "B"], 35)
})

test_that("safe_read handles missing files", {
  result <- safe_read("nonexistent.csv")

  expect_false(result$ok)
  expect_type(result$error, "character")
})

test_that("validate_data rejects invalid input", {
  bad_data <- tibble(wrong_col = 1:3)

  expect_error(validate_data(bad_data), "Missing required columns")
})
```

### Shiny Application
```r
library(shiny)
library(bslib)

ui <- page_sidebar(
  title = "Analytics Dashboard",
  theme = bs_theme(bootswatch = "flatly"),
  sidebar = sidebar(
    selectInput("metric", "Metric",
      choices = c("Revenue" = "revenue", "Orders" = "orders", "Users" = "users")
    ),
    dateRangeInput("dates", "Date Range",
      start = today() - months(3),
      end = today()
    ),
    actionButton("refresh", "Refresh", class = "btn-primary")
  ),
  layout_columns(
    value_box("Total", textOutput("total_value"), showcase = icon("chart-line")),
    value_box("Average", textOutput("avg_value"), showcase = icon("calculator")),
    value_box("Growth", textOutput("growth_pct"), showcase = icon("arrow-trend-up")),
    col_widths = c(4, 4, 4)
  ),
  card(
    card_header("Trend"),
    plotOutput("trend_plot", height = "400px")
  )
)

server <- \(input, output, session) {
  data <- reactive({
    input$refresh
    load_metrics(input$metric, input$dates[1], input$dates[2])
  }) |> bindCache(input$metric, input$dates) |> bindEvent(input$refresh, ignoreNULL = FALSE)

  output$total_value <- renderText(scales::comma(sum(data()$value)))
  output$avg_value <- renderText(scales::comma(mean(data()$value), accuracy = 0.01))
  output$growth_pct <- renderText({
    vals <- data()$value
    pct <- (last(vals) - first(vals)) / first(vals) * 100
    paste0(round(pct, 1), "%")
  })

  output$trend_plot <- renderPlot({
    data() |>
      ggplot(aes(x = date, y = value)) +
      geom_line(color = "#2563eb", linewidth = 1) +
      geom_smooth(method = "loess", alpha = 0.2) +
      scale_y_continuous(labels = scales::comma) +
      labs(x = NULL, y = input$metric) +
      theme_minimal(base_size = 14)
  })
}

shinyApp(ui, server)
```

### Project Structure
```r
# R package / project structure
# project/
#   R/            - function definitions
#   tests/        - testthat tests
#   data-raw/     - data preparation scripts
#   data/         - processed data
#   output/       - generated reports and plots
#   renv.lock     - dependency lockfile
#   .Rprofile     - project setup

# renv for reproducible environments
# renv::init()
# renv::snapshot()
# renv::restore()
```

## Anti-Patterns
- Using `T`/`F` instead of `TRUE`/`FALSE`
- `1:length(x)` instead of `seq_along(x)` (fails when `length(x) == 0`)
- Growing vectors in loops instead of pre-allocating or using `map()`
- Relying on partial argument matching (use full argument names)
- `attach()` for data frames (namespace pollution)
- Not using `{renv}` for dependency management in projects

## Framework Integration
- **tidyverse**: Consistent grammar for data import, wrangling, and visualization with pipe-based workflows
- **ggplot2**: Layered grammar of graphics for publication-quality static and interactive visualizations
- **Shiny + bslib**: Reactive web applications with modern Bootstrap theming, caching, and modular design
