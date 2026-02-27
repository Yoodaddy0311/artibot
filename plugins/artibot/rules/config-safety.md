---
paths:
  - "**/*.json"
  - "**/*.yml"
  - "**/*.yaml"
  - "**/*.toml"
  - "**/*.env*"
  - "**/Dockerfile*"
  - "**/.github/**"
---

# Artibot Config & Infrastructure Rules

## JSON/YAML Edits
- Read the full file before editing (configs break on partial understanding)
- Validate JSON syntax after editing (trailing commas, missing brackets)
- Preserve existing formatting and indentation style
- Never remove fields you don't understand

## Secret Protection
- .env files: NEVER commit, ensure in .gitignore
- API keys in config: use `${ENV_VAR}` placeholders, not raw values
- Credentials: reference secret manager or env vars only
- Audit: check `git diff --cached` for secrets before commit

## Version Files
- package.json: keep version in sync with plugin.json and artibot.config.json
- Lock files: commit them (package-lock.json, yarn.lock, pnpm-lock.yaml)
- Don't manually edit lock files

## CI/CD Safety
- Test pipeline changes in feature branch first
- Dockerfile: pin base image versions (not `:latest`)
- GitHub Actions: pin action versions with SHA, not tags
