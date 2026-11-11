# Contributing

Thanks for your interest in improving this project.

## Workflow
1. Fork the repository and create a feature branch from `main`.
2. Keep changes focused — one concern per pull request.
3. Run the project’s lint/test/build checks locally before opening a PR.
4. Describe the problem, approach, and test evidence in the PR body.

## Commit messages
Use concise, present-tense summaries:
- `feat: add service-trace export workbook`
- `fix: prevent invalid session redirect loop`
- `docs: clarify local Postgres restore steps`

## Code style
Match the existing language tooling in the repo (ESLint/Prettier, Ruff, etc.).
Prefer clear names and short functions over clever abstractions.

## Security
Do not commit secrets, API keys, or production dumps. See `SECURITY.md` if present.
