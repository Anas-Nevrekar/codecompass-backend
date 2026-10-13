# CodeCompass Backend

CodeCompass is an AI-powered codebase onboarding assistant. This repository contains the Node.js backend foundation; the future React/Vite frontend will live in its own repository and communicate with this service through REST APIs. The frontend will configure its API base URL independently.

## Phase 1 architecture

The API uses Express with ES modules. `src/app.js` configures HTTP middleware and routes, `src/server.js` validates configuration and manages the process lifecycle, and health/readiness controllers delegate infrastructure checks to a service. Prisma is the shared PostgreSQL client; ioredis is the shared Redis connection. The Prisma schema deliberately has no application models yet. The initial versioned migration records the foundation without creating tables.

The stack is Node.js, Express, PostgreSQL, Prisma, Redis, BullMQ (installed for future queue work; no queues or workers are created in this phase), Docker Compose, and npm.

## Prerequisites

- Node.js 20 or newer and npm
- Docker with the Docker Compose plugin

## Install and configure

From this repository directory:

```bash
npm install
cp .env.example .env
```

`.env.example` contains local development values only. `.env` is ignored by Git. For local Docker development, keep the database URL host as `localhost`; the Compose services publish PostgreSQL and Redis ports to the host.

## Start PostgreSQL and Redis

```bash
docker compose up -d
docker compose ps
```

Stop the services while preserving the PostgreSQL data volume with:

```bash
docker compose down
```

To intentionally erase the local database and start fresh, run `docker compose down -v` and then `docker compose up -d`. The named `postgres_data` volume persists across ordinary shutdowns. Redis persistence is not enabled because Phase 1 does not store queue state.

Compose reads `.env` for credentials. If you change `POSTGRES_USER`, `POSTGRES_PASSWORD`, or `POSTGRES_DB`, also update `DATABASE_URL` to match. Configure `POSTGRES_PORT` or `REDIS_PORT` if the default host ports are occupied; update the corresponding connection URL when changing a port.

## Database commands

```bash
npm run db:validate
npm run db:migrate
npm run db:status
```

`db:migrate` runs Prisma's development migration workflow. To apply committed migrations in a deployment-like environment, use `npm run db:deploy`. The foundation migration is intentionally empty because Phase 1 defines no application tables.

## Run the API

```bash
npm run dev
```

For a non-watch run, use `npm start`. The API listens on `PORT` (3000 by default). The API can start without PostgreSQL or Redis; `/api/ready` reports their live state. Set `FRONTEND_URL` to the exact local frontend origin (default `http://localhost:5173`). In production, only that configured origin is allowed; requests without an Origin header remain usable for health probes and server-to-server calls.

## Endpoints

```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/ready
```

`GET /api/health` returns HTTP 200 when the API process is running and does not contact infrastructure. `GET /api/ready` runs `SELECT 1` through Prisma and `PING` against Redis. It returns HTTP 200 only when both checks succeed, otherwise HTTP 503 with each dependency marked `error`. Unknown routes return a JSON 404.

## Tests

```bash
npm test
```

The test suite uses Node's built-in test runner and in-memory dependency doubles, so these API and configuration checks do not require Docker. Real readiness checks require PostgreSQL and Redis; use `/api/ready` after starting Compose to verify those live connections.

## Troubleshooting

- **PostgreSQL connection refused:** check `docker compose ps`, wait for its health check, and confirm `DATABASE_URL` uses the published host port and matching credentials.
- **Redis connection refused:** confirm the Redis service is healthy and `REDIS_URL` uses the published host port.
- **Port already in use:** change `PORT` for the API, or set `POSTGRES_PORT` / `REDIS_PORT` and update `DATABASE_URL` / `REDIS_URL` accordingly.
- **Prisma schema or migration errors:** run `npm run db:validate`, ensure `.env` is present, and check `DATABASE_URL`.
- **Frontend CORS errors:** set `FRONTEND_URL` to the frontend's exact origin, including scheme and port, then restart the backend.

## Scope

Phase 1 establishes the Express API process, configuration, health and dependency readiness endpoints, PostgreSQL/Prisma and Redis connectivity, local Compose services, migration workflow, and automated tests. Authentication, repository import, cloning, indexing, parsing, embeddings, search, LLM/RAG, citations, visualizations, and the frontend are later phases.
