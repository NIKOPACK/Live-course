# Contributing to LiveCourse

Thank you for improving LiveCourse. Use a focused issue or discussion for substantial changes before investing in a large implementation.

## Development setup

```bash
git clone https://github.com/NIKOPACK/livecourse.git
cd livecourse
pnpm install
cp .env.example .env.local
pnpm dev
```

Create a branch from `main`, keep changes scoped, and include tests for changed behavior. Never commit credentials or a populated `.env.local` file.

## Required checks

Run the checks relevant to your change before opening a pull request:

```bash
pnpm test
pnpm lint
pnpm check:i18n-keys
pnpm check
pnpm build
```

Changes to `packages/@livecourse/*` should also pass that package's build, typecheck, and test scripts. Changes to `render-service/` should pass `npm ci`, `npm run typecheck`, and `npm test` in that directory.

## Pull requests

Explain the user-visible result, implementation choices, validation performed, and any migration or compatibility impact. Keep generated files and lockfiles synchronized with their sources, and avoid unrelated formatting or refactors.

By contributing, you agree that your contribution is distributed under the repository's [MIT License](LICENSE).
