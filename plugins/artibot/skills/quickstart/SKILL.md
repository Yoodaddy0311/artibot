---
name: quickstart
description: |
  Interactive first-run quickstart guide with project type detection and command suggestions.
  Auto-activates when: new project onboarding, first-time user setup, getting started requests.
  Triggers: quickstart, getting started, first run, new project, onboarding, welcome, setup
platforms: [claude-code]
level: 1
triggers:
  - "quickstart"
  - "getting started"
  - "first run"
  - "new project"
  - "onboarding"
  - "welcome"
  - "setup"
agents:
  - "orchestrator"
tokens: "~1K"
category: "onboarding"
---

# Interactive Quickstart Guide

## When This Skill Applies
- First time a user interacts with Artibot in a new project
- User explicitly asks for help getting started
- New project onboarding and setup guidance needed
- User is unfamiliar with available commands

## Core Guidance

### 1. Project Detection
Scan the current working directory for configuration files to determine the project type:
- `package.json` -> Node.js (suggest: load, analyze, implement)
- `pyproject.toml` -> Python (suggest: load, analyze, test)
- `Cargo.toml` -> Rust (suggest: load, analyze, build)
- `go.mod` -> Go (suggest: load, analyze, test)
- `pom.xml` / `build.gradle` -> Java (suggest: load, analyze, build)

### 2. Command Suggestions
Suggest the 3 most relevant commands based on detected project type. Always include `/sc load` as the first recommendation.

### 3. Welcome Message
Display a clear, formatted welcome message with:
- Detected project type
- Three recommended commands
- Quick tips for navigation

## Quick Reference

| Project | Config File | Top Commands |
|---------|-------------|-------------|
| Node.js | package.json | load, analyze, implement |
| Python | pyproject.toml | load, analyze, test |
| Rust | Cargo.toml | load, analyze, build |
| Go | go.mod | load, analyze, test |
| Java | pom.xml | load, analyze, build |
