# fontCIA — Backend API Server Design (Sub-project 4a of 8, split from Step 4)

**Status:** Approved
**Scope:** The first half of build-order step 4 from `CLAUDE_CODE_INSTRUCTIONS.md` — stand up a real Node.js/Express/Prisma/Postgres backend server: email/password auth with JWT (access + rotating refresh tokens), saved-fonts persistence, and scan logging. Fully standalone: testable via its own test suite and `curl`, with **no extension changes** in this spec. Wiring the extension to this server is a separate follow-up sub-project (4b), scoped once this one ships and its actual response shapes are settled.

## Context

Steps 1–3 (extension shell, scan dialogue, DOM font-resolution — all merged) built a fully client-side extension: scanning works with zero network calls, and "saving" a font is currently just local UI state inside `locked-selection.ts`'s closure (never persisted, lost on dismiss). This sub-project is the first time the project gets a real backend. Font resolution itself is explicitly **not** moving server-side here — `known-fonts.ts`'s bundled ten-font table stays exactly as built in Step 3; a dynamic, server-side font registry is deferred until Step 5/6 when there's actual community-contributed data worth serving.

## Confirmed decisions

- **Two-sub-project split:** this spec covers only the backend server (4a). Client integration (API client, token storage, rewiring the Save button, scan-logging calls) is sub-project 4b, brainstormed separately once 4a's real response shapes exist to design against.
- **Auth:** email/password, JWT access tokens (15 min expiry) + opaque, rotating refresh tokens (30 day expiry, hashed at rest, stored server-side in a `RefreshToken` table for real revocation — a JWT-only refresh scheme can't be revoked before it expires).
- **Password hashing:** bcryptjs (pure-JS, no native bindings — avoids cross-platform build friction), cost factor 12.
- **Rate limiting on auth endpoints:** `/auth/signup` and `/auth/login` specifically get brute-force/credential-stuffing protection now, as a baseline security property — distinct from and unrelated to Step 8's usage-tier quota enforcement (which applies to scanning volume, not login attempts, and is explicitly still deferred).
- **`/scans` uses optional auth**, `/saved-fonts` uses required auth — scanning must keep working with no account.
- **`SavedFont.sources` is a denormalized JSON snapshot** of the scan result the user chose to save (mirroring the client's existing `ScanSource[]` shape exactly), not a foreign key into a `Font`/`Source` table — those don't exist until Step 5/6. Accepted as a known forward-compat gap, not an oversight: a future migration will relate saved fonts back to canonical font records once that schema exists.
- **CORS:** reflect any `chrome-extension://` origin (not a wildcard, not pinned to one fixed ID, since an unpacked dev extension's ID isn't stable) — tightens to one fixed origin once the extension has a published, stable Web Store ID. No cookies/credentials mode: auth is bearer-token-only, which sidesteps CSRF entirely.
- **Local/test Postgres via `docker-compose.yml`.** Tests run against a real test database (via Prisma), not mocked.
- **Vitest**, reusing the same test framework as the extension rather than introducing a second one.

## Architecture

New top-level `server/` directory, sibling to `src/` — its own npm package (own `package.json`/`tsconfig.json`), not a monorepo/workspaces setup. Two independent projects living in one repo, which is simpler than workspace tooling at this project's current scale.

```
server/
  package.json
  tsconfig.json
  .env.example
  docker-compose.yml
  prisma/
    schema.prisma
  src/
    app.ts                    — Express app construction, exported separately from listen() for testability
    index.ts                  — imports app, calls app.listen(PORT)
    env.ts                    — loads/validates required env vars
    lib/
      prisma.ts               — singleton PrismaClient
      password.ts             — hashPassword/verifyPassword (bcryptjs)
      jwt.ts                  — sign/verify access tokens; generate/hash refresh tokens
    middleware/
      cors.ts
      require-auth.ts         — 401s without a valid access token
      optional-auth.ts        — attaches userId if present & valid, otherwise proceeds anonymously
      auth-rate-limit.ts      — express-rate-limit config, applied only to signup/login
      error-handler.ts        — centralized error → JSON response mapping
    routes/
      auth.ts                 — signup, login, refresh, logout
      saved-fonts.ts          — list, save, unsave
      scans.ts                — log
  tests/
    helpers/
      test-app.ts             — builds an app instance wired to the test database
      reset-db.ts             — truncates tables between tests
    auth.test.ts
    saved-fonts.test.ts
    scans.test.ts
```

## Database schema

```prisma
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
  status     String   // 'match' | 'no-match'
  fontName   String?
  confidence Int?
  createdAt  DateTime @default(now())
}

model RefreshToken {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  tokenHash String   // SHA-256 of the raw token — never store the raw token
  expiresAt DateTime
  createdAt DateTime @default(now())
}
```

`@@unique([userId, fontName])` on `SavedFont` means saving the same font name twice is an upsert-shaped operation (star toggles a single row per user+font), not a growing list of duplicates.

## Auth flow

**Access tokens** are JWTs (`{sub: userId, email}`, 15 min expiry), signed with a single `JWT_SECRET`. **Refresh tokens** are opaque random strings (`crypto.randomBytes(32).toString('hex')`), never JWTs — only one server secret is needed (for access-token signing), since refresh-token validity is checked by hash lookup against the `RefreshToken` table, not by signature verification.

1. **Signup** (`POST /auth/signup { email, password }`): validate email format and password length (≥ 8 chars) → reject if email already exists (409) → hash password (bcryptjs, cost 12) → create `User` → issue token pair (below) → `201 { user: {id, email}, accessToken, refreshToken, expiresAt }`.
2. **Login** (`POST /auth/login { email, password }`): look up by email → bcrypt-compare password → on success, issue token pair, same response shape as signup. On failure (unknown email *or* wrong password), return the same generic `401 { error: 'Invalid email or password' }` — deliberately not distinguishing the two, to avoid leaking which emails have accounts.
3. **Refresh** (`POST /auth/refresh { refreshToken }`): hash the provided token (SHA-256) → look up in `RefreshToken` → if missing or expired, `401 { error: 'Invalid refresh token' }` (client should force re-login) → if valid: **delete the matched record and issue a brand-new token pair** (rotation — a stolen refresh token is only useful once before the legitimate client's next refresh invalidates it) → `200 { accessToken, refreshToken, expiresAt }`.
4. **Logout** (`POST /auth/logout { refreshToken }`): hash and delete the matching `RefreshToken` record if one exists → `204` unconditionally (idempotent; doesn't leak whether the token was valid).

"Issue token pair" = generate the access JWT, generate a raw refresh token, store only `SHA-256(rawToken)` + its own `expiresAt` in `RefreshToken`, return the **raw** refresh token to the client (the only time it's ever transmitted in plaintext) alongside the access token. The `expiresAt` field in every response below refers specifically to the **access token's** expiry (an ISO-8601 string, `now + 15min`) — the refresh token's own (30-day) expiry is never returned to the client at all, since the client shouldn't need to reason about it: it just calls `/auth/refresh` whenever a request 401s, and either gets a new pair back or is told to re-login.

## Endpoints

```
POST   /auth/signup     { email, password }             → 201 { user, accessToken, refreshToken, expiresAt } | 400 | 409
POST   /auth/login      { email, password }              → 200 { user, accessToken, refreshToken, expiresAt } | 401
POST   /auth/refresh    { refreshToken }                  → 200 { accessToken, refreshToken, expiresAt } | 401
POST   /auth/logout     { refreshToken }                  → 204

GET    /saved-fonts                          (requireAuth) → 200 { savedFonts: [{ id, fontName, confidence, sources, savedAt }] }
POST   /saved-fonts     { fontName, confidence, sources } (requireAuth) → 201 { savedFont }
DELETE /saved-fonts/:id                       (requireAuth) → 204 | 404

POST   /scans           { status, fontName?, confidence? } (optionalAuth) → 201 { id, createdAt }
```

All authenticated routes read `Authorization: Bearer <accessToken>`; `requireAuth` responds `401 { error: 'Unauthorized' }` if missing/invalid/expired, `optionalAuth` sets `req.userId` to the verified subject or `null` and always proceeds.

## Rate limiting

`express-rate-limit` applied only to `/auth/signup` and `/auth/login`: 10 requests per 15 minutes per IP, `429 { error: 'Too many attempts, try again later' }` when exceeded. Not applied to `/auth/refresh` (possessing a valid 256-bit opaque token isn't brute-forceable), `/auth/logout`, `/saved-fonts`, or `/scans` — general usage-volume limiting for those is Step 8's job, a distinct concern from credential-guessing protection.

## CORS

Custom origin-validator (via the `cors` package): allow the request if `Origin` starts with `chrome-extension://`, reflecting that exact origin back in `Access-Control-Allow-Origin` rather than using `*`. `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization`. No `credentials: true` — bearer-token auth means the browser never auto-attaches anything cross-origin, so there's no CSRF surface to defend against here.

## Error handling

A centralized error-handling middleware maps thrown errors to JSON responses. A small `ApiError` class (`statusCode`, `message`) lets route handlers throw expected errors (`throw new ApiError(409, 'Email already registered')`) that the middleware translates directly; anything else falls back to `500 { error: 'Internal server error' }` with the real error logged server-side via `console.error`, never leaking a stack trace to the client. Validation failures (missing/malformed fields) return `400` with a descriptive message.

## Testing

Real Postgres via `docker-compose.yml` (a `fontcia_test` database, separate from dev), reset between test files via a `reset-db.ts` helper that truncates tables — not mocked, consistent with solid practice for a Prisma-backed service and avoiding mock/prod divergence risk. Tests use `supertest` (new dependency) to make in-process HTTP requests against the exported `app` instance directly, no real port/listener needed.

Coverage: signup (success, duplicate email, weak password, malformed email), login (success, wrong password, unknown email — same generic error), refresh (success + rotation actually invalidates the old token, expired/unknown token rejected), logout (idempotent), saved-fonts (full CRUD while authenticated, 401 without a token, the `@@unique` constraint correctly prevents duplicate saves), scans (works with no auth header, correctly associates `userId` when one is present), rate limiting (the 11th login attempt within the window is rejected with 429).

## Out of scope for this spec

Any extension-side code (sub-project 4b). Font resolution/lookup moving server-side (Step 5/6). Enrollment submission and moderation (Step 5). Usage/tier limit enforcement beyond the auth-endpoint rate limiting described above (Step 8). A hosted web app or login UI of any kind (no web frontend exists yet; this is an API-only server for now).
