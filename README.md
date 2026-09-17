# LiveCourse

LiveCourse is for self-directed learning. You say what you want to learn; one Agent teacher teaches a complete lesson.

[中文说明](README-zh.md) · [Documentation](packages/docs/content/docs/getting-started.mdx) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Development follows [docs/spec/](docs/spec/00-index.md). [docs/LiveCourse_作品简介.md](docs/LiveCourse_作品简介.md) is the public product narrative.

## Current implementation

What runs today is a single lesson:

- Describe a topic or upload materials
- Generate teaching scenes
- One teacher delivers the lesson over full-duplex speech, answers interruptions and returns to the same point, and runs quizzes

Browser storage is the default; optional PostgreSQL persistence is available.

## Requirements

- Node.js 20.9 or newer
- pnpm 10.28

## Local development

```bash
git clone https://github.com/NIKOPACK/livecourse.git
cd livecourse
pnpm install
cp .env.example .env.local
pnpm dev
```

Open `http://localhost:3000`. Configure at least one language-model provider in `.env.local` or through the in-app settings. Provider keys are optional until the corresponding feature is used.

## Production build

```bash
pnpm build
pnpm start
```

Standalone deployments use `node .next/standalone/server.js` instead of
`pnpm start`. Copy `public/` and `.next/static/` into the corresponding paths
inside `.next/standalone/`; the [Dockerfile](Dockerfile) already assembles this
layout. `/api/health` reports the built package version in either startup mode.

For a containerized setup:

```bash
cp .env.example .env.local
docker compose up --build
```

Optional PostgreSQL persistence and video rendering are available through the Compose profiles documented in [docker-compose.yml](docker-compose.yml).

## Validation

The root tests do not load `.env.local` or application credentials. Embedded PostgreSQL
contracts run locally through PGlite. Set `PG_CONTRACT_URL` explicitly only for a
disposable PostgreSQL test database: those optional contract tests truncate their tables.

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm lint
pnpm check:i18n-keys
pnpm check
pnpm build
```

## Repository layout

- `app/` and `components/`: Next.js application and user interface
- `lib/livecourse/`: lesson, session, evidence, realtime, and quiz domain logic
- `packages/@livecourse/`: internal DSL, generation, importer, renderer, and storage packages
- `render-service/`: isolated MP4 rendering service
- `packages/docs/`: documentation site

## License

LiveCourse is distributed under the [MIT License](LICENSE). Third-party and retained upstream notices remain in their respective license files.
