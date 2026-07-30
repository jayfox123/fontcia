# Usage/Tier Gating Implementation Plan (Step 8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the Free (20 scans/month) and Pro (unlimited) tiers using the `Scan` rows already being logged. `User` gains a schema-only `tier` flag (no billing). Two independent server-side enforcement points share one helper: a pre-flight `GET /scans/usage` check (the DOM path's only available gate) and `enforceUsageLimit` middleware on `POST /font-matches` (the AI path's real, unbypassable gate, protecting the actual DINOv2 compute cost) and `POST /scans` (defense-in-depth). A new `renderLimitReachedState` UI state, with a disabled "Upgrade to Pro" button matching Step 2's disabled "Name it" precedent, replaces the scan flow when a logged-in Free user is over quota.

**Architecture:** No new counter table — usage is a live `COUNT` against existing `Scan` rows, calendar month, UTC. Anonymous scanning is entirely untouched (no tier to check without a `userId`). A `chrome.storage.local` cache short-circuits only the *deny* case client-side to avoid repeated wasted round trips; every non-denied path still asks the server fresh, which stays authoritative regardless.

**Tech Stack:** TypeScript, Express, Prisma/Postgres, Chrome Extension Manifest V3, Vitest + jsdom (client) / Vitest + supertest + real Postgres (server) — all existing conventions, no new dependencies.

---

## File Structure

```
server/prisma/schema.prisma                    — User gains tier
server/prisma/migrations/*_add_user_tier/       — new migration

server/src/lib/usage.ts                         — new: FREE_TIER_MONTHLY_LIMIT, getMonthlyUsage(userId)
server/tests/usage.test.ts                      — new

server/src/middleware/enforce-usage-limit.ts    — new: enforceUsageLimit
server/tests/enforce-usage-limit.test.ts        — new

server/src/routes/scans.ts                      — gains GET /usage; POST / gains enforceUsageLimit
server/tests/scans.test.ts                      — new GET /usage tests, new POST / over-limit test

server/src/routes/font-matches.ts               — gains enforceUsageLimit
server/tests/font-matches.test.ts               — new over-limit test

src/shared/api-messages.ts                      — gains GET_SCAN_USAGE
src/background/api-client.ts                    — gains ScanUsage, getScanUsage()
tests/api-client.test.ts                        — new test
src/background/service-worker.ts                — one new dispatch case
tests/service-worker.test.ts                    — new test

src/shared/usage-storage.ts                     — new: CachedScanUsage, getCachedScanUsage/setCachedScanUsage
tests/usage-storage.test.ts                     — new

src/content/scan-dialogue.ts                    — gains renderLimitReachedState
tests/scan-dialogue.test.ts                     — new tests

src/content/locked-selection.ts                 — modified: handleScan gated by new checkUsageAllowed()
tests/locked-selection.test.ts                  — new tests; shared beforeEach mock gains GET_SCAN_USAGE
```

---

### Task 1: `User.tier` schema flag

**Files:**
- Modify: `server/prisma/schema.prisma`
- New: migration (generated)

- [ ] **Step 1: Add the field**

```prisma
model User {
  id                          String                       @id @default(uuid())
  email                       String                       @unique
  passwordHash                String
  tier                        String                       @default("free") // 'free' | 'pro'
  createdAt                   DateTime                     @default(now())
  savedFonts                  SavedFont[]
  scans                       Scan[]
  refreshTokens               RefreshToken[]
  fontSubmissions             FontSubmission[]
  fontSubmissionConfirmations FontSubmissionConfirmation[]
}
```

- [ ] **Step 2: Generate and apply the migration**

```
cd server
npx prisma migrate dev --name add_user_tier
```

Expected: a new `server/prisma/migrations/*_add_user_tier/migration.sql` containing `ALTER TABLE "User" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'free';`, applied cleanly to the dev database, Prisma client regenerated.

- [ ] **Step 3: Commit**

```
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "feat: add User.tier, schema flag only, defaults to free"
```

---

### Task 2: `getMonthlyUsage`

**Files:**
- New: `server/src/lib/usage.ts`
- Test: `server/tests/usage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/usage.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';
import { getMonthlyUsage, FREE_TIER_MONTHLY_LIMIT } from '../src/lib/usage';

beforeEach(async () => {
  await resetDb();
});

async function createUser(tier?: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${Math.random()}@example.com`,
      passwordHash: 'irrelevant',
      ...(tier ? { tier } : {}),
    },
  });
  return user.id;
}

describe('getMonthlyUsage', () => {
  it('defaults a new user to free tier with zero usage', async () => {
    const userId = await createUser();

    const usage = await getMonthlyUsage(userId);

    expect(usage.tier).toBe('free');
    expect(usage.used).toBe(0);
    expect(usage.limit).toBe(FREE_TIER_MONTHLY_LIMIT);
    expect(usage.remaining).toBe(FREE_TIER_MONTHLY_LIMIT);
  });

  it('counts this month\'s scans for a free user, match and no-match alike', async () => {
    const userId = await createUser();
    await prisma.scan.create({ data: { userId, status: 'match', fontName: 'Inter', confidence: 90 } });
    await prisma.scan.create({ data: { userId, status: 'no-match' } });

    const usage = await getMonthlyUsage(userId);

    expect(usage.used).toBe(2);
    expect(usage.remaining).toBe(FREE_TIER_MONTHLY_LIMIT - 2);
  });

  it('does not count another user\'s scans', async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    await prisma.scan.create({ data: { userId: otherUserId, status: 'match', fontName: 'Inter', confidence: 90 } });

    const usage = await getMonthlyUsage(userId);

    expect(usage.used).toBe(0);
  });

  it('does not count anonymous scans', async () => {
    const userId = await createUser();
    await prisma.scan.create({ data: { userId: null, status: 'match', fontName: 'Inter', confidence: 90 } });

    const usage = await getMonthlyUsage(userId);

    expect(usage.used).toBe(0);
  });

  it('does not count scans from a prior month', async () => {
    const userId = await createUser();
    await prisma.scan.create({
      data: { userId, status: 'match', fontName: 'Inter', confidence: 90, createdAt: new Date('2020-01-15') },
    });

    const usage = await getMonthlyUsage(userId);

    expect(usage.used).toBe(0);
  });

  it('reports pro as unlimited regardless of usage', async () => {
    const userId = await createUser('pro');
    for (let i = 0; i < 25; i++) {
      await prisma.scan.create({ data: { userId, status: 'no-match' } });
    }

    const usage = await getMonthlyUsage(userId);

    expect(usage.tier).toBe('pro');
    expect(usage.used).toBe(25);
    expect(usage.limit).toBeNull();
    expect(usage.remaining).toBeNull();
  });

  it('clamps remaining at zero rather than going negative', async () => {
    const userId = await createUser();
    for (let i = 0; i < FREE_TIER_MONTHLY_LIMIT + 5; i++) {
      await prisma.scan.create({ data: { userId, status: 'no-match' } });
    }

    const usage = await getMonthlyUsage(userId);

    expect(usage.remaining).toBe(0);
  });

  it('returns an ISO resetsAt at the start of next UTC month', async () => {
    const userId = await createUser();

    const usage = await getMonthlyUsage(userId);
    const resetsAt = new Date(usage.resetsAt);

    expect(resetsAt.getUTCDate()).toBe(1);
    expect(resetsAt.getUTCHours()).toBe(0);
    expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

`npm test -- usage.test.ts` (from `server/`) — expected: fails, `getMonthlyUsage` doesn't exist yet.

- [ ] **Step 3: Write `server/src/lib/usage.ts`**

```ts
import { prisma } from './prisma';

export const FREE_TIER_MONTHLY_LIMIT = 20;

export interface UsageInfo {
  tier: 'free' | 'pro';
  used: number;
  limit: number | null;
  remaining: number | null;
  resetsAt: string;
}

function currentMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function nextMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export async function getMonthlyUsage(userId: string): Promise<UsageInfo> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tier: true } });
  const tier = user.tier === 'pro' ? 'pro' : 'free';
  const used = await prisma.scan.count({ where: { userId, createdAt: { gte: currentMonthStart() } } });
  const resetsAt = nextMonthStart().toISOString();

  if (tier === 'pro') {
    return { tier, used, limit: null, remaining: null, resetsAt };
  }
  return {
    tier,
    used,
    limit: FREE_TIER_MONTHLY_LIMIT,
    remaining: Math.max(0, FREE_TIER_MONTHLY_LIMIT - used),
    resetsAt,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

`npm test -- usage.test.ts`

- [ ] **Step 5: Verify typecheck**

`npm run typecheck` (from `server/`)

- [ ] **Step 6: Commit**

```
git add server/src/lib/usage.ts server/tests/usage.test.ts
git commit -m "feat: add getMonthlyUsage, counting live against existing Scan rows"
```

---

### Task 3: `enforceUsageLimit` middleware

**Files:**
- New: `server/src/middleware/enforce-usage-limit.ts`
- Test: `server/tests/enforce-usage-limit.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/tests/enforce-usage-limit.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';
import { enforceUsageLimit } from '../src/middleware/enforce-usage-limit';
import { FREE_TIER_MONTHLY_LIMIT } from '../src/lib/usage';
import { ApiError } from '../src/middleware/error-handler';

beforeEach(async () => {
  await resetDb();
});

async function createUser(tier?: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `${Math.random()}@example.com`, passwordHash: 'irrelevant', ...(tier ? { tier } : {}) },
  });
  return user.id;
}

function runMiddleware(userId?: string): Promise<unknown> {
  return new Promise((resolve) => {
    const req = { userId } as unknown as Request;
    const res = {} as Response;
    const next = ((error?: unknown) => resolve(error)) as NextFunction;
    void enforceUsageLimit(req, res, next);
  });
}

describe('enforceUsageLimit', () => {
  it('passes through anonymous requests untouched', async () => {
    const result = await runMiddleware(undefined);
    expect(result).toBeUndefined();
  });

  it('passes through a free user under the limit', async () => {
    const userId = await createUser();
    const result = await runMiddleware(userId);
    expect(result).toBeUndefined();
  });

  it('blocks a free user at the limit', async () => {
    const userId = await createUser();
    for (let i = 0; i < FREE_TIER_MONTHLY_LIMIT; i++) {
      await prisma.scan.create({ data: { userId, status: 'no-match' } });
    }

    const result = await runMiddleware(userId);

    expect(result).toBeInstanceOf(ApiError);
    expect((result as InstanceType<typeof ApiError>).statusCode).toBe(403);
  });

  it('never blocks a pro user regardless of usage', async () => {
    const userId = await createUser('pro');
    for (let i = 0; i < FREE_TIER_MONTHLY_LIMIT + 10; i++) {
      await prisma.scan.create({ data: { userId, status: 'no-match' } });
    }

    const result = await runMiddleware(userId);

    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

`npm test -- enforce-usage-limit.test.ts` — expected: fails, module doesn't exist.

- [ ] **Step 3: Write `server/src/middleware/enforce-usage-limit.ts`**

```ts
import type { Request, Response, NextFunction } from 'express';
import { getMonthlyUsage } from '../lib/usage';
import { ApiError } from './error-handler';

export async function enforceUsageLimit(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) {
    next();
    return;
  }
  try {
    const usage = await getMonthlyUsage(req.userId);
    if (usage.remaining !== null && usage.remaining <= 0) {
      throw new ApiError(403, `Monthly scan limit reached — resets ${usage.resetsAt}`);
    }
    next();
  } catch (error) {
    next(error);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

`npm test -- enforce-usage-limit.test.ts`

- [ ] **Step 5: Verify typecheck**

`npm run typecheck`

- [ ] **Step 6: Commit**

```
git add server/src/middleware/enforce-usage-limit.ts server/tests/enforce-usage-limit.test.ts
git commit -m "feat: add enforceUsageLimit middleware"
```

---

### Task 4: `GET /scans/usage`, and gate `POST /scans` + `POST /font-matches`

**Files:**
- Modify: `server/src/routes/scans.ts`, `server/src/routes/font-matches.ts`
- Test: `server/tests/scans.test.ts`, `server/tests/font-matches.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/scans.test.ts`:

```ts
describe('GET /scans/usage', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/scans/usage');
    expect(res.status).toBe(401);
  });

  it("returns the caller's tier and usage", async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { accessToken } = signupRes.body;

    await request(app).post('/scans').set('Authorization', `Bearer ${accessToken}`).send({ status: 'match', fontName: 'Inter', confidence: 92 });

    const res = await request(app).get('/scans/usage').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('free');
    expect(res.body.used).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.remaining).toBe(19);
    expect(typeof res.body.resetsAt).toBe('string');
  });
});

describe('POST /scans over the limit', () => {
  it('rejects a free user at the monthly limit with 403', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { accessToken } = signupRes.body;

    for (let i = 0; i < 20; i++) {
      await request(app).post('/scans').set('Authorization', `Bearer ${accessToken}`).send({ status: 'no-match' });
    }

    const res = await request(app).post('/scans').set('Authorization', `Bearer ${accessToken}`).send({ status: 'no-match' });

    expect(res.status).toBe(403);
  });

  it('still allows anonymous scans with no limit applied', async () => {
    for (let i = 0; i < 25; i++) {
      const res = await request(app).post('/scans').send({ status: 'no-match' });
      expect(res.status).toBe(201);
    }
  });
});
```

Add to `server/tests/font-matches.test.ts` (inside the existing mocked-`getEmbedding` setup):

```ts
describe('POST /font-matches over the limit', () => {
  it('rejects a free user at the limit without calling the embedding service', async () => {
    const signupRes = await request(app)
      .post('/auth/signup')
      .send({ email: 'a@example.com', password: 'password123' });
    const { accessToken } = signupRes.body;

    for (let i = 0; i < 20; i++) {
      await request(app).post('/scans').set('Authorization', `Bearer ${accessToken}`).send({ status: 'no-match' });
    }

    const res = await request(app)
      .post('/font-matches')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(403);
    expect(getEmbedding).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

`npm test -- scans.test.ts font-matches.test.ts`

- [ ] **Step 3: Update `server/src/routes/scans.ts`**

```ts
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { requireAuth } from '../middleware/require-auth';
import { enforceUsageLimit } from '../middleware/enforce-usage-limit';
import { getMonthlyUsage } from '../lib/usage';
import { ApiError } from '../middleware/error-handler';

export const scansRouter = Router();

const SCAN_HISTORY_LIMIT = 50;

scansRouter.post('/', optionalAuth, enforceUsageLimit, async (req, res, next) => {
  // ...unchanged body...
});

scansRouter.get('/', requireAuth, async (req, res, next) => {
  // ...unchanged body...
});

scansRouter.get('/usage', requireAuth, async (req, res, next) => {
  try {
    const usage = await getMonthlyUsage(req.userId!);
    res.status(200).json(usage);
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Update `server/src/routes/font-matches.ts`**

Add the `enforceUsageLimit` import and insert it into the route chain:

```ts
import { enforceUsageLimit } from '../middleware/enforce-usage-limit';
// ...
fontMatchesRouter.post('/', optionalAuth, enforceUsageLimit, upload.single('image'), async (req, res, next) => {
  // ...unchanged body...
});
```

- [ ] **Step 5: Run tests to verify they pass**

`npm test -- scans.test.ts font-matches.test.ts`

- [ ] **Step 6: Verify typecheck and full server suite**

`npm run typecheck && npm test` (from `server/`)

- [ ] **Step 7: Commit**

```
git add server/src/routes/scans.ts server/src/routes/font-matches.ts server/tests/scans.test.ts server/tests/font-matches.test.ts
git commit -m "feat: add GET /scans/usage, gate POST /scans and POST /font-matches on usage"
```

---

### Task 5: Client message contract — `GET_SCAN_USAGE`

**Files:**
- Modify: `src/shared/api-messages.ts`, `src/background/api-client.ts`, `src/background/service-worker.ts`
- Test: `tests/api-client.test.ts`, `tests/service-worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/api-client.test.ts`, following the existing `getScans` test's shape:

```ts
describe('getScanUsage', () => {
  it('fetches GET /scans/usage with required auth', async () => {
    await setStoredAuth({ accessToken: 'tok', refreshToken: 'r', expiresAt: futureIso(), userId: 'u1', email: 'a@example.com' });
    mockFetchOnce(200, { tier: 'free', used: 3, limit: 20, remaining: 17, resetsAt: '2026-08-01T00:00:00.000Z' });

    const result = await getScanUsage();

    expect(result).toEqual({
      ok: true,
      data: { tier: 'free', used: 3, limit: 20, remaining: 17, resetsAt: '2026-08-01T00:00:00.000Z' },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/scans/usage'),
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
```

(Match whatever helper names — `mockFetchOnce`, `futureIso`, `fetchMock` — this file's existing tests already use; this snippet mirrors the pattern, not a literal copy of unseen helper internals.)

Add to `tests/service-worker.test.ts`, mirroring the existing `GET_SCANS` dispatch test:

```ts
it('dispatches GET_SCAN_USAGE to getScanUsage', async () => {
  vi.mocked(getScanUsage).mockResolvedValueOnce({ ok: true, data: { tier: 'free', used: 1, limit: 20, remaining: 19, resetsAt: '2026-08-01T00:00:00.000Z' } });

  const result = await handleApiMessage({ type: 'GET_SCAN_USAGE' });

  expect(result).toEqual({ ok: true, data: { tier: 'free', used: 1, limit: 20, remaining: 19, resetsAt: '2026-08-01T00:00:00.000Z' } });
});
```

- [ ] **Step 2: Run tests to verify they fail**

`npm test -- api-client.test.ts service-worker.test.ts`

- [ ] **Step 3: Add the message type**

```ts
// src/shared/api-messages.ts
export type ApiMessage =
  | // ...existing...
  | { type: 'GET_SCAN_USAGE' };
```

- [ ] **Step 4: Add `getScanUsage` to `api-client.ts`**

```ts
export interface ScanUsage {
  tier: 'free' | 'pro';
  used: number;
  limit: number | null;
  remaining: number | null;
  resetsAt: string;
}

export async function getScanUsage(): Promise<ApiResponse<ScanUsage>> {
  return apiFetch<ScanUsage>('/scans/usage', { method: 'GET', auth: 'required' });
}
```

- [ ] **Step 5: Add the dispatch case to `service-worker.ts`**

```ts
import {
  // ...existing...
  getScanUsage,
} from './api-client';
// ...
case 'GET_SCAN_USAGE':
  return await getScanUsage();
```

- [ ] **Step 6: Run tests to verify they pass**

`npm test -- api-client.test.ts service-worker.test.ts`

- [ ] **Step 7: Verify typecheck**

`npm run typecheck`

- [ ] **Step 8: Commit**

```
git add src/shared/api-messages.ts src/background/api-client.ts src/background/service-worker.ts tests/api-client.test.ts tests/service-worker.test.ts
git commit -m "feat: add GET_SCAN_USAGE message and getScanUsage client"
```

---

### Task 6: Client-side deny cache

**Files:**
- New: `src/shared/usage-storage.ts`
- Test: `tests/usage-storage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/usage-storage.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { getCachedScanUsage, setCachedScanUsage } from '../src/shared/usage-storage';

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = createChromeMock();
});

describe('usage-storage', () => {
  it('returns null when nothing has been cached', async () => {
    expect(await getCachedScanUsage()).toBeNull();
  });

  it('round-trips a cached value', async () => {
    await setCachedScanUsage({ tier: 'free', remaining: 0, resetsAt: '2026-08-01T00:00:00.000Z' });

    expect(await getCachedScanUsage()).toEqual({ tier: 'free', remaining: 0, resetsAt: '2026-08-01T00:00:00.000Z' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

`npm test -- usage-storage.test.ts`

- [ ] **Step 3: Write `src/shared/usage-storage.ts`**

```ts
export interface CachedScanUsage {
  tier: 'free' | 'pro';
  remaining: number | null;
  resetsAt: string;
}

const USAGE_STORAGE_KEY = 'fontcia-scan-usage';

export async function getCachedScanUsage(): Promise<CachedScanUsage | null> {
  const result = await chrome.storage.local.get(USAGE_STORAGE_KEY);
  return (result[USAGE_STORAGE_KEY] as CachedScanUsage | undefined) ?? null;
}

export async function setCachedScanUsage(usage: CachedScanUsage): Promise<void> {
  await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: usage });
}
```

- [ ] **Step 4: Run tests to verify they pass**

`npm test -- usage-storage.test.ts`

- [ ] **Step 5: Verify typecheck**

`npm run typecheck`

- [ ] **Step 6: Commit**

```
git add src/shared/usage-storage.ts tests/usage-storage.test.ts
git commit -m "feat: add usage-storage, a chrome.storage.local deny-cache for scan usage"
```

---

### Task 7: `renderLimitReachedState`

**Files:**
- Modify: `src/content/scan-dialogue.ts`
- Test: `tests/scan-dialogue.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('renderLimitReachedState', () => {
  it('renders a limit message and a disabled Upgrade to Pro button', () => {
    const body = document.createElement('div');

    renderLimitReachedState(body, '2026-08-01T00:00:00.000Z', vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toContain("hit your monthly scan limit");

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const upgradeBtn = buttons.find((b) => b.textContent === 'Upgrade to Pro') as HTMLButtonElement;
    expect(upgradeBtn.disabled).toBe(true);
  });

  it('renders without a resets-at date when none is given', () => {
    const body = document.createElement('div');

    renderLimitReachedState(body, null, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe("You've hit your monthly scan limit.");
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderLimitReachedState(body, null, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

`npm test -- scan-dialogue.test.ts`

- [ ] **Step 3: Write `renderLimitReachedState` in `src/content/scan-dialogue.ts`**

```ts
export function renderLimitReachedState(body: HTMLElement, resetsAt: string | null, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = resetsAt
    ? `You've hit your monthly scan limit. Resets ${new Date(resetsAt).toLocaleDateString()}.`
    : "You've hit your monthly scan limit.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const upgradeBtn = document.createElement('button');
  upgradeBtn.type = 'button';
  upgradeBtn.className = 'fontcia-btn fontcia-btn-secondary';
  upgradeBtn.textContent = 'Upgrade to Pro';
  upgradeBtn.disabled = true;
  actions.appendChild(upgradeBtn);

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
```

- [ ] **Step 4: Run tests to verify they pass**

`npm test -- scan-dialogue.test.ts`

- [ ] **Step 5: Verify typecheck**

`npm run typecheck`

- [ ] **Step 6: Commit**

```
git add src/content/scan-dialogue.ts tests/scan-dialogue.test.ts
git commit -m "feat: add renderLimitReachedState with a disabled Upgrade to Pro button"
```

---

### Task 8: Gate `handleScan` in `locked-selection.ts`

**Files:**
- Modify: `src/content/locked-selection.ts`
- Test: `tests/locked-selection.test.ts`

- [ ] **Step 1: Update the shared `beforeEach` mock, then write the failing tests**

First, extend the file's existing shared mock so the ~15 pre-existing "logged in, click Scan" tests keep exercising the allowed path instead of hitting the new fail-open guard on a null `data`:

```ts
beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') {
      return { ok: true, data: { loggedIn: true } };
    }
    if (message.type === 'GET_SCAN_USAGE') {
      return { ok: true, data: { tier: 'free', used: 1, limit: 20, remaining: 19, resetsAt: '2026-08-01T00:00:00.000Z' } };
    }
    return { ok: true, data: null };
  });
});
```

Then add new tests:

```ts
it('does not check usage at all when logged out, and proceeds straight to scanning', async () => {
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: false } };
    throw new Error(`unexpected message ${message.type}`);
  });
  const container = document.createElement('div');
  const scanFn = vi.fn(() => Promise.resolve({ status: 'no-match' as const }));

  const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn(), scanFn);
  (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(scanFn).toHaveBeenCalled();
});

it('proceeds to scan when a logged-in user is under the limit', async () => {
  const container = document.createElement('div');
  const scanFn = vi.fn(() => Promise.resolve({ status: 'no-match' as const }));

  const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn(), scanFn);
  (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(scanFn).toHaveBeenCalled();
});

it('shows the limit-reached state and never calls scanFn when a logged-in user is over the limit', async () => {
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
    if (message.type === 'GET_SCAN_USAGE') {
      return { ok: true, data: { tier: 'free', used: 20, limit: 20, remaining: 0, resetsAt: '2026-08-01T00:00:00.000Z' } };
    }
    return { ok: true, data: null };
  });
  const container = document.createElement('div');
  const scanFn = vi.fn(() => Promise.resolve({ status: 'no-match' as const }));

  const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn(), scanFn);
  (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(scanFn).not.toHaveBeenCalled();
  expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toContain('hit your monthly scan limit');
});

it('uses the cached deny without a network call when already known to be over limit', async () => {
  const { getCachedScanUsage } = await import('../src/shared/usage-storage');
  // Pre-seed the cache via a real setCachedScanUsage call so this test exercises
  // the same storage path production code uses, not a hand-rolled mock shortcut.
  const { setCachedScanUsage } = await import('../src/shared/usage-storage');
  await setCachedScanUsage({ tier: 'free', remaining: 0, resetsAt: '2099-01-01T00:00:00.000Z' });

  let usageCallCount = 0;
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
    if (message.type === 'GET_SCAN_USAGE') {
      usageCallCount++;
      return { ok: true, data: { tier: 'free', used: 20, limit: 20, remaining: 0, resetsAt: '2099-01-01T00:00:00.000Z' } };
    }
    return { ok: true, data: null };
  });
  const container = document.createElement('div');
  const scanFn = vi.fn(() => Promise.resolve({ status: 'no-match' as const }));

  const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn(), scanFn);
  (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(usageCallCount).toBe(0);
  expect(scanFn).not.toHaveBeenCalled();
  await getCachedScanUsage(); // sanity: storage module usable, no throw
});

it('fails open and proceeds to scan when the usage check errors', async () => {
  chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
    if (message.type === 'GET_SCAN_USAGE') throw new Error('network down');
    return { ok: true, data: null };
  });
  const container = document.createElement('div');
  const scanFn = vi.fn(() => Promise.resolve({ status: 'no-match' as const }));

  const { panel } = renderLockedSelection(container, { x: 10, y: 20, width: 200, height: 30 }, vi.fn(), vi.fn(), scanFn);
  (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  expect(scanFn).toHaveBeenCalled();
});
```

Note: the cache is `chrome.storage.local`-backed via `createChromeMock()`, which (per the existing mock helper's own established behavior for other storage-backed tests in this suite) persists only for the lifetime of one test unless the mock helper itself resets between tests — confirm against `tests/helpers/chrome-mock.ts`'s actual reset behavior and adjust the cache test's setup/teardown accordingly if it turns out state leaks across tests.

- [ ] **Step 2: Run tests to verify they fail**

`npm test -- locked-selection.test.ts` — expected: new tests fail (`checkUsageAllowed` doesn't exist yet), and note whether any *pre-existing* tests in this file also newly fail before Step 1's mock update — they shouldn't, since that update was applied first, but double check.

- [ ] **Step 3: Add imports and `checkUsageAllowed` to `src/content/locked-selection.ts`**

```ts
import { renderLimitReachedState /* ...existing imports... */ } from './scan-dialogue';
import { getCachedScanUsage, setCachedScanUsage } from '../shared/usage-storage';
import type { ScanUsage } from '../background/api-client';
```

```ts
async function checkUsageAllowed(): Promise<{ allowed: boolean; resetsAt: string | null }> {
  let isLoggedIn = false;
  try {
    const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
    isLoggedIn = authRes.ok && authRes.data.loggedIn;
  } catch (error: unknown) {
    console.error('fontCIA: failed to check auth state', error);
  }
  if (!isLoggedIn) return { allowed: true, resetsAt: null };

  const cached = await getCachedScanUsage();
  if (
    cached &&
    cached.tier === 'free' &&
    cached.remaining !== null &&
    cached.remaining <= 0 &&
    Date.now() < new Date(cached.resetsAt).getTime()
  ) {
    return { allowed: false, resetsAt: cached.resetsAt };
  }

  try {
    const usageRes = await sendApiMessage<ScanUsage>({ type: 'GET_SCAN_USAGE' });
    if (!usageRes.ok || !usageRes.data) return { allowed: true, resetsAt: null };
    const { tier, remaining, resetsAt } = usageRes.data;
    await setCachedScanUsage({ tier, remaining, resetsAt });
    if (tier === 'free' && remaining !== null && remaining <= 0) {
      return { allowed: false, resetsAt };
    }
    return { allowed: true, resetsAt: null };
  } catch (error: unknown) {
    console.error('fontCIA: failed to check scan usage', error);
    return { allowed: true, resetsAt: null };
  }
}
```

- [ ] **Step 4: Wire it into `handleScan`**

```ts
function handleScan(): void {
  renderLoadingState(body);
  checkUsageAllowed().then(({ allowed, resetsAt }) => {
    if (disposed) return;
    if (!allowed) {
      renderLimitReachedState(body, resetsAt, onRestart);
      return;
    }
    scanFn(rect)
      .then((result) => {
        logScanResult(result);
        if (disposed) return;
        if (result.status === 'match') {
          showResult(result);
        } else if (result.status === 'no-match' && result.reason === 'no-text') {
          handleNoTextResult();
        } else if (result.status === 'no-match' && result.reason === 'unrecognized') {
          void handleUnrecognized(result.detectedFontFamily, result.detectedConfidence);
        } else {
          renderNoMatchState(body, onRestart);
        }
      })
      .catch((error: unknown) => {
        logScanResult({ status: 'no-match', reason: 'error' });
        if (disposed) return;
        console.error('fontCIA: font resolution failed', error);
        renderNoMatchState(body, onRestart);
      });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

`npm test -- locked-selection.test.ts`

- [ ] **Step 6: Run the full client test suite and typecheck**

`npm test && npm run typecheck` (from the repo root)

- [ ] **Step 7: Commit**

```
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: gate handleScan on usage, add limit-reached state and deny-cache short-circuit"
```

---

### Task 9: Build verification and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full build**

`npm run build` (root) and `npm run build` (server) — expected: both build cleanly with no errors, matching every prior sub-project's final verification step.

- [ ] **Step 2: Full test suites**

`npm test` at the repo root and inside `server/` — expected: all green, including the full pre-existing suite (not just this sub-project's new files).

- [ ] **Step 3: Optional manual smoke test**

Seed a test user directly via Prisma Studio or a raw `UPDATE "User" SET tier = 'pro' WHERE email = '...'` to confirm the Pro path never blocks; separately, create 20 `Scan` rows for a Free-tier test user (either through 20 real scans or direct inserts) and confirm the 21st click on Scan renders the limit-reached state with the disabled Upgrade to Pro button, and that a subsequent scan attempt doesn't even fire a network request (deny-cache short-circuit, visible in the Network tab).

- [ ] **Step 4: Commit** (only if Step 3 surfaced a fix)

Skip if nothing needed changing.
