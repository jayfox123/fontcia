# Backend API Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a standalone Express + Prisma + Postgres backend server providing email/password auth (JWT access tokens + rotating, server-revocable refresh tokens), saved-fonts persistence, and scan logging — fully independent of the extension, testable via its own suite and `curl`.

**Architecture:** A new top-level `server/` directory, its own npm package (separate from the extension's `package.json`), following the same layered split the extension already uses: pure logic (password hashing, JWT) → middleware (auth, CORS, rate-limiting, error handling) → routes (auth, saved-fonts, scans) → app assembly. Real Postgres via Docker Compose for both dev and test, no database mocking.

**Tech Stack:** Node.js, Express, Prisma, PostgreSQL, JWT (`jsonwebtoken`), `bcryptjs`, `express-rate-limit`, `cors`, Vitest + `supertest`.

---

## File Structure

```
server/
  package.json, tsconfig.json, vitest.config.ts
  .env.example, .env.test.example
  docker-compose.yml
  prisma/schema.prisma
  src/
    app.ts, index.ts, env.ts
    lib/prisma.ts, lib/password.ts, lib/jwt.ts
    middleware/cors.ts, require-auth.ts, optional-auth.ts, auth-rate-limit.ts, error-handler.ts
    routes/auth.ts, saved-fonts.ts, scans.ts
  tests/
    helpers/load-test-env.ts, reset-db.ts
    db-setup.test.ts, password.test.ts, jwt.test.ts, auth.test.ts, saved-fonts.test.ts, scans.test.ts
```

This is entirely new — nothing under the existing `src/`, `tests/`, `package.json` (the extension's) is touched by this plan.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`
- Create: `server/.env.example`, `server/docker-compose.yml`
- Create: `server/src/app.ts`, `server/src/index.ts`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "fontcia-server",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@prisma/client": "^6.1.0",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.1",
    "jsonwebtoken": "^9.0.2"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^22.7.0",
    "@types/supertest": "^6.0.2",
    "prisma": "^6.1.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run (from `server/`): `npm install`
Expected: installs cleanly, creates `server/node_modules/` and `server/package-lock.json`.

- [ ] **Step 3: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create `server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/helpers/load-test-env.ts'],
  },
});
```

(`tests/helpers/load-test-env.ts` doesn't exist yet — that's fine, it's created in Task 2, before any test file that needs it actually runs.)

- [ ] **Step 5: Create `server/.env.example`**

```
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_dev"
JWT_SECRET="replace-with-a-long-random-string-in-real-deployments"
PORT=3001
```

- [ ] **Step 6: Create `server/docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: fontcia
      POSTGRES_PASSWORD: fontcia
      POSTGRES_DB: fontcia_dev
    ports:
      - "5433:5432"
    volumes:
      - fontcia_pg_data:/var/lib/postgresql/data

volumes:
  fontcia_pg_data:
```

Port `5433` (not Postgres's default `5432`) so this doesn't clash with any Postgres instance already running on the dev machine.

- [ ] **Step 7: Create `server/src/app.ts`**

```ts
import express from 'express';

export const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
```

- [ ] **Step 8: Create `server/src/index.ts`**

```ts
import 'dotenv/config';
import { app } from './app';

const port = Number(process.env.PORT ?? 3001);

app.listen(port, () => {
  console.log(`fontcia-server listening on port ${port}`);
});
```

- [ ] **Step 9: Copy the example env file and start Postgres**

```bash
cp .env.example .env
docker compose up -d
```

Run (still from `server/`): `docker compose ps`
Expected: a `postgres` service listed as `running`/`healthy`.

- [ ] **Step 10: Verify the server boots and responds**

Run: `npm run dev` (leave running)

In a second terminal, from `server/`: `curl http://localhost:3001/health`
Expected: `{"status":"ok"}`

Stop the dev server (Ctrl+C) before continuing.

- [ ] **Step 11: Commit**

```bash
git add server/package.json server/package-lock.json server/tsconfig.json server/vitest.config.ts server/.env.example server/docker-compose.yml server/src/app.ts server/src/index.ts
git commit -m "chore: scaffold backend server (Express, Docker Compose Postgres)"
```

Note: `server/.env` is created locally in Step 9 but is NOT committed (the root `.gitignore`'s `.env` pattern applies at any depth, so `server/.env` is already excluded).

---

### Task 2: Prisma Schema, Client, and Test Database

**Files:**
- Create: `server/prisma/schema.prisma`
- Create: `server/src/lib/prisma.ts`
- Create: `server/.env.test.example`
- Create: `server/tests/helpers/load-test-env.ts`, `server/tests/helpers/reset-db.ts`
- Test: `server/tests/db-setup.test.ts`

- [ ] **Step 1: Create `server/prisma/schema.prisma`**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String         @id @default(uuid())
  email         String         @unique
  passwordHash  String
  createdAt     DateTime       @default(now())
  savedFonts    SavedFont[]
  scans         Scan[]
  refreshTokens RefreshToken[]
}

model SavedFont {
  id         String   @id @default(uuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  fontName   String
  confidence Int
  sources    Json
  savedAt    DateTime @default(now())

  @@unique([userId, fontName])
}

model Scan {
  id         String   @id @default(uuid())
  userId     String?
  user       User?    @relation(fields: [userId], references: [id])
  status     String
  fontName   String?
  confidence Int?
  createdAt  DateTime @default(now())
}

model RefreshToken {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  tokenHash String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())
}
```

(`tokenHash @unique` is a small addition beyond the spec's literal schema text: it lets the refresh route use `findUnique` instead of `findFirst`, and adds a DB-level guard against a hash collision — a natural refinement, not a design change.)

- [ ] **Step 2: Apply the migration against the dev database**

Run (from `server/`): `npx prisma migrate dev --name init`
Expected: creates `server/prisma/migrations/<timestamp>_init/migration.sql`, applies it to `fontcia_dev`, and generates the Prisma Client into `node_modules/@prisma/client`.

- [ ] **Step 3: Create the test database and apply the same migration there**

```bash
docker compose exec -T postgres psql -U fontcia -d fontcia_dev -c "CREATE DATABASE fontcia_test;"
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_test" npx prisma migrate deploy
```

Expected: the second command reports the migration applied successfully to `fontcia_test`.

- [ ] **Step 4: Create `server/src/lib/prisma.ts`**

```ts
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
```

- [ ] **Step 5: Create `server/.env.test.example`**

```
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_test"
JWT_SECRET="test-secret-not-for-production"
PORT=3002
```

Copy it locally (not committed, same as `.env`):

```bash
cp .env.test.example .env.test
```

- [ ] **Step 6: Create `server/tests/helpers/load-test-env.ts`**

```ts
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../.env.test') });
```

This is the file `vitest.config.ts`'s `setupFiles` (Task 1) points at — it runs before any test file is imported, so `process.env.DATABASE_URL` is set to the test database's URL before `lib/prisma.ts`'s `new PrismaClient()` ever runs.

- [ ] **Step 7: Create `server/tests/helpers/reset-db.ts`**

```ts
import { prisma } from '../../src/lib/prisma';

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "User" RESTART IDENTITY CASCADE',
  );
}
```

- [ ] **Step 8: Write and run a smoke test**

`server/tests/db-setup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

describe('database connection', () => {
  it('connects to the test database and can reset it', async () => {
    await resetDb();
    const userCount = await prisma.user.count();
    expect(userCount).toBe(0);
  });
});
```

Run: `npx vitest run tests/db-setup.test.ts`
Expected: PASS — 1 test passed. (If this fails with a connection error, confirm `docker compose ps` shows Postgres running and that `.env.test` was created in Step 5.)

- [ ] **Step 9: Commit**

```bash
git add server/prisma server/src/lib/prisma.ts server/.env.test.example server/tests/helpers/load-test-env.ts server/tests/helpers/reset-db.ts server/tests/db-setup.test.ts
git commit -m "feat: add Prisma schema, client, and test database wiring"
```

---

### Task 3: Password and JWT Libraries

**Files:**
- Create: `server/src/env.ts`
- Create: `server/src/lib/password.ts`, `server/src/lib/jwt.ts`
- Test: `server/tests/password.test.ts`, `server/tests/jwt.test.ts`

- [ ] **Step 1: Create `server/src/env.ts`**

```ts
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  JWT_SECRET: requireEnv('JWT_SECRET'),
};
```

- [ ] **Step 2: Write the failing tests**

`server/tests/password.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/lib/password';

describe('password hashing', () => {
  it('hashes a password to a different string', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toBe('correct horse battery staple');
    expect(hash.length).toBeGreaterThan(20);
  });

  it('verifies a correct password against its hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const hash1 = await hashPassword('same password');
    const hash2 = await hashPassword('same password');
    expect(hash1).not.toBe(hash2);
  });
});
```

`server/tests/jwt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import jwtLib from 'jsonwebtoken';
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from '../src/lib/jwt';

describe('access tokens', () => {
  it('round-trips a signed payload through verification', () => {
    const token = signAccessToken({ sub: 'user-1', email: 'a@example.com' });
    const payload = verifyAccessToken(token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.email).toBe('a@example.com');
  });

  it('rejects a malformed token', () => {
    expect(verifyAccessToken('not-a-real-token')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwtLib.sign({ sub: 'user-1', email: 'a@example.com' }, 'wrong-secret');
    expect(verifyAccessToken(forged)).toBeNull();
  });
});

describe('refresh tokens', () => {
  it('generates a raw token whose hash matches hashRefreshToken', () => {
    const { rawToken, tokenHash } = generateRefreshToken();
    expect(hashRefreshToken(rawToken)).toBe(tokenHash);
  });

  it('generates a future expiry date around 30 days out', () => {
    const { expiresAt } = generateRefreshToken();
    const daysFromNow = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysFromNow).toBeGreaterThan(29);
    expect(daysFromNow).toBeLessThan(31);
  });

  it('generates distinct tokens on each call', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.rawToken).not.toBe(b.rawToken);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/password.test.ts tests/jwt.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/password'` / `'../src/lib/jwt'`

- [ ] **Step 4: Write `server/src/lib/password.ts`**

```ts
import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
```

- [ ] **Step 5: Write `server/src/lib/jwt.ts`**

```ts
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../env';

const ACCESS_TOKEN_EXPIRY_SECONDS = 15 * 60;
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  } catch {
    return null;
  }
}

export function accessTokenExpiresAt(): string {
  return new Date(Date.now() + ACCESS_TOKEN_EXPIRY_SECONDS * 1000).toISOString();
}

export interface GeneratedRefreshToken {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
}

export function generateRefreshToken(): GeneratedRefreshToken {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return {
    rawToken,
    tokenHash: hashRefreshToken(rawToken),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
  };
}

export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/password.test.ts tests/jwt.test.ts`
Expected: PASS — 7 tests passed (4 password + 3+3 jwt = actually 4 + 6 = 10; count them: password.test.ts has 4, jwt.test.ts has 3 access-token tests + 3 refresh-token tests = 6, total 10 tests passed)

- [ ] **Step 7: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/env.ts server/src/lib/password.ts server/src/lib/jwt.ts server/tests/password.test.ts server/tests/jwt.test.ts
git commit -m "feat: add password hashing and JWT access/refresh token libraries"
```

---

### Task 4: Middleware

**Files:**
- Create: `server/src/middleware/cors.ts`, `require-auth.ts`, `optional-auth.ts`, `auth-rate-limit.ts`, `error-handler.ts`
- Create: `server/src/types/express.d.ts`
- Modify: `server/src/app.ts`

These five middleware files have no dedicated unit tests in this task. `cors.ts`/`auth-rate-limit.ts` are thin configuration wrappers around already-well-tested libraries (`cors`, `express-rate-limit`); `require-auth.ts`/`optional-auth.ts` are thin wrappers around `verifyAccessToken` (already fully tested in Task 3); `error-handler.ts`'s actual translation behavior only means something once real routes can throw real errors. All five are exercised indirectly — and more meaningfully — by the route-level `supertest` tests in Tasks 5–7 (e.g. "GET /saved-fonts requires authentication" tests `require-auth.ts`; "rejects the 11th login attempt" tests `auth-rate-limit.ts`).

- [ ] **Step 1: Create `server/src/types/express.d.ts`**

```ts
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export {};
```

- [ ] **Step 2: Create `server/src/middleware/cors.ts`**

```ts
import cors from 'cors';

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('chrome-extension://')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
```

(Requests with no `Origin` header at all — `curl`, server-to-server calls, and `supertest`'s in-process requests — are allowed too; that's what `!origin` covers.)

- [ ] **Step 3: Create `server/src/middleware/require-auth.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/jwt';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  req.userId = payload.sub;
  next();
}
```

- [ ] **Step 4: Create `server/src/middleware/optional-auth.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/jwt';

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (token) {
    const payload = verifyAccessToken(token);
    if (payload) {
      req.userId = payload.sub;
    }
  }

  next();
}
```

- [ ] **Step 5: Create `server/src/middleware/auth-rate-limit.ts`**

```ts
import rateLimit from 'express-rate-limit';

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
});
```

- [ ] **Step 6: Create `server/src/middleware/error-handler.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';

export class ApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  console.error('fontcia-server: unexpected error', err);
  res.status(500).json({ error: 'Internal server error' });
}
```

(Express recognizes error-handling middleware by arity — it must take exactly 4 parameters, even though `_req`/`_next` are unused here.)

- [ ] **Step 7: Wire `corsMiddleware` and `errorHandler` into `app.ts`**

Change `server/src/app.ts` from:

```ts
import express from 'express';

export const app = express();

app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
```

to:

```ts
import express from 'express';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(errorHandler);
```

`errorHandler` must stay the **last** thing registered in this file — Express only routes errors to error-handling middleware registered *after* the route that threw. Tasks 5–7 each insert their new route registration **above** the `app.use(errorHandler)` line, never below it.

- [ ] **Step 8: Verify typecheck and full suite still pass**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc --noEmit` clean; all existing tests (db-setup, password, jwt) still pass — this task added no new tests, so the count is unchanged from Task 3.

- [ ] **Step 9: Commit**

```bash
git add server/src/middleware server/src/types/express.d.ts server/src/app.ts
git commit -m "feat: add auth, CORS, rate-limit, and error-handling middleware"
```

---

### Task 5: Auth Routes

**Files:**
- Create: `server/src/routes/auth.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/auth.test.ts`

- [ ] **Step 1: Write the failing tests**

`server/tests/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { resetDb } from './helpers/reset-db';

beforeEach(async () => {
  await resetDb();
});

describe('POST /auth/signup', () => {
  it('creates a user and returns a token pair', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('a@example.com');
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.expiresAt).toEqual(expect.any(String));
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/auth/signup').send({ email: 'a@example.com', password: 'password123' });

    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'anotherpassword' });

    expect(res.status).toBe(409);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await request(app).post('/auth/signup').send({ email: 'a@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/auth/signup').send({ email: 'a@example.com', password: 'password123' });
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it('rejects an incorrect password with a generic error', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrongpassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('rejects an unknown email with the same generic error', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'password123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });
});

describe('POST /auth/refresh', () => {
  it('issues a new token pair and invalidates the old refresh token', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const originalRefreshToken = signupRes.body.refreshToken;

    const refreshRes = await request(app).post('/auth/refresh').send({ refreshToken: originalRefreshToken });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.refreshToken).not.toBe(originalRefreshToken);

    const secondRefreshRes = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken });
    expect(secondRefreshRes.status).toBe(401);
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app).post('/auth/refresh').send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('deletes the refresh token, making a later refresh fail', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { refreshToken } = signupRes.body;

    const logoutRes = await request(app).post('/auth/logout').send({ refreshToken });
    expect(logoutRes.status).toBe(204);

    const refreshRes = await request(app).post('/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it('is idempotent for an already-invalid token', async () => {
    const res = await request(app).post('/auth/logout').send({ refreshToken: 'never-existed' });
    expect(res.status).toBe(204);
  });
});

describe('auth rate limiting', () => {
  it('rejects the 11th login attempt within the rate-limit window', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrong' });
    }
    const res = await request(app).post('/auth/login').send({ email: 'a@example.com', password: 'wrong' });
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL — no `/auth/*` routes exist yet (404s where the tests expect 201/200/401/204/429).

- [ ] **Step 3: Write `server/src/routes/auth.ts`**

```ts
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { hashPassword, verifyPassword } from '../lib/password';
import {
  signAccessToken,
  accessTokenExpiresAt,
  generateRefreshToken,
  hashRefreshToken,
} from '../lib/jwt';
import { authRateLimit } from '../middleware/auth-rate-limit';
import { ApiError } from '../middleware/error-handler';

export const authRouter = Router();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

async function issueTokenPair(userId: string, email: string): Promise<TokenPairResponse> {
  const accessToken = signAccessToken({ sub: userId, email });
  const { rawToken, tokenHash, expiresAt } = generateRefreshToken();

  await prisma.refreshToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  return { accessToken, refreshToken: rawToken, expiresAt: accessTokenExpiresAt() };
}

authRouter.post('/signup', authRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body as { email?: unknown; password?: unknown };

    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ApiError(400, 'A valid email is required');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new ApiError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError(409, 'Email already registered');
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({ data: { email, passwordHash } });

    const tokens = await issueTokenPair(user.id, user.email);
    res.status(201).json({ user: { id: user.id, email: user.email }, ...tokens });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', authRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body as { email?: unknown; password?: unknown };

    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new ApiError(401, 'Invalid email or password');
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new ApiError(401, 'Invalid email or password');
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new ApiError(401, 'Invalid email or password');
    }

    const tokens = await issueTokenPair(user.id, user.email);
    res.status(200).json({ user: { id: user.id, email: user.email }, ...tokens });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body as { refreshToken?: unknown };

    if (typeof refreshToken !== 'string') {
      throw new ApiError(401, 'Invalid refresh token');
    }

    const tokenHash = hashRefreshToken(refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.expiresAt.getTime() < Date.now()) {
      throw new ApiError(401, 'Invalid refresh token');
    }

    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user) {
      throw new ApiError(401, 'Invalid refresh token');
    }

    await prisma.refreshToken.delete({ where: { id: stored.id } });

    const tokens = await issueTokenPair(user.id, user.email);
    res.status(200).json(tokens);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body as { refreshToken?: unknown };

    if (typeof refreshToken === 'string') {
      const tokenHash = hashRefreshToken(refreshToken);
      await prisma.refreshToken.deleteMany({ where: { tokenHash } });
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Mount the router in `app.ts`**

Change `server/src/app.ts` from:

```ts
import express from 'express';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(errorHandler);
```

to:

```ts
import express from 'express';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { authRouter } from './routes/auth';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', authRouter);

app.use(errorHandler);
```

(`app.use('/auth', authRouter)` is inserted **above** `app.use(errorHandler)`, keeping the error handler last.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/auth.test.ts`
Expected: PASS — 11 tests passed (4 signup + 3 login + 2 refresh + 2 logout + 1 rate-limit = wait, recount: signup 4, login 3, refresh 2, logout 2, rate-limit 1 = 12 tests passed)

- [ ] **Step 6: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/auth.ts server/src/app.ts server/tests/auth.test.ts
git commit -m "feat: add signup, login, refresh, and logout routes"
```

---

### Task 6: Saved-Fonts Routes

**Files:**
- Create: `server/src/routes/saved-fonts.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/saved-fonts.test.ts`

- [ ] **Step 1: Write the failing tests**

`server/tests/saved-fonts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { resetDb } from './helpers/reset-db';

let accessToken: string;

beforeEach(async () => {
  await resetDb();
  const signupRes = await request(app)
    .post('/auth/signup')
    .send({ email: 'a@example.com', password: 'password123' });
  accessToken = signupRes.body.accessToken;
});

describe('GET /saved-fonts', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/saved-fonts');
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a fresh account', async () => {
    const res = await request(app).get('/saved-fonts').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.savedFonts).toEqual([]);
  });
});

describe('POST /saved-fonts', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/saved-fonts')
      .send({ fontName: 'Inter', confidence: 92, sources: [] });
    expect(res.status).toBe(401);
  });

  it('saves a font and it appears in the list', async () => {
    const saveRes = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        fontName: 'Inter',
        confidence: 92,
        sources: [{ url: 'https://fonts.google.com/specimen/Inter', label: 'Google Fonts', votes: 1 }],
      });

    expect(saveRes.status).toBe(201);
    expect(saveRes.body.savedFont.fontName).toBe('Inter');

    const listRes = await request(app).get('/saved-fonts').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.savedFonts).toHaveLength(1);
  });

  it('saving the same font name twice updates rather than duplicates', async () => {
    await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 80, sources: [] });
    await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 95, sources: [] });

    const listRes = await request(app).get('/saved-fonts').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.savedFonts).toHaveLength(1);
    expect(listRes.body.savedFonts[0].confidence).toBe(95);
  });

  it('rejects a request missing fontName', async () => {
    const res = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ confidence: 92, sources: [] });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /saved-fonts/:id', () => {
  it('requires authentication', async () => {
    const res = await request(app).delete('/saved-fonts/does-not-matter');
    expect(res.status).toBe(401);
  });

  it('removes a saved font', async () => {
    const saveRes = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 92, sources: [] });

    const deleteRes = await request(app)
      .delete(`/saved-fonts/${saveRes.body.savedFont.id}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app).get('/saved-fonts').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.savedFonts).toEqual([]);
  });

  it('returns 404 for a saved font belonging to another user', async () => {
    const saveRes = await request(app)
      .post('/saved-fonts')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fontName: 'Inter', confidence: 92, sources: [] });

    const otherSignup = await request(app)
      .post('/auth/signup')
      .send({ email: 'b@example.com', password: 'password123' });
    const otherToken = otherSignup.body.accessToken;

    const deleteRes = await request(app)
      .delete(`/saved-fonts/${saveRes.body.savedFont.id}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(deleteRes.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/saved-fonts.test.ts`
Expected: FAIL — no `/saved-fonts` routes exist yet.

- [ ] **Step 3: Write `server/src/routes/saved-fonts.ts`**

```ts
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/require-auth';
import { ApiError } from '../middleware/error-handler';

export const savedFontsRouter = Router();

savedFontsRouter.use(requireAuth);

savedFontsRouter.get('/', async (req, res, next) => {
  try {
    const savedFonts = await prisma.savedFont.findMany({
      where: { userId: req.userId },
      orderBy: { savedAt: 'desc' },
    });
    res.status(200).json({ savedFonts });
  } catch (error) {
    next(error);
  }
});

savedFontsRouter.post('/', async (req, res, next) => {
  try {
    const { fontName, confidence, sources } = req.body as {
      fontName?: unknown;
      confidence?: unknown;
      sources?: unknown;
    };

    if (typeof fontName !== 'string' || fontName.length === 0) {
      throw new ApiError(400, 'fontName is required');
    }
    if (typeof confidence !== 'number') {
      throw new ApiError(400, 'confidence is required');
    }
    if (!Array.isArray(sources)) {
      throw new ApiError(400, 'sources must be an array');
    }

    const userId = req.userId as string;
    const savedFont = await prisma.savedFont.upsert({
      where: { userId_fontName: { userId, fontName } },
      create: { userId, fontName, confidence, sources },
      update: { confidence, sources },
    });

    res.status(201).json({ savedFont });
  } catch (error) {
    next(error);
  }
});

savedFontsRouter.delete('/:id', async (req, res, next) => {
  try {
    const savedFont = await prisma.savedFont.findUnique({ where: { id: req.params.id } });

    if (!savedFont || savedFont.userId !== req.userId) {
      throw new ApiError(404, 'Saved font not found');
    }

    await prisma.savedFont.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
```

(`req.userId` is guaranteed set here because `savedFontsRouter.use(requireAuth)` runs first for every route on this router — `requireAuth` already 401s and returns before `next()` if there's no valid token.)

- [ ] **Step 4: Mount the router in `app.ts`**

Change `server/src/app.ts` from:

```ts
import { authRouter } from './routes/auth';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', authRouter);

app.use(errorHandler);
```

to:

```ts
import { authRouter } from './routes/auth';
import { savedFontsRouter } from './routes/saved-fonts';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/saved-fonts', savedFontsRouter);

app.use(errorHandler);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/saved-fonts.test.ts`
Expected: PASS — 8 tests passed (2 GET + 4 POST + 2 DELETE... recount: GET has 2, POST has 4, DELETE has 3 = 9 tests passed)

- [ ] **Step 6: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/saved-fonts.ts server/src/app.ts server/tests/saved-fonts.test.ts
git commit -m "feat: add saved-fonts list/save/unsave routes"
```

---

### Task 7: Scan Logging Route

**Files:**
- Create: `server/src/routes/scans.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/scans.test.ts`

- [ ] **Step 1: Write the failing tests**

`server/tests/scans.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

beforeEach(async () => {
  await resetDb();
});

describe('POST /scans', () => {
  it('logs an anonymous scan with no Authorization header', async () => {
    const res = await request(app).post('/scans').send({ status: 'match', fontName: 'Inter', confidence: 92 });
    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(String));

    const scan = await prisma.scan.findUnique({ where: { id: res.body.id } });
    expect(scan?.userId).toBeNull();
  });

  it('associates the scan with the authenticated user when a valid token is present', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { accessToken, user } = signupRes.body;

    const res = await request(app)
      .post('/scans')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'no-match' });

    expect(res.status).toBe(201);
    const scan = await prisma.scan.findUnique({ where: { id: res.body.id } });
    expect(scan?.userId).toBe(user.id);
  });

  it('rejects a missing/invalid status', async () => {
    const res = await request(app).post('/scans').send({ status: 'maybe' });
    expect(res.status).toBe(400);
  });

  it('still logs anonymously when given an invalid token', async () => {
    const res = await request(app)
      .post('/scans')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ status: 'match', fontName: 'Inter', confidence: 92 });

    expect(res.status).toBe(201);
    const scan = await prisma.scan.findUnique({ where: { id: res.body.id } });
    expect(scan?.userId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scans.test.ts`
Expected: FAIL — no `/scans` route exists yet.

- [ ] **Step 3: Write `server/src/routes/scans.ts`**

```ts
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { ApiError } from '../middleware/error-handler';

export const scansRouter = Router();

scansRouter.post('/', optionalAuth, async (req, res, next) => {
  try {
    const { status, fontName, confidence } = req.body as {
      status?: unknown;
      fontName?: unknown;
      confidence?: unknown;
    };

    if (status !== 'match' && status !== 'no-match') {
      throw new ApiError(400, "status must be 'match' or 'no-match'");
    }

    const scan = await prisma.scan.create({
      data: {
        userId: req.userId ?? null,
        status,
        fontName: typeof fontName === 'string' ? fontName : null,
        confidence: typeof confidence === 'number' ? confidence : null,
      },
    });

    res.status(201).json({ id: scan.id, createdAt: scan.createdAt });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Mount the router in `app.ts`**

Change `server/src/app.ts` from:

```ts
import { authRouter } from './routes/auth';
import { savedFontsRouter } from './routes/saved-fonts';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/saved-fonts', savedFontsRouter);

app.use(errorHandler);
```

to:

```ts
import { authRouter } from './routes/auth';
import { savedFontsRouter } from './routes/saved-fonts';
import { scansRouter } from './routes/scans';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/saved-fonts', savedFontsRouter);
app.use('/scans', scansRouter);

app.use(errorHandler);
```

`errorHandler` is still, correctly, the last line — every route this plan adds is now in place, and no further tasks insert anything after it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/scans.test.ts`
Expected: PASS — 4 tests passed

- [ ] **Step 6: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/scans.ts server/src/app.ts server/tests/scans.test.ts
git commit -m "feat: add scan logging route with optional auth"
```

---

### Task 8: Final Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Full suite and typecheck**

Run (from `server/`): `npx tsc --noEmit && npm test`
Expected: `tsc --noEmit` clean; all test files pass (db-setup, password, jwt, auth, saved-fonts, scans).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: creates `server/dist/` with compiled JS (`dist/index.js`, `dist/app.js`, etc.), no errors.

- [ ] **Step 3: Manual end-to-end smoke test against a running server**

Run: `npm run start` (leave running; uses the build from Step 2 — make sure `.env` is present from Task 1)

In a second terminal, from `server/`, walk the full flow with `curl`:

```bash
# Signup
curl -s -X POST http://localhost:3001/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@example.com","password":"password123"}'
```
Expected: JSON with `user`, `accessToken`, `refreshToken`, `expiresAt`. Copy the `accessToken` and `refreshToken` values for the next commands.

```bash
# Save a font (replace <ACCESS_TOKEN>)
curl -s -X POST http://localhost:3001/saved-fonts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{"fontName":"Inter","confidence":92,"sources":[]}'
```
Expected: `201` with the saved font.

```bash
# List saved fonts
curl -s http://localhost:3001/saved-fonts -H "Authorization: Bearer <ACCESS_TOKEN>"
```
Expected: the font from the previous step.

```bash
# Log an anonymous scan (no Authorization header)
curl -s -X POST http://localhost:3001/scans \
  -H "Content-Type: application/json" \
  -d '{"status":"match","fontName":"Inter","confidence":92}'
```
Expected: `201` with `id`/`createdAt`.

```bash
# Refresh (replace <REFRESH_TOKEN>)
curl -s -X POST http://localhost:3001/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<REFRESH_TOKEN>"}'
```
Expected: a new token pair.

```bash
# Logout with the ORIGINAL refresh token (should already be invalid post-rotation)
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<REFRESH_TOKEN>"}'
```
Expected: `204` (logout is idempotent even for an already-rotated-out token, per the design).

Stop the server (Ctrl+C) when done.

- [ ] **Step 4: Record results**

If all checks pass, this sub-project is complete. If a fix is required, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix.

---

## Self-Review Notes

- **Spec coverage:** signup/login/refresh/logout with rotating server-revocable refresh tokens → Tasks 3, 5; bcryptjs password hashing (cost 12) → Task 3; required-auth saved-fonts CRUD with denormalized JSON `sources` → Task 6; optional-auth scan logging → Task 7; reflect-origin CORS for `chrome-extension://` → Task 4; auth-endpoint-only rate limiting (10/15min) → Tasks 4, 5; centralized error handling with `ApiError` → Task 4; real Postgres via Docker Compose for both dev and test, no mocking → Tasks 1, 2; Vitest reuse → all tasks. All spec sections are covered.
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency check:** `AccessTokenPayload` (`{sub, email}`, Task 3) matches exactly how `issueTokenPair` constructs it in `routes/auth.ts` (Task 5) and how `require-auth.ts`/`optional-auth.ts` (Task 4) read `payload.sub`/set `req.userId`. `GeneratedRefreshToken`'s `{rawToken, tokenHash, expiresAt}` (Task 3) matches exactly how `issueTokenPair` destructures it (Task 5). `ApiError`'s constructor signature (`statusCode, message`, Task 4) is used identically across `routes/auth.ts`, `routes/saved-fonts.ts`, `routes/scans.ts` (Tasks 5–7). `req.userId?: string` (declared once in `types/express.d.ts`, Task 4) is the single source of truth every middleware and route reads/writes — no duplicate/conflicting declarations. `SavedFont`'s `@@unique([userId, fontName])` (Task 2) matches the `userId_fontName` compound-key name Prisma auto-generates and that `routes/saved-fonts.ts`'s `upsert` call uses (Task 6) — confirmed this is Prisma's actual default naming convention for an unnamed `@@unique` on two fields.
- **Test count corrections made during self-review:** initial draft undercounted `auth.test.ts` (12, not "11") and `saved-fonts.test.ts` (9, not "8") — both corrected inline in Tasks 5 and 6's "Expected" lines above to match the literal number of `it(...)` blocks actually written in each file.
