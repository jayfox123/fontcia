# server

Node/Express/Prisma backend for fontCIA. Postgres runs via Docker Compose with the [pgvector](https://github.com/pgvector/pgvector) extension, used for the font-matching reference-set's similarity search.

## Setup

```bash
cp .env.example .env
cp .env.test.example .env.test
npm install
docker compose up -d
```

The `vector` extension needs enabling once per database (the migrations also create it via `CREATE EXTENSION IF NOT EXISTS vector`, but a brand-new container needs the databases to exist first):

```bash
docker compose exec -T postgres psql -U fontcia -d fontcia_dev -c "CREATE EXTENSION IF NOT EXISTS vector;"
docker compose exec -T postgres psql -U fontcia -d fontcia_test -c "CREATE EXTENSION IF NOT EXISTS vector;"
npx prisma migrate deploy
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_test" npx prisma migrate deploy
```

`EMBEDDING_SERVICE_URL` (set in both `.env` files) must point at a running instance of `../embedding-service` for `/font-matches` and the two scripts below to work — see that directory's own README.

**If you're reusing an existing Postgres data volume that predates the pgvector image** (i.e. it was created under a plain `postgres:16` container before this project switched images), you may hit `collation version mismatch` errors from `prisma migrate dev`'s shadow-database creation. Fix with:

```bash
docker compose exec -T postgres psql -U fontcia -d postgres -c "ALTER DATABASE template1 REFRESH COLLATION VERSION;" -c "ALTER DATABASE postgres REFRESH COLLATION VERSION;" -c "ALTER DATABASE fontcia_dev REFRESH COLLATION VERSION;" -c "ALTER DATABASE fontcia_test REFRESH COLLATION VERSION;"
```

A fresh volume created directly under `pgvector/pgvector:pg16` never hits this.

## Running

```bash
npm run dev          # tsx watch
npm run build && npm run start   # compiled
```

## Tests / typecheck

```bash
npm test
npm run typecheck    # checks both src/ and scripts/ — see tsconfig.scripts.json
```

## Font reference-set scripts

Both require `embedding-service` running (`http://localhost:8000` by default) and, for `evaluate-matching`, this server itself running (`http://localhost:3001` by default, or set `SERVER_URL`):

```bash
npm run build-reference-set   # renders + embeds the curated 100-font catalog into Font/FontEmbedding
npm run evaluate-matching     # measures real top-1/3/5 retrieval accuracy against a held-out sample
```

Both are idempotent (`build-reference-set` upserts on re-run) and print per-font progress plus a final summary.
