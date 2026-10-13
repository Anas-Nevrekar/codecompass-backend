# CodeCompass Backend

CodeCompass is an AI-powered codebase onboarding assistant. This repository contains the Node.js backend. The React/Vite frontend is maintained separately and communicates with this service through REST APIs.

## Architecture

- Express 5 with JavaScript ES modules.
- PostgreSQL with Prisma models for users, shared public repository metadata, and user/repository imports.
- GitHub OAuth App web flow, with a signed, HTTP-only CodeCompass session cookie.
- GitHub REST API for profile identity and public repository metadata. OAuth access tokens are discarded after profile lookup.
- Redis and BullMQ remain from the Phase 1 foundation; Phase 2 does not use queues.

Repository import stores metadata only. This MVP does not clone or index source code and does not support private repositories.

## Prerequisites

- Node.js 20 or newer and npm
- Docker with the Docker Compose plugin
- A GitHub OAuth App for end-to-end sign-in

## Install and configure

```bash
npm install
cp .env.example .env
```

Set the local OAuth session secret to a random value of at least 32 bytes. For example:

```bash
openssl rand -base64 32
```

Set `SESSION_SECRET` to the generated value. Configure `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL` as described below. Basic health checks and the API process can run when OAuth values are missing; OAuth requests then return `OAUTH_CONFIGURATION_ERROR`.

`.env` is ignored by Git. Never commit credentials.

## Register a GitHub OAuth App

1. In GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set the homepage URL to `http://localhost:5173` for local development.
3. Set the authorization callback URL to `http://localhost:3000/api/auth/github/callback`.
4. Register the app, then copy its client ID and generate a client secret into `.env`.
5. Keep `GITHUB_CALLBACK_URL` identical to the registered callback URL.

In production, use HTTPS for the callback and set `FRONTEND_URL` to the exact deployed frontend origin. GitHub sign-in requests only the `read:user` scope. No repository scope is requested; public repository metadata is read from GitHub's public API without retaining the OAuth access token.

## Start local infrastructure and apply migrations

```bash
docker compose up -d
docker compose ps
npm run db:validate
npm run db:migrate
```

The PostgreSQL volume persists when services stop. Stop containers without deleting database data with `docker compose down`. To intentionally erase local data, run `docker compose down -v`.

## Start the API

```bash
npm run dev
```

Use `npm start` for a non-watch run. The server listens on `PORT` (3000 by default). `FRONTEND_URL` must be the exact frontend origin (default `http://localhost:5173`). CORS allows credentials only from that origin. Browser calls that use the session cookie must include credentials, for example `fetch(url, { credentials: 'include' })`. State-changing browser requests (`POST /api/auth/logout` and `POST /api/repositories/import`) must send that exact `Origin`; CORS alone is not treated as CSRF protection.

## API contract

All API paths are relative to `http://localhost:3000` in local development.

### Health

- `GET /api/health` returns `200` while the process is running; it does not require infrastructure.
- `GET /api/ready` runs a PostgreSQL query and Redis `PING`; it returns `503` if either dependency is unavailable.

### Authentication

- `GET /api/auth/github` starts OAuth and redirects to GitHub. The backend creates a short-lived, signed state cookie and requests `read:user`.
- `GET /api/auth/github/callback` validates state, exchanges the authorization code server-to-server, validates the GitHub profile, upserts a user by GitHub numeric ID, sets the application cookie, then redirects to `/dashboard` on the frontend. Failures redirect to `/auth/error?code=...` with a stable error code.
- `GET /api/auth/me` requires a valid session cookie. It returns `200` with `{ "authenticated": true, "user": { "id", "githubUsername", "displayName", "avatarUrl", "profileUrl" } }`; without a valid session it returns `401` with `UNAUTHENTICATED`.
- `POST /api/auth/logout` requires the configured frontend `Origin`, clears the session cookie, and returns `{ "success": true }`.

The application cookie is HTTP-only, `SameSite=Lax`, scoped to `/api`, and `Secure` in production. Sessions are signed HS256 JWTs that expire after seven days. Logout clears the browser cookie; because sessions are stateless, a previously copied token remains valid until expiry. Do not store session or GitHub tokens in browser storage.

### Public repository metadata

- `POST /api/repositories/import` requires a valid session and the configured frontend `Origin`. Request JSON: `{ "url": "https://github.com/owner/repository" }`. A new import returns `201` with code `REPOSITORY_IMPORTED`; an existing import by the same user returns `200` with code `REPOSITORY_ALREADY_IMPORTED` and `alreadyImported: true`. The response includes stored metadata: repository ID, owner, name, full name, HTML URL, description, default branch, language, visibility, star/fork counts, GitHub creation date, and metadata update date.
- `GET /api/repositories` requires a valid session and returns only the current user's imports, newest first, as `{ "repositories": [...] }`.

Repository URLs must be HTTPS URLs on exactly `github.com` with an owner and repository path. Trailing slash and `.git` suffix are accepted. Query strings, fragments, credentials, other hosts, and extra path segments are rejected. GitHub repository metadata is fetched from the fixed `api.github.com/repos/{owner}/{repo}` endpoint. The same GitHub repository is stored once and can be associated with multiple users; each user's association is unique.

### Errors

Errors use `{ "error": { "code": "...", "message": "..." } }`. Relevant codes include `UNAUTHENTICATED`, `INVALID_OAUTH_STATE`, `OAUTH_CONFIGURATION_ERROR`, `OAUTH_DENIED`, `OAUTH_PROVIDER_ERROR`, `INVALID_REPOSITORY_URL`, `REPOSITORY_NOT_FOUND_OR_INACCESSIBLE`, `PRIVATE_REPOSITORY_UNSUPPORTED`, `GITHUB_API_RATE_LIMIT`, `GITHUB_UPSTREAM_UNAVAILABLE`, `GITHUB_UPSTREAM_ERROR`, `ORIGIN_FORBIDDEN`, and `RATE_LIMITED`. Private and inaccessible repositories are not distinguished when GitHub does not expose their metadata.

Both `/api/auth/github` and its callback have rate limits; imports are limited to 30 attempts per IP per 15 minutes. Requests to GitHub have an 8-second timeout. Neither OAuth credentials, access tokens, nor session tokens are returned in JSON or logged.

## Tests

```bash
npm test
```

The automated tests mock GitHub responses and Prisma access, so they do not need live OAuth credentials or GitHub network access. For manual infrastructure checks, start Compose, apply migrations, run the API, and request `/api/ready`. A full OAuth login requires a correctly configured GitHub OAuth App and matching callback URL.

## Phase 3: background repository indexing

Indexing runs in a separate BullMQ worker. The API stores an `IndexingJob` in PostgreSQL and publishes only its ID to Redis. If Redis is unavailable during publication, the API still returns the persisted queued job; the worker's startup and periodic recovery checks publish any queued database job missing from Redis. BullMQ uses a stable ID (`index-{database job ID}`), so repeated reconciliation does not add duplicate waiting jobs. Jobs stuck in a processing state are reconciled only after five minutes and only when the matching BullMQ job is absent or terminal. PostgreSQL is the source of truth for status and progress.

### Start infrastructure, API, and worker

Run these commands in separate terminals:

```bash
docker compose up -d
npm run db:deploy
npm run dev
npm run worker
```

For local schema development, `npm run db:migrate` creates/applies a migration. `npm run db:deploy` applies checked-in migrations without resetting data. Set the environment values in `.env`; `.env.example` shows the defaults. Git must be installed and available on `PATH` for the worker. The API and worker can be stopped independently. The worker closes BullMQ, Redis, and Prisma connections on `SIGINT` or `SIGTERM`.

### Indexing configuration

| Variable | Default | Purpose |
|---|---:|---|
| `INDEXING_CLONE_TIMEOUT_MS` | `120000` | Maximum duration of one shallow Git clone; the worker terminates the clone process group on timeout. |
| `INDEXING_MAX_REPOSITORY_SIZE_MB` | `500` | Maximum checkout size, including `.git`, checked during cloning every 1.5 seconds and again after clone completion. |
| `INDEXING_MAX_FILE_SIZE_MB` | `2` | Larger supported files are excluded before any file content is read. |
| `INDEXING_WORKER_CONCURRENCY` | `2` | Maximum simultaneous repository jobs in this worker process. Lower it on machines with limited disk or memory. |
| `INDEXING_TEMP_DIR` | system temp `/codecompass-indexing` | Dedicated parent directory for unique temporary clones. Must be outside the application directory; leave blank for the system temporary directory. |
| `INDEXING_STALE_TEMP_DIR_AGE_HOURS` | `24` | Age before an abandoned, CodeCompass-named temporary directory is removed. |
| `INDEXING_RECOVERY_INTERVAL_MS` | `30000` | Periodic database-to-Redis reconciliation interval. |

Checkout size is checked during cloning on a best-effort polling basis; a fast size spike between checks can briefly exceed the configured limit. A post-clone check always runs before file discovery. The worker counts regular-file bytes without following symlinks. The checkout limit is not a hard operating-system disk quota.

### Inventory and lifecycle

`RepositoryFile` stores only the repository ID, relative `/`-separated path, lowercase extension, category, size in bytes, and indexing job ID. It never stores code contents or temporary paths. A unique constraint prevents duplicate paths per repository. Supported extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.py`, `.json`, `.html`, `.css`, `.md`, `.yml`, and `.yaml`.

The worker excludes `.git`, dependencies, virtual environments, generated/build/cache output, common dependency lockfiles, minified/bundled/generated files, symlinks, unsupported file types, and supported files over the per-file limit. It does not execute code or install dependencies. Categories are `source`, `configuration`, `documentation`, `markup`, and `style`.

The job status is one of `queued`, `cloning`, `filtering`, `saving_inventory`, `completed`, or `failed`. Progress advances through 0% queued, 10% cloning, 70% filtering, 90% inventory persistence, and 100% completed. Clone progress is not estimated. On retries, the displayed percentage never decreases; the status and stage show the current attempt. BullMQ makes at most three attempts with exponential backoff starting at one second. Timeouts and temporary Git/filesystem errors can retry. Invalid repository metadata, checkout size-limit failures, a missing Git executable, and clear GitHub “repository not found” errors are permanent. Safe error codes/messages are returned; filesystem paths, raw Git output, and stack traces are not.

The old inventory stays available while a new clone and scan run. Once ready, the worker replaces repository files, records the new commit and timestamp, and marks the job complete inside one PostgreSQL transaction. A failed attempt leaves the last successful inventory and repository metadata unchanged. File inserts are batched within that transaction. Temporary directories are created uniquely under the configured root and removed in a `finally` path. Startup and periodic cleanup only target old direct child directories with the `codecompass-index-` prefix; active directories have an owner PID marker and are skipped across worker processes.

### Indexing API

All endpoints require the existing session cookie. Repository endpoints also require an import association for the signed-in user. State-changing indexing requests require the configured frontend `Origin`.

- `POST /api/repositories/{repositoryId}/index` returns `202` with `{ "success": true, "alreadyRunning": false, "job": { "id", "repositoryId", "status", "progress", "stage", "message", "discoveredFileCount", "eligibleFileCount", "excludedFileCount", "attemptCount", "maxAttempts", "error", "startedAt", "completedAt", "createdAt", "updatedAt" } }`. A repeated request for an active repository job returns `200` with `alreadyRunning: true` and that job. The request never waits for cloning.
- `GET /api/indexing-jobs/{jobId}` returns `{ "job": { ... } }` using the same safe status fields. Jobs are visible only to a user associated with their repository.
- `GET /api/repositories/{repositoryId}/indexing-status` returns `{ "repositoryId", "latestJob", "lastSuccessfulIndex" }`; `lastSuccessfulIndex` is `null` before the first successful run.
- `GET /api/repositories` retains its existing user-scoped list and adds nullable latest status/job ID and last-successful commit/time/file-count metadata.

Redis failures during recovery are logged and retried on the next interval. For troubleshooting, check `/api/ready`, confirm PostgreSQL migrations are applied, confirm Redis is reachable, and check that `git --version` works in the worker's environment. Repositories over the checkout limit fail with `REPOSITORY_SIZE_LIMIT_EXCEEDED`; individual oversized files are counted as excluded.

## Phase scope

Phase 1 health/readiness and infrastructure behavior remains available. Phase 2 adds GitHub OAuth, persistent users, cookie sessions, URL validation, public repository metadata import, and user-scoped listing. Phase 3 adds background shallow cloning and persistent file inventory. AST parsing, code chunking, embeddings, private repository access, search, LLM/RAG, and frontend implementation remain future work.
