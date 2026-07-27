# Multi-Source Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing `Font` table with `matchKeys` and a real `FontSource` table, connect Step 5's promotion mechanism to actually create findable fonts with correctly-voted, per-confirmer-attributed sources, and add a local-first-with-server-fallback resolution tier to the DOM scan path.

**Architecture:** Unify around the existing `Font`/`FontEmbedding` tables rather than a parallel model. `checkAndPromote` (already built in Step 5) gets extended to create a `Font` + deduped `FontSource` rows on promotion, using per-person URL attribution from both the original submission and each confirmation. A new `GET /fonts/resolve` endpoint serves DOM-path fallback lookups. `locked-selection.ts`'s `handleScan` gains one more fallback tier for the `'unrecognized'` reason, mirroring the existing `'no-text'` → AI-image-matching fallback structure exactly.

**Tech Stack:** TypeScript, Express, Prisma/Postgres, Chrome Extension Manifest V3, Vitest + jsdom (client) / Vitest + supertest + real Postgres (server) — all existing conventions, no new dependencies.

---

## File Structure

```
server/prisma/schema.prisma              — Font gains matchKeys + optional googleSlug, new FontSource
                                            model, FontSubmissionConfirmation gains sourceUrl
server/tests/helpers/reset-db.ts         — adds FontSource to the truncate list
server/src/routes/font-submissions.ts    — checkAndPromote creates Font+FontSource; POST / stops
                                            backfilling onto FontSubmission.sourceUrl, stores the
                                            resubmitter's own sourceUrl on their confirmation instead;
                                            POST /:id/confirm accepts an optional sourceUrl body
server/tests/font-submissions.test.ts    — one existing test replaced (backfill → per-confirmation
                                            attribution), new tests for Font/FontSource creation
server/src/routes/fonts.ts               — new: GET /resolve
server/tests/fonts.test.ts               — new
server/src/app.ts                        — mounts fontsRouter

src/shared/api-messages.ts               — gains RESOLVE_FONT_NAME; CONFIRM_FONT_SUBMISSION gains
                                            a sourceUrl field
src/background/api-client.ts             — confirmFontSubmission gains a sourceUrl param; new
                                            resolveFontName
tests/api-client.test.ts                 — updated + new tests for the above
src/background/service-worker.ts         — RESOLVE_FONT_NAME case in handleApiMessage;
                                            CONFIRM_FONT_SUBMISSION case passes sourceUrl through
tests/service-worker.test.ts             — updated + new tests for the above

src/content/scan-types.ts                — NoMatchResult gains detectedFontFamily/detectedConfidence
src/content/font-resolver.ts             — resolveFromReadings stops discarding them for 'unrecognized'
tests/font-resolver.test.ts              — updated + new test for the new fields

src/content/scan-dialogue.ts             — renderEnrollmentFormState's suggestion click also reads
                                            the source-URL field and passes it through
tests/scan-dialogue.test.ts              — updated + new test for the above
src/content/enrollment.ts                — handleConfirmExisting threads the sourceUrl through
tests/enrollment.test.ts                 — updated + new test for the above

src/content/locked-selection.ts          — handleScan's 'unrecognized' branch tries the new server
                                            fallback (mirroring the existing 'no-text' → AI-image
                                            fallback structure) before rendering the enrollment prompt
tests/locked-selection.test.ts           — new tests for the fallback's success/failure/skip paths
```

No new files needed on the content-script side — every UI change is a small, targeted extension of an existing function, not a new responsibility that warrants its own module (unlike Step 5's `enrollment.ts` extraction, which was justified by a genuinely new, self-contained state machine).

---

### Task 1: Server Schema

**Files:**
- Modify: `server/prisma/schema.prisma`, `server/tests/helpers/reset-db.ts`

No dedicated test in this task — every new field/model uses standard Prisma scalar types, verified naturally by Task 2/3's route tests, matching this project's established treatment of pure schema tasks (e.g. Step 5's Task 1).

- [ ] **Step 1: Apply the schema changes to `server/prisma/schema.prisma`**

Change the `Font` model from:
```prisma
model Font {
  id         String          @id @default(uuid())
  name       String          @unique
  googleSlug String
  category   String?
  embeddings FontEmbedding[]
}
```
to:
```prisma
model Font {
  id         String          @id @default(uuid())
  name       String          @unique
  googleSlug String?
  category   String?
  matchKeys  String[]        @default([])
  embeddings FontEmbedding[]
  sources    FontSource[]
}
```

`googleSlug` becomes optional because promoted community fonts have no Google Fonts slug at all. This is safe for the AI image-matching path: `/font-matches`' query only ever returns rows that have a `FontEmbedding`, and only the curated catalog (seeded via `build-reference-set.ts`, which always sets `googleSlug`) ever gets embedded — a promoted font, which never gets embedded, can never appear in that result set to begin with.

Add the new `FontSource` model, and add `sourceUrl` to `FontSubmissionConfirmation`, at the end of the file:
```prisma

model FontSource {
  id        String   @id @default(uuid())
  fontId    String
  font      Font     @relation(fields: [fontId], references: [id])
  url       String
  label     String
  votes     Int      @default(1)
  createdAt DateTime @default(now())
}
```

Change `FontSubmissionConfirmation` from:
```prisma
model FontSubmissionConfirmation {
  id           String         @id @default(uuid())
  submissionId String
  submission   FontSubmission @relation(fields: [submissionId], references: [id])
  confirmedBy  String
  confirmer    User           @relation(fields: [confirmedBy], references: [id])
  createdAt    DateTime       @default(now())

  @@unique([submissionId, confirmedBy])
}
```
to:
```prisma
model FontSubmissionConfirmation {
  id           String         @id @default(uuid())
  submissionId String
  submission   FontSubmission @relation(fields: [submissionId], references: [id])
  confirmedBy  String
  confirmer    User           @relation(fields: [confirmedBy], references: [id])
  sourceUrl    String?
  createdAt    DateTime       @default(now())

  @@unique([submissionId, confirmedBy])
}
```

- [ ] **Step 2: Generate and apply the migration**

Run (from `server/`):
```bash
npx prisma migrate dev --name add_font_sources_and_matchkeys
```
Expected: a new migration under `server/prisma/migrations/<timestamp>_add_font_sources_and_matchkeys/`, applied to `fontcia_dev`. All changes here are standard Prisma-supported types (nullable column, array column with a default, a new table, a new nullable column) — no manual SQL editing needed.

- [ ] **Step 3: Apply the same migration to the test database**

Run (from `server/`):
```bash
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_test" npx prisma migrate deploy
```
Expected: reports the new migration applied successfully.

- [ ] **Step 4: Add `FontSource` to the test-reset helper**

Change `server/tests/helpers/reset-db.ts` from:
```ts
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "FontSubmissionConfirmation", "FontSubmission", "User", "FontEmbedding", "Font" RESTART IDENTITY CASCADE',
```
to:
```ts
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "FontSubmissionConfirmation", "FontSubmission", "User", "FontEmbedding", "FontSource", "Font" RESTART IDENTITY CASCADE',
```

(`FontSource` listed before `Font`, matching the existing child-before-parent documentation convention, though `RESTART IDENTITY CASCADE` would handle the ordering regardless.)

- [ ] **Step 5: Run typecheck and the full test suite**

Run (from `server/`): `npx tsc --noEmit && npm test`
Expected: clean typecheck; all existing tests still pass (nothing yet depends on the new fields).

- [ ] **Step 6: Commit**

```bash
git add server/prisma server/tests/helpers/reset-db.ts
git commit -m "feat: add Font.matchKeys, FontSource, and per-confirmation sourceUrl to the schema"
```

---

### Task 2: `font-submissions.ts` — Promotion Creates Findable Fonts

**Files:**
- Modify: `server/src/routes/font-submissions.ts`
- Test: `server/tests/font-submissions.test.ts`

This task changes existing, already-shipped behavior (the sourceUrl-backfill-onto-the-submission logic is removed, replaced by per-confirmation attribution) as well as adding new behavior (`checkAndPromote` creating `Font`/`FontSource` rows, `POST /:id/confirm` accepting an optional body). One existing test is replaced; several are extended with new assertions or left as regression coverage for the unchanged parts of the flow.

- [ ] **Step 1: Replace the sourceUrl-backfill test and add new tests for Font/FontSource creation**

In `server/tests/font-submissions.test.ts`, replace the existing test:
```ts
  it('fills in a missing sourceUrl from a confirming resubmission without overwriting an existing one', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerToken}`)
      .field('fontName', 'Brandon Grotesque')
      .field('sourceUrl', 'https://example.com/brandon')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const stored = await prisma.fontSubmission.findUnique({ where: { id: firstRes.body.submissionId } });
    expect(stored?.sourceUrl).toBe('https://example.com/brandon');
  });
```
with:
```ts
  it("stores a confirming resubmitter's own sourceUrl on their confirmation, without touching the original submission's sourceUrl", async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerToken}`)
      .field('fontName', 'Brandon Grotesque')
      .field('sourceUrl', 'https://example.com/brandon')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const stored = await prisma.fontSubmission.findUnique({ where: { id: firstRes.body.submissionId } });
    expect(stored?.sourceUrl).toBeNull();

    const confirmation = await prisma.fontSubmissionConfirmation.findFirst({
      where: { submissionId: firstRes.body.submissionId },
    });
    expect(confirmation?.sourceUrl).toBe('https://example.com/brandon');
  });
```

Add these new tests inside the same `describe('POST /font-submissions', ...)` block, after the (now-replaced) test above and before the `'resubmitting your own pending font name...'` test:
```ts
  it('creates a findable Font row with deduped, correctly-voted FontSource rows on promotion', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .field('sourceUrl', 'https://fonts.adobe.com/fonts/brandon-grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerAToken}`)
      .send({ sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque' });

    const confirmerBToken = await signupUser('confirmer-b@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`)
      .send({ sourceUrl: 'https://www.myfonts.com/fonts/brandon-grotesque' });

    const font = await prisma.font.findUnique({
      where: { name: 'Brandon Grotesque' },
      include: { sources: true },
    });
    expect(font).not.toBeNull();
    expect(font?.matchKeys).toEqual(['brandon grotesque']);
    expect(font?.sources).toHaveLength(2);

    const adobeSource = font?.sources.find((s) => s.url === 'https://fonts.adobe.com/fonts/brandon-grotesque');
    expect(adobeSource?.votes).toBe(2);
    expect(adobeSource?.label).toBe('fonts.adobe.com');

    const myFontsSource = font?.sources.find((s) => s.url === 'https://www.myfonts.com/fonts/brandon-grotesque');
    expect(myFontsSource?.votes).toBe(1);
    expect(myFontsSource?.label).toBe('www.myfonts.com');
  });

  it('promotes with zero FontSource rows when nobody proposed a sourceUrl', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerAToken}`);

    const confirmerBToken = await signupUser('confirmer-b@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`);

    const font = await prisma.font.findUnique({ where: { name: 'Brandon Grotesque' }, include: { sources: true } });
    expect(font).not.toBeNull();
    expect(font?.sources).toHaveLength(0);
  });

  it('reuses an existing Font row case-insensitively rather than violating the unique name constraint', async () => {
    await prisma.font.create({ data: { name: 'Brandon Grotesque', matchKeys: ['brandon grotesque'] } });

    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'brandon grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerAToken}`);
    const confirmerBToken = await signupUser('confirmer-b@example.com');
    const finalRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`);

    expect(finalRes.body.status).toBe('promoted');
    const fonts = await prisma.font.findMany({ where: { name: { equals: 'brandon grotesque', mode: 'insensitive' } } });
    expect(fonts).toHaveLength(1);
  });
```

Also add these two new tests inside the `describe('POST /font-submissions/:id/confirm', ...)` block, after the existing `'is idempotent...'` test:
```ts
  it('accepts an optional sourceUrl body and stores it on the confirmation', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`)
      .send({ sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque' });

    const confirmation = await prisma.fontSubmissionConfirmation.findFirst({
      where: { submissionId: firstRes.body.submissionId },
    });
    expect(confirmation?.sourceUrl).toBe('https://fonts.adobe.com/fonts/brandon-grotesque');
  });

  it('rejects an invalid sourceUrl in the confirm body instead of crashing', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    const res = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`)
      .send({ sourceUrl: 'not-a-url' });

    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify the new/replaced ones fail**

Run (from `server/`): `npx vitest run tests/font-submissions.test.ts`
Expected: FAIL — the replaced test's new assertions don't match current behavior (backfill still happens); the new Font/FontSource/confirm-body tests fail since none of that logic exists yet.

- [ ] **Step 3: Update `server/src/routes/font-submissions.ts`**

Add a `hostnameOf` helper and rewrite `checkAndPromote`. Change from:
```ts
async function checkAndPromote(submissionId: string): Promise<void> {
  const submission = await prisma.fontSubmission.findUnique({
    where: { id: submissionId },
    include: { _count: { select: { confirmations: true } } },
  });
  if (!submission || submission.status !== 'pending') return;
  const supporterCount = 1 + submission._count.confirmations;
  if (supporterCount >= CONFIRMATION_THRESHOLD) {
    await prisma.fontSubmission.update({ where: { id: submissionId }, data: { status: 'promoted' } });
  }
}
```
to:
```ts
function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

async function checkAndPromote(submissionId: string): Promise<void> {
  const submission = await prisma.fontSubmission.findUnique({
    where: { id: submissionId },
    include: { confirmations: true },
  });
  if (!submission || submission.status !== 'pending') return;
  const supporterCount = 1 + submission.confirmations.length;
  if (supporterCount < CONFIRMATION_THRESHOLD) return;

  // Each distinct proposed URL becomes its own ranked source, with votes equal
  // to how many distinct people proposed exactly that URL — the submission's
  // own sourceUrl (attributed to the original submitter) and each
  // confirmation's sourceUrl (attributed to that confirmer) are tracked
  // independently and never merged onto each other's row, so a URL can never
  // be double-counted as coming from two people when only one actually
  // proposed it.
  const proposals = new Map<string, Set<string>>();
  function addProposal(url: string | null, proposerId: string): void {
    if (!url) return;
    const proposers = proposals.get(url) ?? new Set<string>();
    proposers.add(proposerId);
    proposals.set(url, proposers);
  }
  addProposal(submission.sourceUrl, submission.submittedBy);
  for (const confirmation of submission.confirmations) {
    addProposal(confirmation.sourceUrl, confirmation.confirmedBy);
  }

  await prisma.$transaction(async (tx) => {
    let font = await tx.font.findFirst({
      where: { name: { equals: submission.fontName, mode: 'insensitive' } },
    });
    if (!font) {
      font = await tx.font.create({
        data: { name: submission.fontName, matchKeys: [submission.fontName.toLowerCase()] },
      });
    }

    const existingSources = await tx.fontSource.findMany({ where: { fontId: font.id } });
    const existingUrls = new Set(existingSources.map((s) => s.url));

    for (const [url, proposers] of proposals) {
      if (existingUrls.has(url)) continue;
      await tx.fontSource.create({
        data: { fontId: font.id, url, label: hostnameOf(url), votes: proposers.size },
      });
    }

    await tx.fontSubmission.update({ where: { id: submissionId }, data: { status: 'promoted' } });
  });
}
```

Change the `POST /` resubmission-as-confirmation branch from:
```ts
    if (existing) {
      if (existing.submittedBy === userId) {
        res.status(200).json({ submissionId: existing.id, status: existing.status });
        return;
      }

      await prisma.fontSubmissionConfirmation.upsert({
        where: { submissionId_confirmedBy: { submissionId: existing.id, confirmedBy: userId } },
        create: { submissionId: existing.id, confirmedBy: userId },
        update: {},
      });

      if (existing.sourceUrl === null && validSourceUrl !== null) {
        await prisma.fontSubmission.update({ where: { id: existing.id }, data: { sourceUrl: validSourceUrl } });
      }

      await checkAndPromote(existing.id);

      const updated = await prisma.fontSubmission.findUnique({ where: { id: existing.id } });
      res.status(200).json({ submissionId: existing.id, status: updated!.status });
      return;
    }
```
to:
```ts
    if (existing) {
      if (existing.submittedBy === userId) {
        res.status(200).json({ submissionId: existing.id, status: existing.status });
        return;
      }

      await prisma.fontSubmissionConfirmation.upsert({
        where: { submissionId_confirmedBy: { submissionId: existing.id, confirmedBy: userId } },
        create: { submissionId: existing.id, confirmedBy: userId, sourceUrl: validSourceUrl },
        update: validSourceUrl !== null ? { sourceUrl: validSourceUrl } : {},
      });

      await checkAndPromote(existing.id);

      const updated = await prisma.fontSubmission.findUnique({ where: { id: existing.id } });
      res.status(200).json({ submissionId: existing.id, status: updated!.status });
      return;
    }
```

Change the `POST /:id/confirm` handler from:
```ts
fontSubmissionsRouter.post('/:id/confirm', async (req, res, next) => {
  try {
    const submission = await prisma.fontSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission || submission.status !== 'pending') {
      throw new ApiError(404, 'Pending submission not found');
    }

    const userId = req.userId as string;
    if (submission.submittedBy === userId) {
      throw new ApiError(400, 'You cannot confirm your own submission');
    }

    await prisma.fontSubmissionConfirmation.upsert({
      where: { submissionId_confirmedBy: { submissionId: submission.id, confirmedBy: userId } },
      create: { submissionId: submission.id, confirmedBy: userId },
      update: {},
    });

    await checkAndPromote(submission.id);

    const updated = await prisma.fontSubmission.findUnique({
      where: { id: submission.id },
      include: { _count: { select: { confirmations: true } } },
    });

    res.status(200).json({
      status: updated!.status,
      confirmationCount: 1 + updated!._count.confirmations,
    });
  } catch (error) {
    next(error);
  }
});
```
to:
```ts
fontSubmissionsRouter.post('/:id/confirm', async (req, res, next) => {
  try {
    const submission = await prisma.fontSubmission.findUnique({ where: { id: req.params.id } });
    if (!submission || submission.status !== 'pending') {
      throw new ApiError(404, 'Pending submission not found');
    }

    const userId = req.userId as string;
    if (submission.submittedBy === userId) {
      throw new ApiError(400, 'You cannot confirm your own submission');
    }

    const { sourceUrl } = req.body as { sourceUrl?: unknown };
    if (sourceUrl !== undefined && sourceUrl !== null && sourceUrl !== '') {
      if (typeof sourceUrl !== 'string') {
        throw new ApiError(400, 'sourceUrl must be a string');
      }
      try {
        new URL(sourceUrl);
      } catch {
        throw new ApiError(400, 'sourceUrl must be a valid URL');
      }
    }
    const validSourceUrl = typeof sourceUrl === 'string' && sourceUrl !== '' ? sourceUrl : null;

    await prisma.fontSubmissionConfirmation.upsert({
      where: { submissionId_confirmedBy: { submissionId: submission.id, confirmedBy: userId } },
      create: { submissionId: submission.id, confirmedBy: userId, sourceUrl: validSourceUrl },
      update: validSourceUrl !== null ? { sourceUrl: validSourceUrl } : {},
    });

    await checkAndPromote(submission.id);

    const updated = await prisma.fontSubmission.findUnique({
      where: { id: submission.id },
      include: { _count: { select: { confirmations: true } } },
    });

    res.status(200).json({
      status: updated!.status,
      confirmationCount: 1 + updated!._count.confirmations,
    });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `server/`): `npx vitest run tests/font-submissions.test.ts`
Expected: PASS — all tests in the file pass, including the replaced and new ones.

- [ ] **Step 5: Run typecheck and the full test suite**

Run (from `server/`): `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/font-submissions.ts server/tests/font-submissions.test.ts
git commit -m "feat: promotion creates a findable Font with per-confirmer-attributed sources"
```

---

### Task 3: `GET /fonts/resolve`

**Files:**
- Create: `server/src/routes/fonts.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/fonts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/fonts.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

beforeEach(async () => {
  await resetDb();
});

describe('GET /fonts/resolve', () => {
  it('finds a font by an exact matchKey', async () => {
    await prisma.font.create({
      data: {
        name: 'Brandon Grotesque',
        matchKeys: ['brandon grotesque'],
        sources: {
          create: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
        },
      },
    });

    const res = await request(app).get('/fonts/resolve').query({ name: 'Brandon Grotesque, sans-serif' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      fontName: 'Brandon Grotesque',
      sources: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
    });
  });

  it('matches case-insensitively and ignores surrounding quotes', async () => {
    await prisma.font.create({ data: { name: 'Brandon Grotesque', matchKeys: ['brandon grotesque'] } });

    const res = await request(app).get('/fonts/resolve').query({ name: '"BRANDON GROTESQUE", sans-serif' });

    expect(res.status).toBe(200);
    expect(res.body.fontName).toBe('Brandon Grotesque');
  });

  it('checks every candidate in the stack, not just the first', async () => {
    await prisma.font.create({ data: { name: 'Brandon Grotesque', matchKeys: ['brandon grotesque'] } });

    const res = await request(app)
      .get('/fonts/resolve')
      .query({ name: 'SomeCustomAlias, Brandon Grotesque, sans-serif' });

    expect(res.status).toBe(200);
    expect(res.body.fontName).toBe('Brandon Grotesque');
  });

  it('returns sources sorted by votes descending', async () => {
    await prisma.font.create({
      data: {
        name: 'Brandon Grotesque',
        matchKeys: ['brandon grotesque'],
        sources: {
          create: [
            { url: 'https://www.myfonts.com/fonts/brandon-grotesque', label: 'www.myfonts.com', votes: 1 },
            { url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 },
          ],
        },
      },
    });

    const res = await request(app).get('/fonts/resolve').query({ name: 'Brandon Grotesque' });

    expect(res.body.sources.map((s: { votes: number }) => s.votes)).toEqual([2, 1]);
  });

  it('returns 404 when no matchKey matches', async () => {
    const res = await request(app).get('/fonts/resolve').query({ name: 'SomeUnknownFont' });
    expect(res.status).toBe(404);
  });

  it('rejects a missing name query param', async () => {
    const res = await request(app).get('/fonts/resolve');
    expect(res.status).toBe(400);
  });

  it('does not require authentication', async () => {
    await prisma.font.create({ data: { name: 'Brandon Grotesque', matchKeys: ['brandon grotesque'] } });
    const res = await request(app).get('/fonts/resolve').query({ name: 'Brandon Grotesque' });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `server/`): `npx vitest run tests/fonts.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/fonts'`.

- [ ] **Step 3: Create `server/src/routes/fonts.ts`**

```ts
import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { ApiError } from '../middleware/error-handler';

export const fontsRouter = Router();

// Mirrors findKnownFont's client-side candidate extraction exactly (comma-split,
// trim, strip surrounding quotes, lowercase) so the server fallback behaves
// identically to the local tier it's backing up, regardless of which one
// actually resolves a given font-family stack.
function extractCandidates(fontFamilyStack: string): string[] {
  return fontFamilyStack
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter((entry) => entry.length > 0);
}

fontsRouter.get('/resolve', optionalAuth, async (req, res, next) => {
  try {
    const { name } = req.query;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ApiError(400, 'name is required');
    }

    const candidates = extractCandidates(name);

    for (const candidate of candidates) {
      const font = await prisma.font.findFirst({
        where: { matchKeys: { has: candidate } },
        include: { sources: { orderBy: { votes: 'desc' } } },
      });
      if (font) {
        res.status(200).json({
          fontName: font.name,
          sources: font.sources.map((s) => ({ url: s.url, label: s.label, votes: s.votes })),
        });
        return;
      }
    }

    res.status(404).json({ error: 'Font not found' });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Mount the router in `server/src/app.ts`**

Change from:
```ts
import { fontMatchesRouter } from './routes/font-matches';
import { fontSubmissionsRouter } from './routes/font-submissions';

export const app = express();
```
to:
```ts
import { fontMatchesRouter } from './routes/font-matches';
import { fontSubmissionsRouter } from './routes/font-submissions';
import { fontsRouter } from './routes/fonts';

export const app = express();
```

And change:
```ts
app.use('/font-matches', fontMatchesRouter);
app.use('/font-submissions', fontSubmissionsRouter);

app.use(errorHandler);
```
to:
```ts
app.use('/font-matches', fontMatchesRouter);
app.use('/font-submissions', fontSubmissionsRouter);
app.use('/fonts', fontsRouter);

app.use(errorHandler);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `server/`): `npx vitest run tests/fonts.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 6: Run typecheck and the full test suite**

Run (from `server/`): `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/fonts.ts server/tests/fonts.test.ts server/src/app.ts
git commit -m "feat: add GET /fonts/resolve for DOM-path server-fallback matching"
```

---

### Task 4: Client Shared Types

**Files:**
- Modify: `src/shared/api-messages.ts`

No test in this task — pure type declarations, verified by `npm run typecheck`, matching this project's established treatment of pure-type tasks.

- [ ] **Step 1: Update `src/shared/api-messages.ts`**

Change from:
```ts
  | { type: 'GET_PENDING_SUBMISSIONS' }
  | { type: 'CONFIRM_FONT_SUBMISSION'; id: string };
```
to:
```ts
  | { type: 'GET_PENDING_SUBMISSIONS' }
  | { type: 'CONFIRM_FONT_SUBMISSION'; id: string; sourceUrl: string | null }
  | { type: 'RESOLVE_FONT_NAME'; fontFamilyStack: string };
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: errors in `src/background/api-client.ts` and `src/background/enrollment.ts`/`locked-selection.ts` call sites that construct a `CONFIRM_FONT_SUBMISSION` message without `sourceUrl` — this is expected here, resolved by Tasks 5 and 8.

- [ ] **Step 3: Commit**

```bash
git add src/shared/api-messages.ts
git commit -m "feat: add RESOLVE_FONT_NAME message, CONFIRM_FONT_SUBMISSION gains sourceUrl"
```

---

### Task 5: `api-client.ts`

**Files:**
- Modify: `src/background/api-client.ts`
- Test: `tests/api-client.test.ts`

- [ ] **Step 1: Update the existing `confirmFontSubmission` test and add new tests**

In `tests/api-client.test.ts`, add `resolveFontName` to the import block:
```ts
import {
  apiFetch,
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
  matchImage,
  getPendingSubmissions,
  confirmFontSubmission,
  submitFont,
  resolveFontName,
} from '../src/background/api-client';
```

Replace the existing `describe('confirmFontSubmission', ...)` block:
```ts
describe('confirmFontSubmission', () => {
  it('posts to /font-submissions/:id/confirm', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'pending', confirmationCount: 2 }));

    const result = await confirmFontSubmission('sub-1');

    expect(result).toEqual({ ok: true, data: { status: 'pending', confirmationCount: 2 } });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/font-submissions/sub-1/confirm');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });
});
```
with:
```ts
describe('confirmFontSubmission', () => {
  it('posts to /font-submissions/:id/confirm with the proposed sourceUrl in the body', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'pending', confirmationCount: 2 }));

    const result = await confirmFontSubmission('sub-1', 'https://fonts.adobe.com/fonts/brandon-grotesque');

    expect(result).toEqual({ ok: true, data: { status: 'pending', confirmationCount: 2 } });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/font-submissions/sub-1/confirm');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].body).toBe(
      JSON.stringify({ sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque' }),
    );
  });

  it('sends a null sourceUrl when none is proposed', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'pending', confirmationCount: 2 }));

    await confirmFontSubmission('sub-1', null);

    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ sourceUrl: null }));
  });
});

describe('resolveFontName', () => {
  it('fetches with the font-family stack URL-encoded and unwraps the result', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        fontName: 'Brandon Grotesque',
        sources: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
      }),
    );

    const result = await resolveFontName('"Brandon Grotesque", sans-serif');

    expect(result).toEqual({
      ok: true,
      data: {
        fontName: 'Brandon Grotesque',
        sources: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
      },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:3001/fonts/resolve?name=%22Brandon%20Grotesque%22%2C%20sans-serif',
    );
  });

  it('returns the server error on a non-2xx response (e.g. not found)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'Font not found' }));

    const result = await resolveFontName('SomeUnknownFont');

    expect(result).toEqual({ ok: false, error: 'Font not found' });
  });

  it('attaches a stored access token when present, without requiring one', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { fontName: 'Brandon Grotesque', sources: [] }));

    await resolveFontName('Brandon Grotesque');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer access-1');
  });

  it('works with no stored auth at all', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { fontName: 'Brandon Grotesque', sources: [] }));

    const result = await resolveFontName('Brandon Grotesque');

    expect(result.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api-client.test.ts`
Expected: FAIL — `confirmFontSubmission` doesn't accept a second argument yet; `resolveFontName` isn't exported.

- [ ] **Step 3: Update `src/background/api-client.ts`**

Change from:
```ts
export async function confirmFontSubmission(
  id: string,
): Promise<ApiResponse<{ status: string; confirmationCount: number }>> {
  return apiFetch(`/font-submissions/${id}/confirm`, { method: 'POST', auth: 'required' });
}
```
to:
```ts
export async function confirmFontSubmission(
  id: string,
  sourceUrl: string | null,
): Promise<ApiResponse<{ status: string; confirmationCount: number }>> {
  return apiFetch(`/font-submissions/${id}/confirm`, { method: 'POST', body: { sourceUrl }, auth: 'required' });
}
```

Add at the end of the file, after `submitFont`:
```ts

export interface FontResolution {
  fontName: string;
  sources: ScanSource[];
}

export async function resolveFontName(fontFamilyStack: string): Promise<ApiResponse<FontResolution>> {
  return apiFetch(`/fonts/resolve?name=${encodeURIComponent(fontFamilyStack)}`, { method: 'GET', auth: 'optional' });
}
```

(`ScanSource` is already imported at the top of this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api-client.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: errors remaining only in `service-worker.ts` and `enrollment.ts`/`locked-selection.ts` — resolved by Tasks 6 and 8.

- [ ] **Step 6: Commit**

```bash
git add src/background/api-client.ts tests/api-client.test.ts
git commit -m "feat: confirmFontSubmission takes a sourceUrl, add resolveFontName"
```

---

### Task 6: `service-worker.ts`

**Files:**
- Modify: `src/background/service-worker.ts`
- Test: `tests/service-worker.test.ts`

- [ ] **Step 1: Update the existing `CONFIRM_FONT_SUBMISSION` dispatch test and add a `RESOLVE_FONT_NAME` test**

In `tests/service-worker.test.ts`, replace the existing test:
```ts
  it('dispatches CONFIRM_FONT_SUBMISSION to the api-client confirmFontSubmission function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(),
      getPendingSubmissions: vi.fn(),
      confirmFontSubmission: vi.fn(async () => ({ ok: true, data: { status: 'pending', confirmationCount: 2 } })),
      submitFont: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { confirmFontSubmission } = await import('../src/background/api-client');

    const result = await handleApiMessage({ type: 'CONFIRM_FONT_SUBMISSION', id: 'sub-1' });

    expect(confirmFontSubmission).toHaveBeenCalledWith('sub-1');
    expect(result).toEqual({ ok: true, data: { status: 'pending', confirmationCount: 2 } });
  });
```
with:
```ts
  it('dispatches CONFIRM_FONT_SUBMISSION to the api-client confirmFontSubmission function, including the proposed sourceUrl', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(),
      getPendingSubmissions: vi.fn(),
      confirmFontSubmission: vi.fn(async () => ({ ok: true, data: { status: 'pending', confirmationCount: 2 } })),
      submitFont: vi.fn(),
      resolveFontName: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { confirmFontSubmission } = await import('../src/background/api-client');

    const result = await handleApiMessage({
      type: 'CONFIRM_FONT_SUBMISSION',
      id: 'sub-1',
      sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque',
    });

    expect(confirmFontSubmission).toHaveBeenCalledWith('sub-1', 'https://fonts.adobe.com/fonts/brandon-grotesque');
    expect(result).toEqual({ ok: true, data: { status: 'pending', confirmationCount: 2 } });
  });

  it('dispatches RESOLVE_FONT_NAME to the api-client resolveFontName function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(),
      getPendingSubmissions: vi.fn(),
      confirmFontSubmission: vi.fn(),
      submitFont: vi.fn(),
      resolveFontName: vi.fn(async () => ({ ok: true, data: { fontName: 'Brandon Grotesque', sources: [] } })),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { resolveFontName } = await import('../src/background/api-client');

    const result = await handleApiMessage({
      type: 'RESOLVE_FONT_NAME',
      fontFamilyStack: 'Brandon Grotesque, sans-serif',
    });

    expect(resolveFontName).toHaveBeenCalledWith('Brandon Grotesque, sans-serif');
    expect(result).toEqual({ ok: true, data: { fontName: 'Brandon Grotesque', sources: [] } });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: FAIL — the switch doesn't pass `sourceUrl` through, and `RESOLVE_FONT_NAME` falls to the `default` case.

- [ ] **Step 3: Update `src/background/service-worker.ts`**

Change the import block from:
```ts
import {
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
  matchImage,
  getPendingSubmissions,
  confirmFontSubmission,
  submitFont,
} from './api-client';
```
to:
```ts
import {
  signup,
  login,
  logout,
  getAuthState,
  saveFont,
  deleteSavedFont,
  logScan,
  matchImage,
  getPendingSubmissions,
  confirmFontSubmission,
  submitFont,
  resolveFontName,
} from './api-client';
```

Change `handleApiMessage`'s switch from:
```ts
      case 'GET_PENDING_SUBMISSIONS':
        return await getPendingSubmissions();
      case 'CONFIRM_FONT_SUBMISSION':
        return await confirmFontSubmission(message.id);
      default:
```
to:
```ts
      case 'GET_PENDING_SUBMISSIONS':
        return await getPendingSubmissions();
      case 'CONFIRM_FONT_SUBMISSION':
        return await confirmFontSubmission(message.id, message.sourceUrl);
      case 'RESOLVE_FONT_NAME':
        return await resolveFontName(message.fontFamilyStack);
      default:
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: typecheck still shows errors in `enrollment.ts`/`locked-selection.ts` call sites (resolved by Task 8) — this is expected. `service-worker.test.ts` itself passes.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.ts tests/service-worker.test.ts
git commit -m "feat: dispatch RESOLVE_FONT_NAME, pass sourceUrl through CONFIRM_FONT_SUBMISSION"
```

---

### Task 7: `scan-types.ts` + `font-resolver.ts`

**Files:**
- Modify: `src/content/scan-types.ts`, `src/content/font-resolver.ts`
- Test: `tests/font-resolver.test.ts`

- [ ] **Step 1: Update the existing 'unrecognized' test and add new ones**

In `tests/font-resolver.test.ts`, replace:
```ts
  it('returns no-match/unrecognized when the winning font is not in the known-fonts table', () => {
    const result = resolveFromReadings([unknown, unknown, unknown]);
    expect(result).toEqual({ status: 'no-match', reason: 'unrecognized' });
  });
```
with:
```ts
  it('returns no-match/unrecognized with the detected font-family and confidence when the winning font is not in the known-fonts table', () => {
    const result = resolveFromReadings([unknown, unknown, unknown]);
    expect(result).toEqual({
      status: 'no-match',
      reason: 'unrecognized',
      detectedFontFamily: 'SomeUnknownFont',
      detectedConfidence: 100,
    });
  });

  it('carries the correct partial confidence for an unrecognized font that only reaches a partial majority', () => {
    const otherUnknown: FontReading = { fontFamily: 'AnotherUnknownFont', fontWeight: '400', fontStyle: 'normal' };
    // 3 of 4 = 75%, above the 60% threshold, still unrecognized
    const result = resolveFromReadings([unknown, unknown, unknown, otherUnknown]);
    expect(result.status).toBe('no-match');
    if (result.status === 'no-match') {
      expect(result.detectedFontFamily).toBe('SomeUnknownFont');
      expect(result.detectedConfidence).toBe(75);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/font-resolver.test.ts`
Expected: FAIL — `resolveFromReadings` doesn't yet return `detectedFontFamily`/`detectedConfidence`.

- [ ] **Step 3: Update `src/content/scan-types.ts`**

Change from:
```ts
export interface NoMatchResult {
  status: 'no-match';
  reason?: 'unrecognized' | 'mixed' | 'no-text' | 'error';
}
```
to:
```ts
export interface NoMatchResult {
  status: 'no-match';
  reason?: 'unrecognized' | 'mixed' | 'no-text' | 'error';
  detectedFontFamily?: string;
  detectedConfidence?: number;
}
```

- [ ] **Step 4: Update `src/content/font-resolver.ts`**

Change from:
```ts
  const known = findKnownFont(winner!.reading.fontFamily);
  if (!known) {
    return { status: 'no-match', reason: 'unrecognized' };
  }
```
to:
```ts
  const known = findKnownFont(winner!.reading.fontFamily);
  if (!known) {
    return {
      status: 'no-match',
      reason: 'unrecognized',
      detectedFontFamily: winner!.reading.fontFamily,
      detectedConfidence: Math.round(share * 100),
    };
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/font-resolver.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 6: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: typecheck still shows errors only in `enrollment.ts`/`locked-selection.ts` call sites (Task 8) — expected. `font-resolver.test.ts` itself passes; no other test files reference `NoMatchResult`'s exact shape in a way that would break (the new fields are additive/optional).

- [ ] **Step 7: Commit**

```bash
git add src/content/scan-types.ts src/content/font-resolver.ts tests/font-resolver.test.ts
git commit -m "feat: carry detected font-family/confidence through an unrecognized DOM result"
```

---

### Task 8: `scan-dialogue.ts` + `enrollment.ts` — Confirmations Propose a Source

**Files:**
- Modify: `src/content/scan-dialogue.ts`, `src/content/enrollment.ts`
- Test: `tests/scan-dialogue.test.ts`, `tests/enrollment.test.ts`

- [ ] **Step 1: Update the existing suggestion-click test and add a new one, in `tests/scan-dialogue.test.ts`**

Replace:
```ts
  it('calls onConfirmExisting with the picked suggestion\'s id when clicked', () => {
    const body = document.createElement('div');
    const onConfirmExisting = vi.fn();

    renderEnrollmentFormState(body, suggestions, onConfirmExisting, vi.fn(), vi.fn());

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const items = Array.from(body.querySelectorAll('.fontcia-suggestion-item')) as HTMLButtonElement[];
    expect(items).toHaveLength(2);
    items[1].click();

    expect(onConfirmExisting).toHaveBeenCalledWith('sub-2');
  });
```
with:
```ts
  it("calls onConfirmExisting with the picked suggestion's id and null when no source URL was typed", () => {
    const body = document.createElement('div');
    const onConfirmExisting = vi.fn();

    renderEnrollmentFormState(body, suggestions, onConfirmExisting, vi.fn(), vi.fn());

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const items = Array.from(body.querySelectorAll('.fontcia-suggestion-item')) as HTMLButtonElement[];
    expect(items).toHaveLength(2);
    items[1].click();

    expect(onConfirmExisting).toHaveBeenCalledWith('sub-2', null);
  });

  it('calls onConfirmExisting with whatever source URL was typed into the source-URL field', () => {
    const body = document.createElement('div');
    const onConfirmExisting = vi.fn();

    renderEnrollmentFormState(body, suggestions, onConfirmExisting, vi.fn(), vi.fn());

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'brandon';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = 'https://fonts.adobe.com/fonts/brandon-grotesque';

    const items = Array.from(body.querySelectorAll('.fontcia-suggestion-item')) as HTMLButtonElement[];
    items[0].click();

    expect(onConfirmExisting).toHaveBeenCalledWith('sub-1', 'https://fonts.adobe.com/fonts/brandon-grotesque');
  });
```

- [ ] **Step 2: Update the existing confirm test and add a new one, in `tests/enrollment.test.ts`**

In the existing test `'confirms an existing submission and shows the submitted state'`, change:
```ts
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'CONFIRM_FONT_SUBMISSION', id: 'sub-1' });
```
to:
```ts
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CONFIRM_FONT_SUBMISSION',
      id: 'sub-1',
      sourceUrl: null,
    });
```

Add this new test immediately after that test:
```ts
  it('confirms an existing submission with a proposed sourceUrl when one was typed', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') {
        return { ok: true, data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] };
      }
      if (message.type === 'CONFIRM_FONT_SUBMISSION') {
        return { ok: true, data: { status: 'pending', confirmationCount: 2 } };
      }
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'brandon';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = 'https://fonts.adobe.com/fonts/brandon-grotesque';

    const suggestionBtn = body.querySelector('.fontcia-suggestion-item') as HTMLButtonElement;
    suggestionBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CONFIRM_FONT_SUBMISSION',
      id: 'sub-1',
      sourceUrl: 'https://fonts.adobe.com/fonts/brandon-grotesque',
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/scan-dialogue.test.ts tests/enrollment.test.ts`
Expected: FAIL — `onConfirmExisting`/`CONFIRM_FONT_SUBMISSION` are still called with only one argument/no `sourceUrl` field.

- [ ] **Step 4: Update `src/content/scan-dialogue.ts`**

Change `renderEnrollmentFormState`'s signature and suggestion-click handler from:
```ts
export function renderEnrollmentFormState(
  body: HTMLElement,
  pendingSuggestions: PendingSuggestion[],
  onConfirmExisting: (id: string) => void,
  onSubmitNew: (fontName: string, sourceUrl: string | null) => void,
  onCancel: () => void,
): void {
```
to:
```ts
export function renderEnrollmentFormState(
  body: HTMLElement,
  pendingSuggestions: PendingSuggestion[],
  onConfirmExisting: (id: string, sourceUrl: string | null) => void,
  onSubmitNew: (fontName: string, sourceUrl: string | null) => void,
  onCancel: () => void,
): void {
```

Change:
```ts
      suggestionBtn.addEventListener('click', () => onConfirmExisting(match.id));
```
to:
```ts
      suggestionBtn.addEventListener('click', () => {
        const proposedSourceUrl = sourceUrlInput.value.trim();
        onConfirmExisting(match.id, proposedSourceUrl.length > 0 ? proposedSourceUrl : null);
      });
```

(`sourceUrlInput` is declared later in the same function body, but since this callback only runs on a later `click` event — after the whole function, and thus `sourceUrlInput`'s declaration, has already executed — the closure sees it fully initialized. Same reasoning `renderSuggestions` already relies on for `pendingSuggestions`/`onConfirmExisting`.)

- [ ] **Step 5: Update `src/content/enrollment.ts`**

Change from:
```ts
  function handleConfirmExisting(id: string): void {
    sendApiMessage<{ status: string; confirmationCount: number }>({ type: 'CONFIRM_FONT_SUBMISSION', id })
```
to:
```ts
  function handleConfirmExisting(id: string, sourceUrl: string | null): void {
    sendApiMessage<{ status: string; confirmationCount: number }>({ type: 'CONFIRM_FONT_SUBMISSION', id, sourceUrl })
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/scan-dialogue.test.ts tests/enrollment.test.ts`
Expected: PASS — all tests in both files pass.

- [ ] **Step 7: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: clean typecheck (this is the task where every remaining `CONFIRM_FONT_SUBMISSION` call site is finally updated); all client tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/content/scan-dialogue.ts src/content/enrollment.ts tests/scan-dialogue.test.ts tests/enrollment.test.ts
git commit -m "feat: let a confirmation propose its own source URL"
```

---

### Task 9: `locked-selection.ts` — The Server Fallback Tier

**Files:**
- Modify: `src/content/locked-selection.ts`
- Test: `tests/locked-selection.test.ts`

This is the task that actually wires the new fallback tier into a live scan, mirroring the existing `'no-text'` → AI-image-matching fallback structure.

- [ ] **Step 1: Write the failing tests**

Add these tests to `tests/locked-selection.test.ts`, immediately after the existing `'shows the bare no-match state for a mixed reason, with no working Name it button'` test and before `'starts enrollment via a fresh CAPTURE_SELECTION...'`:

```ts
  it('tries the server-side name resolution fallback when a detectedFontFamily is present, and shows a match on success', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({
        status: 'no-match',
        reason: 'unrecognized',
        detectedFontFamily: 'Brandon Grotesque, sans-serif',
        detectedConfidence: 92,
      }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'RESOLVE_FONT_NAME') {
        return {
          ok: true,
          data: {
            fontName: 'Brandon Grotesque',
            sources: [{ url: 'https://fonts.adobe.com/fonts/brandon-grotesque', label: 'fonts.adobe.com', votes: 2 }],
          },
        };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'RESOLVE_FONT_NAME',
      fontFamilyStack: 'Brandon Grotesque, sans-serif',
    });
    expect(panel.querySelector('.fontcia-result-font')?.textContent).toBe('Brandon Grotesque');
    expect(panel.querySelector('.fontcia-confidence')?.textContent).toBe('92% confidence');
  });

  it('logs the fallback match with LOG_SCAN, in addition to the initial no-match log', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({
        status: 'no-match',
        reason: 'unrecognized',
        detectedFontFamily: 'Brandon Grotesque',
        detectedConfidence: 92,
      }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'RESOLVE_FONT_NAME') {
        return { ok: true, data: { fontName: 'Brandon Grotesque', sources: [] } };
      }
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'LOG_SCAN', status: 'no-match' });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'LOG_SCAN',
      status: 'match',
      fontName: 'Brandon Grotesque',
      confidence: 92,
    });
  });

  it('falls through to the enrollment-capable unrecognized state when the fallback finds nothing', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({
        status: 'no-match',
        reason: 'unrecognized',
        detectedFontFamily: 'SomeUnknownFont',
        detectedConfidence: 100,
      }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'RESOLVE_FONT_NAME') return { ok: false, error: 'Font not found' };
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("We don't recognize this one.");
    const nameItBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Name it',
    ) as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(false);
  });

  it('falls through to the unrecognized state when the fallback message itself rejects', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() =>
      Promise.resolve<ScanResult>({
        status: 'no-match',
        reason: 'unrecognized',
        detectedFontFamily: 'SomeUnknownFont',
        detectedConfidence: 100,
      }),
    );
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'RESOLVE_FONT_NAME') throw new Error('network error');
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("We don't recognize this one.");
  });

  it('does not attempt the fallback for a mixed reason', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'mixed' }));

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      vi.fn(),
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RESOLVE_FONT_NAME' }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — the new tests fail (`'unrecognized'` never attempts `RESOLVE_FONT_NAME` yet); existing tests should still pass unchanged.

- [ ] **Step 3: Update `src/content/locked-selection.ts`**

Change the import block from:
```ts
import type { MatchResult, ScanResult, ImageMatchResult } from './scan-types';
```
to:
```ts
import type { MatchResult, ScanResult, ImageMatchResult, ScanSource } from './scan-types';
```

Change `handleScan` and the code immediately following it from:
```ts
  function handleScan(): void {
    renderLoadingState(body);
    scanFn(rect)
      .then((result) => {
        logScanResult(result);
        // An in-flight scan must not touch the DOM after the panel is dismissed
        // (Esc, the close button, or an icon-click toggle-off) — all three
        // converge on overlay.ts's teardownOverlay(), which calls dispose()
        // before this promise can resolve into a stale render.
        if (disposed) return;
        if (result.status === 'match') {
          showResult(result);
        } else if (result.status === 'no-match' && result.reason === 'no-text') {
          handleNoTextResult();
        } else if (result.status === 'no-match' && result.reason === 'unrecognized') {
          void renderUnrecognizedFont();
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
  }

  async function renderUnrecognizedFont(): Promise<void> {
```
to:
```ts
  function handleScan(): void {
    renderLoadingState(body);
    scanFn(rect)
      .then((result) => {
        logScanResult(result);
        // An in-flight scan must not touch the DOM after the panel is dismissed
        // (Esc, the close button, or an icon-click toggle-off) — all three
        // converge on overlay.ts's teardownOverlay(), which calls dispose()
        // before this promise can resolve into a stale render.
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
  }

  // Mirrors handleNoTextResult's role for the 'no-text' reason: local
  // resolution came up empty, so try exactly one more, slower tier before
  // giving up. Unlike handleNoTextResult, this doesn't render a distinct
  // loading state — the generic spinner renderLoadingState already put on
  // screen at the top of handleScan simply stays up through this lookup,
  // since it's a quick DB query, not the AI path's meaningfully slower image
  // analysis.
  async function handleUnrecognized(
    detectedFontFamily: string | undefined,
    detectedConfidence: number | undefined,
  ): Promise<void> {
    if (detectedFontFamily !== undefined) {
      try {
        const res = await sendApiMessage<{ fontName: string; sources: ScanSource[] }>({
          type: 'RESOLVE_FONT_NAME',
          fontFamilyStack: detectedFontFamily,
        });
        if (disposed) return;
        if (res.ok) {
          const confidence = detectedConfidence ?? 0;
          sendApiMessage<null>({ type: 'LOG_SCAN', status: 'match', fontName: res.data.fontName, confidence }).catch(
            (error: unknown) => {
              console.error('fontCIA: scan logging failed', error);
            },
          );
          showResult({ status: 'match', fontName: res.data.fontName, confidence, sources: res.data.sources });
          return;
        }
      } catch (error: unknown) {
        console.error('fontCIA: font-name resolution failed', error);
      }
    }
    if (disposed) return;
    void renderUnrecognizedFont();
  }

  async function renderUnrecognizedFont(): Promise<void> {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — all tests in the file pass, including the new ones and every pre-existing test.

- [ ] **Step 5: Run typecheck and the full client test suite**

Run: `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Expected: clean typecheck; all client tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: try a server-side name resolution fallback before the enrollment prompt"
```

---

### Task 10: Final Verification

**Files:** None (verification only).

- [ ] **Step 1: Full typecheck and test suite (client + server)**

Run (from repo root): `npm run typecheck && npx vitest run --exclude "server/**" --exclude "**/node_modules/**"`
Run (from `server/`): `npx tsc --noEmit && npm test` (requires Docker's `pgvector/pgvector:pg16` postgres container up — `docker compose up -d` from `server/` if it isn't already)

Expected: clean typecheck on both; every test file passes, including all changes from Tasks 1-9. (Running the two suites separately, not a single unscoped root `npm test`, avoids a pre-existing, unrelated issue where root `vitest run`'s default recursive glob picks up `server/tests/` too and races two independent suites against the same live Postgres database.)

- [ ] **Step 2: Build the extension**

Run: `npm run build`
Expected: builds cleanly, matching every prior sub-project's final verification.

- [ ] **Step 3: Optional manual smoke test**

Requires the same three-service stack verified in prior sub-projects (Docker Postgres, the embedding-service, the Node server), plus the extension loaded unpacked in Chrome. With all three running:

1. Trigger the DOM path's `'unrecognized'` outcome on a font not in `known-fonts.ts` and not yet in the `Font` table. Confirm it still lands on "We don't recognize this one." (server fallback correctly finds nothing) with an enabled "Name it" button, and that the wait feels effectively instant despite the extra network round trip (a single indexed lookup against an empty/small table).
2. Submit that font via "Name it", then from two more accounts submit/confirm the same name until it promotes (three total supporters) — on the second and third confirmations, type a source URL into the source-URL field before confirming, using two *different* URLs across the two confirmers.
3. Trigger a fresh scan of that same font again. Confirm it now resolves as a real match (not "We don't recognize this one.") via the server fallback, and that the result panel shows **two** ranked sources, correctly ordered by votes, with sensible hostname labels.
4. Confirm a font that's still in `known-fonts.ts` (e.g. Inter) continues to resolve instantly with no network delay or spinner flash, verifying the local-first tier is genuinely untouched.
5. Confirm the AI image-matching path (a screenshot-only selection) still behaves exactly as before — this sub-project doesn't touch it, but it's the one path a schema mistake could most easily have silently affected via `Font`/`FontEmbedding`.

This step is optional given the thorough automated coverage from Tasks 1-9, but is the only way to see the real, end-to-end multi-source result render against a real backend — worth doing at least once before considering this sub-project fully done.

- [ ] **Step 4: If a real, fixable bug was found in Step 3**, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix. If nothing broke, there's nothing to commit for this task beyond the verification itself.

---

## Self-Review Notes

- **Spec coverage:** unifying around the existing `Font` table, no parallel model (Task 1) → covered; structural (join-based) exclusion of promoted fonts from AI matching, `googleSlug` made optional with the reasoning documented (Task 1) → covered; local-first DOM resolution with a server fallback mirroring the `'no-text'` pattern exactly, no new loading state (Task 9) → covered; catalog expansion deferred (no task touches `known-fonts.ts`'s content or the AI catalog's population) → covered; no backfill for the AI catalog's existing 100 fonts (Task 1/2 never touch `FontEmbedding` or existing `Font` rows) → covered; zero-source fonts handled gracefully (Task 2's dedicated test) → covered; richer per-confirmer sourcing replacing the old backfill, with the double-counting reasoning documented inline (Task 2) → covered; `votes` finally meaning something (Task 2's multi-URL test asserts real vote counts) → covered.
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency check:** `FontResolution` (Task 5, `api-client.ts`) matches exactly what `handleUnrecognized` (Task 9, `locked-selection.ts`) expects back from `sendApiMessage<{fontName:string, sources: ScanSource[]}>(...)` — same shape, independently declared, consistent with this codebase's established treatment of client/server-boundary types (never unified across that boundary, e.g. `PendingSubmission` vs `PendingSuggestion` in Step 5). `NoMatchResult.detectedFontFamily`/`detectedConfidence` (Task 7) are produced by `font-resolver.ts` and consumed by `locked-selection.ts`'s `handleUnrecognized` (Task 9) with matching optional-field types on both ends. `CONFIRM_FONT_SUBMISSION`'s `sourceUrl` field (Task 4) flows unchanged in shape from `api-messages.ts` → `service-worker.ts` (Task 6) → `api-client.ts`'s `confirmFontSubmission` (Task 5) → the server's `POST /:id/confirm` body (Task 2) → and from the other direction, `enrollment.ts`'s `handleConfirmExisting` (Task 8) → the same message type. `RESOLVE_FONT_NAME`'s `fontFamilyStack` field (Task 4) flows unchanged from `locked-selection.ts` (Task 9) → `service-worker.ts` (Task 6) → `api-client.ts`'s `resolveFontName` (Task 5) → the server's `GET /fonts/resolve?name=` query param (Task 3).
