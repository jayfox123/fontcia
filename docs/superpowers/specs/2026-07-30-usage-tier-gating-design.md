# fontCIA — Usage/Tier Gating Design (Step 8)

**Status:** Approved
**Scope:** Enforce the Free (20 scans/month) and Pro (unlimited) tiers using the scan-logging data already being captured. Real payment processing (Stripe or similar) is explicitly out of scope — this sub-project builds the tracking and gating plumbing and the schema to represent a user's tier; billing is a thin follow-up later.

## Context

`Scan` rows have been created on every scan attempt (match or no-match, logged-in or anonymous) since sub-project 4a, purely for logging — nothing has ever read them back to make a decision. `CLAUDE_CODE_INSTRUCTIONS.md` scoped this from the start: "implement the scan-count tracking and gating logic; real payment processing... can be a thin follow-up once the core product works, but the usage-tracking and rate-limiting plumbing should exist from the start, don't retrofit it later." This is that plumbing.

There is no `role`/`tier`/billing field anywhere in the schema today. `User` has never needed one.

## Confirmed decisions

- **`User.tier` is a schema flag only, no billing behind it.** Defaults to `'free'`. Nothing in this sub-project can move a user to `'pro'` except a direct database write (or, later, a real billing integration) — there is no self-serve upgrade endpoint, checkout flow, or admin UI. Stating this plainly rather than implying more exists.
- **No new usage-counter table.** Monthly usage is a live `COUNT` against existing `Scan` rows (`userId` + `createdAt`), computed on demand — exactly the data already being captured, not a new source of truth to keep in sync. Counting window is calendar month, UTC.
- **Every scan attempt counts against quota, match or no-match alike** — including local-resolution errors, which already produce a logged `Scan` row today (`logScanResult({status: 'no-match', reason: 'error'})` in `locked-selection.ts`). An attempt consumes a scan, not just a successful one.
- **Anonymous scanning stays completely uncapped.** Tiers are an account-level concept; there is no tier to check without a `userId`. IP-based abuse-prevention for anonymous scanning is a distinct, separate, deferred concern (would reuse `express-rate-limit`, the same pattern `auth-rate-limit.ts` already applies to `/auth/signup` and `/auth/login`) — not built here.
- **Two enforcement points, not one, because the DOM and AI paths have fundamentally different server touchpoints:**
  - The **AI path** always calls `POST /font-matches`, which now runs the quota check as middleware before the expensive DINOv2 embedding call — genuinely unbypassable, and it protects the actual compute cost, not just the business limit.
  - The **DOM path** never touches the server at all for resolution (by design — see "DOM font resolution must stay fast and local first" in `memory.md`). The only place a limit can be enforced for it is a **pre-flight check before resolution starts**. This is the sole enforcement mechanism available for that path, not an optimization layered on top of a "real" server-side gate. Being explicit about the consequence: a maliciously modified client could ignore the pre-flight response and resolve locally anyway. That's a structural fact of a local-first DOM architecture already committed to, not a gap specific to this design — the same trust model anonymous scanning already accepts.
  - `POST /scans` also gets the same middleware, for consistency, even though by the time it fires the DOM path's result is already rendered client-side. Belt and suspenders, not a behavior change.
- **The pre-flight check is a new `GET /scans/usage` endpoint**, not folded into the existing fire-and-forget `LOG_SCAN`/`POST /scans` call — `POST /scans` records an outcome that isn't known until *after* resolution runs, so it can't double as a *before* gate.
- **A client-side cache short-circuits the common "already capped" case, but only in the deny direction.** Once a fresh check comes back denied, that fact (tier, remaining, resetsAt) is cached in `chrome.storage.local` and reused to skip the network round trip on the next Scan click, until the cached `resetsAt` passes. It is never used to *allow* a scan without checking — an optimistic "remaining: 12" cached value could drift as the user keeps scanning, so every non-denied path still asks the server fresh. This avoids repeated wasted round trips for a user who's already capped and keeps clicking Scan, without ever substituting for the server as the real gate.
- **The pre-flight check fails open.** If `GET_AUTH_STATE` or `GET /scans/usage` errors (offline, service worker asleep, malformed response), the scan proceeds. Consistent with this project's existing resilience posture (`handleApiMessage` never rejects; a network hiccup degrades gracefully rather than bricking the product's core action). The AI path's `POST /font-matches` middleware remains the hard backstop regardless.
- **Anonymous users pay no added latency.** `handleScan()` already needs to know login state before rendering a result (existing `GET_AUTH_STATE` calls elsewhere in `locked-selection.ts`); this sub-project adds one more such local, no-network check at the top of the scan flow. Only when that check reports a logged-in user does anything hit the network. This check is not literally free — it's one more local message-passing round trip through the service worker, same cost class already paid elsewhere in this file — but it adds no network latency, and none at all for anonymous users beyond that.
- **A dedicated `renderLimitReachedState` UI state**, structurally matching `renderNoMatchState`/`renderCaptureBlockedState` (message + action buttons), not the generic error state. Includes a disabled "Upgrade to Pro" button, matching the precedent Step 2 set with the disabled "Name it" button in `renderNoMatchState` — Pro billing is an explicitly planned follow-up, not speculative, the same position "Name it" was in before Step 5 wired it up.
- **In the normal (unmodified extension) flow, `POST /font-matches`'s own limit check is never actually hit by a denied user** — the top-level `handleScan()` gate already blocks before `scanFn` runs at all, and the AI path is only ever reached from inside `scanFn`'s no-text branch. The middleware there is a true architectural backstop, reachable only via direct/bypassing access, not a path the UI exercises in practice. No special "detect a 403 and show the limit-reached state" handling is added to `handleImageCapture`'s existing error path — that stays on `renderMatchErrorState`, unchanged.

## Architecture

### File structure

```
server/prisma/schema.prisma       — User gains tier
server/prisma/migrations/         — new migration: add_user_tier

server/src/lib/usage.ts           — new: FREE_TIER_MONTHLY_LIMIT, getMonthlyUsage(userId)
server/tests/usage.test.ts        — new

server/src/middleware/enforce-usage-limit.ts — new: enforceUsageLimit
server/tests/enforce-usage-limit.test.ts     — new (or folded into the two routers' own test files)

server/src/routes/scans.ts        — gains GET /usage (requireAuth), enforceUsageLimit on POST /
server/tests/scans.test.ts        — new GET /usage tests, new POST / over-limit test

server/src/routes/font-matches.ts — enforceUsageLimit added to the existing route chain
server/tests/font-matches.test.ts — new over-limit test

src/shared/api-messages.ts        — gains GET_SCAN_USAGE
src/background/api-client.ts      — gains ScanUsage, getScanUsage()
tests/api-client.test.ts          — new tests for the above
src/background/service-worker.ts  — one new dispatch case
tests/service-worker.test.ts      — new test for the above

src/shared/usage-storage.ts       — new: CachedScanUsage, getCachedScanUsage()/setCachedScanUsage()
tests/usage-storage.test.ts       — new

src/content/scan-dialogue.ts      — gains renderLimitReachedState
tests/scan-dialogue.test.ts       — new tests for the above

src/content/locked-selection.ts   — modified: handleScan gated by a new checkUsageAllowed()
tests/locked-selection.test.ts    — new tests; shared beforeEach mock gains a GET_SCAN_USAGE case
```

### Database / server

```prisma
model User {
  // ...existing fields...
  tier String @default("free") // 'free' | 'pro'
}
```

```ts
// server/src/lib/usage.ts
import { prisma } from './prisma';

export const FREE_TIER_MONTHLY_LIMIT = 20;

export interface UsageInfo {
  tier: 'free' | 'pro';
  used: number;
  limit: number | null;    // null = unlimited (pro)
  remaining: number | null; // null = unlimited (pro)
  resetsAt: string;         // ISO timestamp, start of next UTC month
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

`used` is computed unconditionally, even for Pro — cheap (one indexed count), and means the value is honest/available if a future Settings view ever wants to show "X scans this month" regardless of tier.

Known imprecision, stated explicitly rather than glossed over: this is a live `COUNT`, not an atomic increment. Two scans firing back-to-back right at the boundary could both read the same pre-increment count and both be allowed, overshooting the cap by a small amount. Consistent with this project's other "reasonable starting point, not bulletproof" constants (`CONFIRMATION_THRESHOLD`, `MARGIN_THRESHOLD`).

```ts
// server/src/middleware/enforce-usage-limit.ts
import type { Request, Response, NextFunction } from 'express';
import { getMonthlyUsage } from '../lib/usage';
import { ApiError } from './error-handler';

export async function enforceUsageLimit(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) {
    next(); // anonymous — nothing to gate
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

Applied after `optionalAuth` (so `req.userId` is populated when present) and before any real work:

```ts
// scans.ts
scansRouter.post('/', optionalAuth, enforceUsageLimit, async (req, res, next) => { /* unchanged body */ });

scansRouter.get('/usage', requireAuth, async (req, res, next) => {
  try {
    const usage = await getMonthlyUsage(req.userId!);
    res.status(200).json(usage);
  } catch (error) {
    next(error);
  }
});

// font-matches.ts
fontMatchesRouter.post('/', optionalAuth, enforceUsageLimit, upload.single('image'), async (req, res, next) => { /* unchanged body */ });
```

`enforceUsageLimit` sits before `upload.single('image')` on `POST /font-matches` specifically so a denied request never pays even the multipart-parse cost, let alone the embedding call.

### Client message contract

```ts
// src/shared/api-messages.ts
| { type: 'GET_SCAN_USAGE' }
```

```ts
// src/background/api-client.ts
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

`service-worker.ts`'s `handleApiMessage` gains one matching case, same shape as every other dispatch entry:
```ts
case 'GET_SCAN_USAGE':
  return await getScanUsage();
```

### Client-side deny cache

```ts
// src/shared/usage-storage.ts
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

Direct `chrome.storage.local` access, no message-passing — same precedent `theme-storage.ts` already set for a value with no refresh-token-style mediation requirement. Only the three fields needed for the local gating decision are cached; `used`/`limit` aren't, since they're not used to decide anything client-side.

### `locked-selection.ts` — gating `handleScan`

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
        /* ...unchanged... */
      })
      .catch((error: unknown) => {
        /* ...unchanged... */
      });
  });
}
```

The loading spinner (already rendered synchronously at the top of `handleScan`, unchanged) briefly holds through the usage check before either the real scan or the limit-reached state takes over — same "generic spinner stays up through a quick check" treatment `handleUnrecognized`'s doc comment already describes for its own extra lookup tier.

### New UI state

```ts
// src/content/scan-dialogue.ts
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

Structurally identical to `renderNoMatchState`'s message-plus-disabled-button-plus-New-scan shape. `date.toLocaleDateString()` matches the formatting convention `saved-fonts-view.ts`/`history-view.ts` already established.

## Testing

Server: `usage.test.ts` covers `getMonthlyUsage` directly against real Postgres (free vs. pro, count scoped to the calling user and to the current month, zero-usage default). `scans.test.ts` gains `GET /usage` coverage (requires auth, correct shape, reflects prior scans) and a `POST /` over-limit test. `font-matches.test.ts` gains an over-limit test asserting a 403 with no embedding-service call made (`getEmbedding` not called). `enforce-usage-limit.test.ts` covers the middleware directly: no-ops for anonymous, allows Pro regardless of count, blocks Free at/over `FREE_TIER_MONTHLY_LIMIT`.

Client: `usage-storage.test.ts` mirrors `theme-storage.test.ts` (round-trip, default-to-null). `api-client.test.ts`/`service-worker.test.ts` get one new case each, matching the `getSavedFonts`/`getScans` precedent exactly. `scan-dialogue.test.ts` gains `renderLimitReachedState` coverage (message text, disabled Upgrade button, New scan click). `locked-selection.test.ts` gains: allowed-when-anonymous (no `GET_SCAN_USAGE` call made at all), allowed-when-under-limit, denied-when-over-limit (renders limit-reached, `scanFn` never called), denied-from-cache-without-a-network-call, and fail-open-on-usage-check-error. The shared `beforeEach` chrome mock in that file gains a `GET_SCAN_USAGE` case returning a generous "plenty remaining" default, so the ~15 existing "logged in, click Scan" tests continue exercising the allowed path rather than silently hitting the new fail-open guard.

## Out of scope for this spec

Real payment processing (Stripe or any billing integration). A self-serve upgrade flow or checkout UI — the "Upgrade to Pro" button is intentionally disabled. Any admin/moderator UI for changing a user's tier. Prorating, grandfathering, or any tier-change edge case (there is no tier-change mechanism yet to have edge cases). Atomic/race-proof usage counting. Anonymous/IP-based rate limiting. Any change to how `Scan` rows are created or what they store. Surfacing usage (e.g. "12/20 scans used") anywhere in the account dashboard's Settings view — `getMonthlyUsage` returns enough to support that later, but wiring it into Settings wasn't requested here.
