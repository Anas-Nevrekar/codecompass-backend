# CodeCompass Backend

CodeCompass is an AI-powered codebase onboarding assistant. This repository contains the Node.js backend. The React/Vite frontend is maintained separately and communicates with this service through REST APIs.

## Architecture

- Express 5 with JavaScript ES modules.
- PostgreSQL with Prisma models for users, shared public repository metadata, and user/repository imports.
- GitHub OAuth App web flow, with a signed, HTTP-only CodeCompass session cookie.
- GitHub REST API for profile identity and public repository metadata. OAuth access tokens are discarded after profile lookup.
- Redis and BullMQ remain from the Phase 1 foundation; Phase 2 does not use queues.

Repository import stores metadata only. This MVP does not clone or index source code and does not support private repositories.

## Phase 5: embeddings and hybrid search

Phase 5 embeds Phase 4 `CodeChunk` records with the local Ollama model `qwen3-embedding:0.6b` (1024 dimensions). Code documents include language, structure, symbol, relative path, and source. Search queries use the instruction prefix `Instruct: Given a question, retrieve relevant code snippets` followed by `Query: ...`. Ollama is called by the backend at `${EMBEDDING_BASE_URL}/api/embed`; the frontend never calls Ollama directly.

PostgreSQL runs the pgvector-compatible `pgvector/pgvector:pg17` image. The migration enables the `vector` extension and creates a `vector(1024)` column. Prisma cannot expose this PostgreSQL type as a normal scalar, so a Prisma `Unsupported` field documents the schema and parameterized Prisma raw SQL handles inserts and cosine search. Search uses exact cosine distance (`<=>`) without an approximate index while repositories are small.

Start the API and the embedding worker in separate terminals (`npm run dev` and `npm run embedding-worker`). After parsing, request `POST /api/repositories/:repositoryId/embeddings`, then poll `GET /api/embedding-jobs/:jobId`. The worker persists progress in PostgreSQL, batches up to 16 chunks by default, uses concurrency 1, and marks inputs over `EMBEDDING_MAX_INPUT_CHARS` as failed instead of silently truncating them. Redis/BullMQ carries only the embedding job ID. To check provider/model availability, use authenticated `GET /api/embeddings/health`; the check does not download the model. Install the model yourself with `ollama pull qwen3-embedding:0.6b` if it is missing.

`POST /api/repositories/:repositoryId/search` accepts `{ "query": "Where is user authentication handled?", "limit": 10 }`. Vector search uses cosine distance, while keyword search combines PostgreSQL `websearch_to_tsquery('simple', ...)` with parameterized substring matching for identifiers and file paths. Results are merged by Reciprocal Rank Fusion: `score = Σ 1 / (60 + rank)`. The response contains code metadata, `vectorRank`, `keywordRank`, `rrfScore`, and `matchedBy`; it does not generate an LLM answer.

Search is limited to the repository's latest successful parsing job. Embeddings belong to their source chunks and cascade away if those chunks are deleted during a later successful parse. Before calling Ollama, the worker copies an existing vector for an unchanged source hash, path, language, structure, symbol, and model configuration; changed or new chunks are embedded. If a newer parsing job has only partial success, it is treated as the latest completed parse, and search remains scoped to that parsing job.

Apply schema changes with `npm run db:generate` and `npm run db:deploy`; these commands preserve existing records. For local Docker, PostgreSQL may need recreation with the new pgvector image while retaining the named `postgres_data` volume; do not use `docker compose down -v`. The embedding variables and deployment-friendly base URL are listed in `.env.example`; production can set `EMBEDDING_BASE_URL=http://ollama:11434` on a private Docker network and persist Ollama model files in a volume.

Normal unit tests mock Ollama: `npm test`. The separate live check `npm run test:ollama` requires the configured model and running Ollama. No LLM is needed for vector search, keyword search, RRF, or the search endpoint.

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
| `INDEXING_REPOSITORY_STORAGE_DIR` | `../codecompass-repository-storage` beside the backend directory | Persistent root for completed clones. Must be a dedicated directory outside the application directory and separate from `INDEXING_TEMP_DIR`. |
| `INDEXING_STALE_TEMP_DIR_AGE_HOURS` | `24` | Age before an abandoned, CodeCompass-named temporary directory is removed. |
| `INDEXING_RECOVERY_INTERVAL_MS` | `30000` | Periodic database-to-Redis reconciliation interval. |

Checkout size is checked during cloning on a best-effort polling basis; a fast size spike between checks can briefly exceed the configured limit. A post-clone check always runs before file discovery. The worker counts regular-file bytes without following symlinks. The checkout limit is not a hard operating-system disk quota.

### Inventory and lifecycle

`RepositoryFile` stores only the repository ID, relative `/`-separated path, lowercase extension, category, size in bytes, and indexing job ID. It never stores code contents or temporary paths. A unique constraint prevents duplicate paths per repository. Supported extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.py`, `.json`, `.html`, `.css`, `.md`, `.yml`, and `.yaml`.

The worker excludes `.git`, dependencies, virtual environments, generated/build/cache output, common dependency lockfiles, minified/bundled/generated files, symlinks, unsupported file types, and supported files over the per-file limit. It does not execute code or install dependencies. Categories are `source`, `configuration`, `documentation`, `markup`, and `style`.

The job status is one of `queued`, `cloning`, `filtering`, `saving_inventory`, `completed`, or `failed`. Progress advances through 0% queued, 10% cloning, 70% filtering, 90% inventory persistence, and 100% completed. Clone progress is not estimated. On retries, the displayed percentage never decreases; the status and stage show the current attempt. BullMQ makes at most three attempts with exponential backoff starting at one second. Timeouts and temporary Git/filesystem errors can retry. Invalid repository metadata, checkout size-limit failures, a missing Git executable, and clear GitHub “repository not found” errors are permanent. Safe error codes/messages are returned; filesystem paths, raw Git output, and stack traces are not.

The old inventory and retained clone stay available while a new clone and scan run. A completed candidate is moved into `<INDEXING_REPOSITORY_STORAGE_DIR>/repositories/<repository UUID>/<indexing job UUID>`. The worker then switches the inventory, commit SHA, timestamp, relative storage reference, and completed job state together in one PostgreSQL transaction. Only after that commit does it remove the superseded clone. If cloning, filtering, filesystem preparation, or the transaction fails, the previous successful clone and inventory remain current. The database stores this generated relative reference only; API responses do not expose it or an absolute server path.

Temporary clones remain under `INDEXING_TEMP_DIR` and are deleted after each attempt. Periodic stale-temp cleanup is restricted to its `codecompass-index-` children. Retained clones are outside that root and are never removed on normal completion or worker shutdown. At worker startup, old unreferenced version directories left by a crash are removed after checking database references and live-process markers. Current retained clones are not subject to age cleanup. Successful clones contain the actual checkout, including `.git`, and no source contents are stored in PostgreSQL.

Retained clones consume disk space approximately in proportion to repository checkout size. Keep enough space available for the current clone plus a replacement during re-indexing; old versions are removed only after the new inventory and path are committed. CodeCompass does not silently delete current clones to reclaim space. To inspect a missing clone, compare the repository's `retainedStoragePath` and `lastIndexedCommitSha` in PostgreSQL, verify that the referenced directory exists under the configured storage root, and check worker logs for filesystem or cleanup errors. Re-run indexing if the committed directory is genuinely missing.

The checked-in Docker Compose file runs only PostgreSQL and Redis; the documented API and worker commands run on the host, so the default sibling storage directory persists across Compose container recreation. If you later run the worker in a container, mount persistent host storage at the same path in every worker container and set `INDEXING_REPOSITORY_STORAGE_DIR` to that mount, for example:

```yaml
services:
  backend-worker:
    volumes:
      - ./codecompass-repository-storage:/var/lib/codecompass/repositories
    environment:
      INDEXING_REPOSITORY_STORAGE_DIR: /var/lib/codecompass/repositories
```

Do not rely on a container's writable layer for retained clones. The API does not need access to clone files; the indexing worker and future parsing worker do.

### Indexing API

All endpoints require the existing session cookie. Repository endpoints also require an import association for the signed-in user. State-changing indexing requests require the configured frontend `Origin`.

- `POST /api/repositories/{repositoryId}/index` returns `202` with `{ "success": true, "alreadyRunning": false, "job": { "id", "repositoryId", "status", "progress", "stage", "message", "discoveredFileCount", "eligibleFileCount", "excludedFileCount", "attemptCount", "maxAttempts", "error", "startedAt", "completedAt", "createdAt", "updatedAt" } }`. A repeated request for an active repository job returns `200` with `alreadyRunning: true` and that job. The request never waits for cloning.
- `GET /api/indexing-jobs/{jobId}` returns `{ "job": { ... } }` using the same safe status fields. Jobs are visible only to a user associated with their repository.
- `GET /api/repositories/{repositoryId}/indexing-status` returns `{ "repositoryId", "latestJob", "lastSuccessfulIndex" }`; `lastSuccessfulIndex` is `null` before the first successful run.
- `GET /api/repositories` retains its existing user-scoped list and adds nullable latest status/job ID and last-successful commit/time/file-count metadata.

Redis failures during recovery are logged and retried on the next interval. For troubleshooting, check `/api/ready`, confirm PostgreSQL migrations are applied, confirm Redis is reachable, and check that `git --version` works in the worker's environment. Repositories over the checkout limit fail with `REPOSITORY_SIZE_LIMIT_EXCEEDED`; individual oversized files are counted as excluded.

## Phase 4 AST parsing

The parsing endpoint reuses the retained clone and persisted inventory from Phase 3; it never clones a repository. Start parsing with `POST /api/repositories/{repositoryId}/parse` (session cookie and frontend Origin required), then poll `GET /api/parsing-jobs/{jobId}`. Both endpoints are user scoped. Status includes stage, progress, file counts, chunk count, and safe error text. A repository can have only one active parsing job, enforced by a partial unique index. After a successful parse, re-indexing creates a new source snapshot and enables **Re-parse Repository**. The previous indexed files and chunks remain available while the new parse runs; they are replaced only after every new file result is persisted without read/parse failures. If parsing has file failures, the previous data and retained clone remain available for retry.

Run the separate worker with `npm run parse-worker` after applying `npm run db:deploy`. Parsing queue payloads contain only the parsing job ID. The worker periodically recovers missing queue entries and requeues stale interrupted jobs using the stable database job ID. It loads the inventory in file order, enforces the existing `INDEXING_MAX_FILE_SIZE_MB` limit, skips after 10,000 files, and processes files sequentially to bound memory. It supports JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`), TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`), and Python (`.py`), extracting functions, classes, imports, and variable/assignment declarations. Imports include basic module and imported-name metadata. Line ranges are one-based; source text is the exact syntax-node text. Unsupported formats are skipped.

Parsing jobs, chunks, and per-file outcomes are stored in PostgreSQL. Chunks belong to a parsing job. Re-indexing versions the file inventory so old parsed chunks survive until a replacement parse commits; retrying the same parsing job removes and rewrites only its own chunks. Tree-sitter recovers nodes from malformed files, and individual read/parse failures are recorded while processing continues. After chunk and file outcomes persist and the job reaches a completed terminal state with no failed files, the worker removes older inventory versions in the same database transaction and then removes the retained clone through the existing safe storage-root cleanup function. Failed file reads preserve the older results and retained clone for retry. Use the same `INDEXING_REPOSITORY_STORAGE_DIR` setting as Phase 3. The runtime and grammar packages are `tree-sitter` 0.21.1, `tree-sitter-javascript` 0.23.1, `tree-sitter-typescript` 0.23.2, and `tree-sitter-python` 0.23.4.

Run parser tests with `npm test`. Apply schema changes with `npm run db:deploy` in deployed environments or `npm run db:migrate` locally; no database reset is required.

## Phase 6: grounded codebase question answering

`POST /api/repositories/{repositoryId}/ask` accepts `{ "question": "...", "stream": false }`. It requires the existing session cookie and the configured frontend `Origin`. The endpoint reuses Phase 5 hybrid retrieval, then sends only the ranked source chunks that fit the configured context budget to Gemini. It validates returned citation IDs against those retrieved chunks and constructs paths, line ranges, and source from the stored chunk metadata. No conversation history is persisted; every question is stateless and retrieves fresh evidence.

Configure `LLM_PROVIDER=gemini`, `LLM_API_KEY`, `LLM_MODEL=gemini-3.8-flash`, `LLM_MAX_OUTPUT_TOKENS`, `LLM_REQUEST_TIMEOUT_MS`, and the `RAG_*` limits in `.env`. The Gemini key stays on the backend and is never returned to the client. Set `RAG_ENABLE_STREAMING=true` to allow `stream: true`; that request returns SSE events named `start`, `token`, `citations`, `complete`, and `error`. Citations and source locations are sent only after evidence-ID validation.

Answer requests send the user's question and retrieved repository source code to Google's hosted Gemini API. Do not use this feature with confidential, private, proprietary, credential-containing, or otherwise sensitive repository content. Gemini free-tier eligibility and quotas can change; check Google's current [Gemini API pricing and limits](https://ai.google.dev/gemini-api/docs/pricing) and do not assume unlimited free usage. The selected model's context limits are documented in Google's [Gemini 3.8 Flash model reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

## Phase scope

Phase 1 health/readiness and infrastructure behavior remains available. Phase 2 adds GitHub OAuth, persistent users, cookie sessions, URL validation, public repository metadata import, and user-scoped listing. Phase 3 adds background shallow cloning and persistent file inventory. Phase 4 adds AST parsing and code chunk persistence. Phase 5 adds local embeddings and hybrid retrieval. Phase 6 adds stateless Gemini-backed, evidence-grounded question answering. Frontend implementation remains future work.
