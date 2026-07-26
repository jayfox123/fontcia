# Enrollment Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the "Name it" button so a logged-in user can submit an unrecognized font's name (plus an optional source URL), reusing the screenshot crop already captured during that scan attempt, with submissions requiring multiple independent confirmations before being marked "promoted."

**Architecture:** A new `FontSubmission`/`FontSubmissionConfirmation` schema and a `requireAuth`-gated `/font-submissions` API (create-with-dedup, list-pending, confirm-by-id) on the server; a new `src/content/enrollment.ts` module on the client encapsulating the enrollment form's own state machine (fetch pending suggestions → submit-new-or-confirm-existing → show result), reused identically from both the DOM path (which must capture a fresh sample on demand) and the AI path (which already has a captured sample in hand).

**Tech Stack:** TypeScript, Express, Prisma/Postgres, Chrome Extension Manifest V3, Vitest + jsdom (client) / Vitest + supertest + real Postgres (server) — all existing conventions, no new dependencies.

---

## File Structure

```
server/prisma/schema.prisma              — new FontSubmission, FontSubmissionConfirmation models
server/src/routes/font-submissions.ts    — new: POST /, GET /pending, POST /:id/confirm
server/src/app.ts                        — mounts fontSubmissionsRouter
server/tests/helpers/reset-db.ts         — adds the two new tables to the truncate list
server/tests/font-submissions.test.ts    — new

src/shared/api-messages.ts               — gains GET_PENDING_SUBMISSIONS, CONFIRM_FONT_SUBMISSION
src/shared/submission-messages.ts        — new: SubmitFontMessage, SubmitFontResponse (carries a
                                            Blob, kept separate from api-messages.ts for the same
                                            reason match-messages.ts/capture-messages.ts are separate)

src/background/api-client.ts             — gains getPendingSubmissions, confirmFontSubmission, submitFont
src/background/service-worker.ts         — gains a SUBMIT_FONT onMessage branch + two handleApiMessage cases

src/content/scan-dialogue.ts             — new: renderUnrecognizedFontState, renderEnrollmentFormState,
                                            renderEnrollmentSubmittedState, renderEnrollmentErrorState;
                                            modified: renderNoConfidentMatchState gains a real "Name it"
src/content/theme.ts                     — new CSS for the enrollment form's inputs and suggestion list
src/content/enrollment.ts                — new: the enrollment flow's own state machine, called
                                            identically from both entry points (see Architecture above —
                                            this is a deliberate extraction, not present in the original
                                            spec sketch, made during this planning pass because
                                            locked-selection.ts already juggles three flows and enrollment
                                            is a genuinely separate one, not a natural growth of the
                                            other two)
src/content/locked-selection.ts          — modified: handleScan's dispatch distinguishes 'unrecognized'
                                            from 'mixed'/'error'; both "Name it" entry points delegate
                                            to enrollment.ts
```

---

### Task 1: Server Schema

**Files:**
- Modify: `server/prisma/schema.prisma`, `server/tests/helpers/reset-db.ts`

No dedicated test in this task — `FontSubmission`/`FontSubmissionConfirmation` use only standard Prisma scalar types (`String`, `Bytes`, `DateTime`), unlike `FontEmbedding`'s `Unsupported("vector(384)")` column, so there's no special raw-SQL round-trip behavior to verify here. Normal Prisma Client CRUD is exercised naturally by Task 2's route tests.

- [ ] **Step 1: Add the two new models and User's back-relations to `server/prisma/schema.prisma`**

Change the `User` model from:
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
```
to:
```prisma
model User {
  id                          String                       @id @default(uuid())
  email                       String                       @unique
  passwordHash                String
  createdAt                   DateTime                     @default(now())
  savedFonts                  SavedFont[]
  scans                       Scan[]
  refreshTokens               RefreshToken[]
  fontSubmissions             FontSubmission[]
  fontSubmissionConfirmations FontSubmissionConfirmation[]
}
```

Add these two new models at the end of the file, after the existing `FontEmbedding` model:
```prisma

model FontSubmission {
  id            String                       @id @default(uuid())
  fontName      String
  sourceUrl     String?
  sampleImage   Bytes
  submittedBy   String
  submitter     User                         @relation(fields: [submittedBy], references: [id])
  status        String // 'pending' | 'promoted'
  createdAt     DateTime                     @default(now())
  confirmations FontSubmissionConfirmation[]
}

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

- [ ] **Step 2: Generate and apply the migration**

Run (from `server/`):
```bash
npx prisma migrate dev --name add_font_submissions
```
Expected: Prisma detects the new models, generates a migration under `server/prisma/migrations/<timestamp>_add_font_submissions/`, and applies it to `fontcia_dev`. No manual SQL editing is needed this time (unlike `FontEmbedding`'s migration) — every field here is a standard Prisma scalar type with a well-supported native SQL equivalent (`Bytes` maps to Postgres `bytea`).

- [ ] **Step 3: Apply the same migration to the test database**

Run (from `server/`):
```bash
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_test" npx prisma migrate deploy
```
Expected: reports the new migration applied successfully.

- [ ] **Step 4: Add the two new tables to the test-reset helper**

Change `server/tests/helpers/reset-db.ts` from:
```ts
import { prisma } from '../../src/lib/prisma';

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "User", "FontEmbedding", "Font" RESTART IDENTITY CASCADE',
  );
}
```
to:
```ts
import { prisma } from '../../src/lib/prisma';

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "FontSubmissionConfirmation", "FontSubmission", "User", "FontEmbedding", "Font" RESTART IDENTITY CASCADE',
  );
}
```

(`FontSubmissionConfirmation` listed before `FontSubmission`, and both before `User` — matching the existing child-before-parent documentation-as-code convention already used for `FontEmbedding`/`Font`, even though `RESTART IDENTITY CASCADE` would handle the ordering automatically regardless.)

- [ ] **Step 5: Run typecheck and the full test suite**

Run (from `server/`):
```bash
npm run typecheck && npm test
```
Expected: clean typecheck; all existing tests still pass (nothing yet depends on the new models).

- [ ] **Step 6: Commit**

```bash
git add server/prisma server/tests/helpers/reset-db.ts
git commit -m "feat: add FontSubmission/FontSubmissionConfirmation schema"
```

---

### Task 2: `POST /font-submissions`, `GET /font-submissions/pending`, `POST /font-submissions/:id/confirm`

**Files:**
- Create: `server/src/routes/font-submissions.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/font-submissions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/font-submissions.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { signupRateLimit } from '../src/routes/auth';
import { resetDb } from './helpers/reset-db';

const TEST_CLIENT_IP = '::ffff:127.0.0.1';

async function signupUser(email: string): Promise<string> {
  const res = await request(app).post('/auth/signup').send({ email, password: 'password123' });
  return res.body.accessToken;
}

let submitterToken: string;

beforeEach(async () => {
  await resetDb();
  signupRateLimit.resetKey(TEST_CLIENT_IP);
  submitterToken = await signupUser('submitter@example.com');
});

describe('POST /font-submissions', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .field('fontName', 'Some Font')
      .attach('image', Buffer.from('fake-image'), 'sample.png');
    expect(res.status).toBe(401);
  });

  it('creates a new pending submission with the sample image stored', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .field('sourceUrl', 'https://example.com/brandon-grotesque')
      .attach('image', Buffer.from('fake-image-bytes'), 'sample.png');

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');

    const stored = await prisma.fontSubmission.findUnique({ where: { id: res.body.submissionId } });
    expect(stored?.fontName).toBe('Brandon Grotesque');
    expect(stored?.sourceUrl).toBe('https://example.com/brandon-grotesque');
    expect(stored?.status).toBe('pending');
    expect(stored?.sampleImage.toString()).toBe('fake-image-bytes');
  });

  it('rejects a request missing fontName', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .attach('image', Buffer.from('fake-image'), 'sample.png');
    expect(res.status).toBe(400);
  });

  it('rejects an invalid sourceUrl instead of crashing', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Some Font')
      .field('sourceUrl', 'not-a-url')
      .attach('image', Buffer.from('fake-image'), 'sample.png');
    expect(res.status).toBe(400);
  });

  it('rejects a request missing the image', async () => {
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Some Font');
    expect(res.status).toBe(400);
  });

  it('rejects an upload larger than the size limit with a 400, not a 500', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 1);
    const res = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Some Font')
      .attach('image', oversized, 'huge.png');
    expect(res.status).toBe(400);
  });

  it('treats a case-insensitive resubmission from a different user as a confirmation, not a duplicate', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    const secondRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerToken}`)
      .field('fontName', 'brandon grotesque')
      .attach('image', Buffer.from('a different scan'), 'sample.png');

    expect(secondRes.status).toBe(200);
    expect(secondRes.body.submissionId).toBe(firstRes.body.submissionId);

    const allSubmissions = await prisma.fontSubmission.findMany();
    expect(allSubmissions).toHaveLength(1);

    const confirmations = await prisma.fontSubmissionConfirmation.findMany({
      where: { submissionId: firstRes.body.submissionId },
    });
    expect(confirmations).toHaveLength(1);
  });

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

  it('resubmitting your own pending font name is a no-op, not a self-confirmation', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const secondRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    expect(secondRes.status).toBe(200);
    expect(secondRes.body.submissionId).toBe(firstRes.body.submissionId);

    const confirmations = await prisma.fontSubmissionConfirmation.findMany({
      where: { submissionId: firstRes.body.submissionId },
    });
    expect(confirmations).toHaveLength(0);
  });

  it('auto-promotes once the submitter plus two independent confirmers agree', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerAToken = await signupUser('confirmer-a@example.com');
    await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerAToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    let stored = await prisma.fontSubmission.findUnique({ where: { id: firstRes.body.submissionId } });
    expect(stored?.status).toBe('pending');

    const confirmerBToken = await signupUser('confirmer-b@example.com');
    const thirdRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${confirmerBToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    expect(thirdRes.body.status).toBe('promoted');
    stored = await prisma.fontSubmission.findUnique({ where: { id: firstRes.body.submissionId } });
    expect(stored?.status).toBe('promoted');
  });
});

describe('GET /font-submissions/pending', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/font-submissions/pending');
    expect(res.status).toBe(401);
  });

  it('lists pending submissions with their confirmation counts', async () => {
    await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const res = await request(app).get('/font-submissions/pending').set('Authorization', `Bearer ${submitterToken}`);

    expect(res.status).toBe(200);
    expect(res.body.submissions).toHaveLength(1);
    expect(res.body.submissions[0]).toEqual({
      id: expect.any(String),
      fontName: 'Brandon Grotesque',
      confirmationCount: 1,
    });
  });

  it('excludes promoted submissions', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    await prisma.fontSubmission.update({ where: { id: firstRes.body.submissionId }, data: { status: 'promoted' } });

    const res = await request(app).get('/font-submissions/pending').set('Authorization', `Bearer ${submitterToken}`);
    expect(res.body.submissions).toEqual([]);
  });
});

describe('POST /font-submissions/:id/confirm', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/font-submissions/does-not-matter/confirm');
    expect(res.status).toBe(401);
  });

  it('confirms a pending submission and increases its confirmation count', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    const confirmRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`);

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body).toEqual({ status: 'pending', confirmationCount: 2 });
  });

  it('rejects confirming your own submission', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const res = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${submitterToken}`);

    expect(res.status).toBe(400);
  });

  it('is idempotent: confirming the same submission twice does not double count', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');

    const confirmerToken = await signupUser('confirmer@example.com');
    await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`);
    const secondConfirmRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`);

    expect(secondConfirmRes.status).toBe(200);
    expect(secondConfirmRes.body.confirmationCount).toBe(2);
  });

  it('returns 404 for a submission that does not exist', async () => {
    const res = await request(app)
      .post('/font-submissions/00000000-0000-0000-0000-000000000000/confirm')
      .set('Authorization', `Bearer ${submitterToken}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a submission that has already been promoted', async () => {
    const firstRes = await request(app)
      .post('/font-submissions')
      .set('Authorization', `Bearer ${submitterToken}`)
      .field('fontName', 'Brandon Grotesque')
      .attach('image', Buffer.from('fake-image'), 'sample.png');
    await prisma.fontSubmission.update({ where: { id: firstRes.body.submissionId }, data: { status: 'promoted' } });

    const confirmerToken = await signupUser('confirmer@example.com');
    const res = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerToken}`);

    expect(res.status).toBe(404);
  });

  it('promotes once the threshold is reached via explicit confirmations', async () => {
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
    const finalConfirmRes = await request(app)
      .post(`/font-submissions/${firstRes.body.submissionId}/confirm`)
      .set('Authorization', `Bearer ${confirmerBToken}`);

    expect(finalConfirmRes.body.status).toBe('promoted');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `server/`): `npx vitest run tests/font-submissions.test.ts`
Expected: FAIL — `Cannot find module '../src/routes/font-submissions'` (the route doesn't exist), or the app returns 404 for all these paths once the module exists but isn't mounted.

- [ ] **Step 3: Create `server/src/routes/font-submissions.ts`**

```ts
import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/require-auth';
import { ApiError } from '../middleware/error-handler';

export const fontSubmissionsRouter = Router();

fontSubmissionsRouter.use(requireAuth);

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

// The submitter's own belief counts as the first supporter; this many
// independent people (submitter + confirmers) agreeing is enough to
// auto-promote. An empirically-unvalidated starting point — there's no
// existing crowdsourced-agreement data to calibrate against yet, same
// treatment as this project's other tunable thresholds (e.g.
// MARGIN_THRESHOLD in font-matches.ts).
const CONFIRMATION_THRESHOLD = 3;

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

fontSubmissionsRouter.get('/pending', async (_req, res, next) => {
  try {
    const submissions = await prisma.fontSubmission.findMany({
      where: { status: 'pending' },
      include: { _count: { select: { confirmations: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.status(200).json({
      submissions: submissions.map((s) => ({
        id: s.id,
        fontName: s.fontName,
        confirmationCount: 1 + s._count.confirmations,
      })),
    });
  } catch (error) {
    next(error);
  }
});

fontSubmissionsRouter.post('/', upload.single('image'), async (req, res, next) => {
  try {
    const { fontName, sourceUrl } = req.body as { fontName?: unknown; sourceUrl?: unknown };

    if (typeof fontName !== 'string' || fontName.trim().length === 0) {
      throw new ApiError(400, 'fontName is required');
    }
    if (sourceUrl !== undefined && sourceUrl !== '') {
      if (typeof sourceUrl !== 'string') {
        throw new ApiError(400, 'sourceUrl must be a string');
      }
      try {
        new URL(sourceUrl);
      } catch {
        throw new ApiError(400, 'sourceUrl must be a valid URL');
      }
    }
    if (!req.file) {
      throw new ApiError(400, 'image is required');
    }

    const userId = req.userId as string;
    const trimmedName = fontName.trim();
    const validSourceUrl = typeof sourceUrl === 'string' && sourceUrl !== '' ? sourceUrl : null;

    const existing = await prisma.fontSubmission.findFirst({
      where: { status: 'pending', fontName: { equals: trimmedName, mode: 'insensitive' } },
    });

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

    const created = await prisma.fontSubmission.create({
      data: {
        fontName: trimmedName,
        sourceUrl: validSourceUrl,
        sampleImage: req.file.buffer,
        submittedBy: userId,
        status: 'pending',
      },
    });

    res.status(201).json({ submissionId: created.id, status: 'pending' });
  } catch (error) {
    next(error);
  }
});

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

- [ ] **Step 4: Mount the router in `server/src/app.ts`**

Change from:
```ts
import express from 'express';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { authRouter } from './routes/auth';
import { savedFontsRouter } from './routes/saved-fonts';
import { scansRouter } from './routes/scans';
import { fontMatchesRouter } from './routes/font-matches';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/saved-fonts', savedFontsRouter);
app.use('/scans', scansRouter);
app.use('/font-matches', fontMatchesRouter);

app.use(errorHandler);
```
to:
```ts
import express from 'express';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
import { authRouter } from './routes/auth';
import { savedFontsRouter } from './routes/saved-fonts';
import { scansRouter } from './routes/scans';
import { fontMatchesRouter } from './routes/font-matches';
import { fontSubmissionsRouter } from './routes/font-submissions';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/saved-fonts', savedFontsRouter);
app.use('/scans', scansRouter);
app.use('/font-matches', fontMatchesRouter);
app.use('/font-submissions', fontSubmissionsRouter);

app.use(errorHandler);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `server/`): `npx vitest run tests/font-submissions.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 6: Run typecheck and the full test suite**

Run (from `server/`): `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/font-submissions.ts server/src/app.ts server/tests/font-submissions.test.ts
git commit -m "feat: add POST/GET /font-submissions with confirmation-based promotion"
```

---

### Task 3: Client Shared Types

**Files:**
- Modify: `src/shared/api-messages.ts`
- Create: `src/shared/submission-messages.ts`

No test in this task — pure type declarations, verified by `npm run typecheck`, matching the same treatment Task 1 of the image-match-client-wiring plan gave `match-messages.ts`.

- [ ] **Step 1: Add two message types to `src/shared/api-messages.ts`**

Change from:
```ts
import type { ScanSource } from '../content/scan-types';

export type ApiMessage =
  | { type: 'SIGNUP'; email: string; password: string }
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'SAVE_FONT'; fontName: string; confidence: number; sources: ScanSource[] }
  | { type: 'DELETE_SAVED_FONT'; id: string }
  | { type: 'LOG_SCAN'; status: 'match' | 'no-match'; fontName?: string; confidence?: number };

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
```
to:
```ts
import type { ScanSource } from '../content/scan-types';

export type ApiMessage =
  | { type: 'SIGNUP'; email: string; password: string }
  | { type: 'LOGIN'; email: string; password: string }
  | { type: 'LOGOUT' }
  | { type: 'GET_AUTH_STATE' }
  | { type: 'SAVE_FONT'; fontName: string; confidence: number; sources: ScanSource[] }
  | { type: 'DELETE_SAVED_FONT'; id: string }
  | { type: 'LOG_SCAN'; status: 'match' | 'no-match'; fontName?: string; confidence?: number }
  | { type: 'GET_PENDING_SUBMISSIONS' }
  | { type: 'CONFIRM_FONT_SUBMISSION'; id: string };

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
```

- [ ] **Step 2: Create `src/shared/submission-messages.ts`**

```ts
export interface SubmitFontMessage {
  type: 'SUBMIT_FONT';
  fontName: string;
  sourceUrl: string | null;
  blob: Blob;
}

export type SubmitFontResponse =
  | { status: 'ok'; submissionId: string }
  | { status: 'error'; message: string };
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/api-messages.ts src/shared/submission-messages.ts
git commit -m "feat: add GET_PENDING_SUBMISSIONS/CONFIRM_FONT_SUBMISSION/SUBMIT_FONT message types"
```

---

### Task 4: `api-client.ts` Functions

**Files:**
- Modify: `src/background/api-client.ts`
- Test: `tests/api-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/api-client.test.ts`, after the existing `describe('matchImage', ...)` block (the last one in the file):

```ts
describe('getPendingSubmissions', () => {
  it('fetches and unwraps the submissions array', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { submissions: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] }),
    );

    const result = await getPendingSubmissions();

    expect(result).toEqual({
      ok: true,
      data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/font-submissions/pending');
  });

  it('fails fast without calling fetch when not logged in', async () => {
    const result = await getPendingSubmissions();

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

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

describe('submitFont', () => {
  it('posts the blob and fields as multipart form data with the stored access token attached', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { submissionId: 'sub-1' }));

    const blob = new Blob(['fake image data'], { type: 'image/png' });
    const result = await submitFont('Brandon Grotesque', 'https://example.com', blob);

    expect(result).toEqual({ ok: true, data: { submissionId: 'sub-1' } });
    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/font-submissions');
    expect(requestInit.method).toBe('POST');
    expect(requestInit.headers.Authorization).toBe('Bearer access-1');
    expect(requestInit.body).toBeInstanceOf(FormData);

    const body = requestInit.body as FormData;
    expect(body.get('fontName')).toBe('Brandon Grotesque');
    expect(body.get('sourceUrl')).toBe('https://example.com');
    const uploaded = body.get('image') as File;
    expect(uploaded.name).toBe('sample.png');
    expect(uploaded.size).toBe(blob.size);
  });

  it('omits the sourceUrl field entirely when null', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { submissionId: 'sub-1' }));

    await submitFont('Brandon Grotesque', null, new Blob(['fake']));

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('sourceUrl')).toBeNull();
  });

  it('fails fast without calling fetch when not logged in', async () => {
    const result = await submitFont('Brandon Grotesque', null, new Blob());

    expect(result).toEqual({ ok: false, error: 'Not logged in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes and retries once on a 401', async () => {
    await setStoredAuth(STORED);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2026-01-02T00:00:00.000Z' }),
      )
      .mockResolvedValueOnce(jsonResponse(201, { submissionId: 'sub-1' }));

    const result = await submitFont('Brandon Grotesque', null, new Blob(['fake']));

    expect(result).toEqual({ ok: true, data: { submissionId: 'sub-1' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryHeaders = fetchMock.mock.calls[2][1].headers;
    expect(retryHeaders.Authorization).toBe('Bearer access-2');
  });

  it('returns the server error message on a non-2xx response', async () => {
    await setStoredAuth(STORED);
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'fontName is required' }));

    const result = await submitFont('', null, new Blob());

    expect(result).toEqual({ ok: false, error: 'fontName is required' });
  });
});
```

Also change the import block at the top of `tests/api-client.test.ts` from:
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
} from '../src/background/api-client';
```
to:
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
} from '../src/background/api-client';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api-client.test.ts`
Expected: FAIL — `getPendingSubmissions`/`confirmFontSubmission`/`submitFont` are not exported.

- [ ] **Step 3: Add the three functions to `src/background/api-client.ts`**

Add at the end of the file, after the existing `matchImage`:

```ts
export interface PendingSubmission {
  id: string;
  fontName: string;
  confirmationCount: number;
}

export async function getPendingSubmissions(): Promise<ApiResponse<PendingSubmission[]>> {
  const result = await apiFetch<{ submissions: PendingSubmission[] }>('/font-submissions/pending', {
    method: 'GET',
    auth: 'required',
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data.submissions };
}

export async function confirmFontSubmission(
  id: string,
): Promise<ApiResponse<{ status: string; confirmationCount: number }>> {
  return apiFetch(`/font-submissions/${id}/confirm`, { method: 'POST', auth: 'required' });
}

export async function submitFont(
  fontName: string,
  sourceUrl: string | null,
  blob: Blob,
): Promise<ApiResponse<{ submissionId: string }>> {
  const stored = await getStoredAuth();
  if (!stored) {
    return { ok: false, error: 'Not logged in' };
  }

  async function postSubmission(accessToken: string): Promise<Response> {
    const formData = new FormData();
    formData.append('fontName', fontName);
    if (sourceUrl) formData.append('sourceUrl', sourceUrl);
    formData.append('image', blob, 'sample.png');
    return fetch(`${API_BASE_URL}/font-submissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: formData,
    });
  }

  let res = await postSubmission(stored.accessToken);

  if (res.status === 401) {
    const refreshed = await ensureFreshToken();
    if (refreshed) {
      const refreshedAuth = await getStoredAuth();
      if (refreshedAuth) {
        res = await postSubmission(refreshedAuth.accessToken);
      }
    }
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (res.status >= 200 && res.status < 300) {
    const data = json as { submissionId: string };
    return { ok: true, data: { submissionId: data.submissionId } };
  }

  const errorMessage = (json as { error?: string } | null)?.error ?? `Request failed with status ${res.status}`;
  return { ok: false, error: errorMessage };
}
```

Unlike `matchImage` (which deliberately never sends `Authorization`, since `/font-matches` uses `optionalAuth` and ignores it entirely), `submitFont` **must** attach and, on a 401, refresh-and-retry the stored access token — `/font-submissions` uses `requireAuth`, so a request with no token or an expired one would otherwise always 401 regardless of whether the user is actually logged in. `ensureFreshToken` is already defined earlier in this same file (not exported, but callable directly since `submitFont` lives in the same module).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/api-client.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/api-client.ts tests/api-client.test.ts
git commit -m "feat: add getPendingSubmissions/confirmFontSubmission/submitFont to api-client"
```

---

### Task 5: `service-worker.ts` Wiring

**Files:**
- Modify: `src/background/service-worker.ts`
- Test: `tests/service-worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/service-worker.test.ts`, inside the existing `describe('handleApiMessage', ...)` block, right after the existing `it('dispatches LOG_SCAN to the api-client logScan function', ...)` test and before the `it('returns an error response for an unrecognized message type', ...)` test:

```ts
  it('dispatches GET_PENDING_SUBMISSIONS to the api-client getPendingSubmissions function', async () => {
    vi.doMock('../src/background/api-client', () => ({
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      getAuthState: vi.fn(),
      saveFont: vi.fn(),
      deleteSavedFont: vi.fn(),
      logScan: vi.fn(),
      matchImage: vi.fn(),
      getPendingSubmissions: vi.fn(async () => ({
        ok: true,
        data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }],
      })),
      confirmFontSubmission: vi.fn(),
      submitFont: vi.fn(),
    }));
    const { handleApiMessage } = await import('../src/background/service-worker');
    const { getPendingSubmissions } = await import('../src/background/api-client');

    const result = await handleApiMessage({ type: 'GET_PENDING_SUBMISSIONS' });

    expect(getPendingSubmissions).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] });
  });

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

Then add a new `describe('handleSubmitFontMessage', ...)` block right after the existing `describe('handleCaptureMessage', ...)` block and before `describe('module load side effects', ...)`:

```ts
describe('handleSubmitFontMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls submitFont with the message fields and maps a successful ApiResponse to an ok SubmitFontResponse', async () => {
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
      submitFont: vi.fn(async () => ({ ok: true, data: { submissionId: 'sub-1' } })),
    }));
    const { handleSubmitFontMessage } = await import('../src/background/service-worker');
    const { submitFont } = await import('../src/background/api-client');

    const blob = new Blob(['fake image data']);
    const result = await handleSubmitFontMessage({
      type: 'SUBMIT_FONT',
      fontName: 'Brandon Grotesque',
      sourceUrl: null,
      blob,
    });

    expect(submitFont).toHaveBeenCalledWith('Brandon Grotesque', null, blob);
    expect(result).toEqual({ status: 'ok', submissionId: 'sub-1' });
  });

  it('maps a failed ApiResponse to an error SubmitFontResponse', async () => {
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
      submitFont: vi.fn(async () => ({ ok: false, error: 'fontName is required' })),
    }));
    const { handleSubmitFontMessage } = await import('../src/background/service-worker');

    const result = await handleSubmitFontMessage({
      type: 'SUBMIT_FONT',
      fontName: '',
      sourceUrl: null,
      blob: new Blob(),
    });

    expect(result).toEqual({ status: 'error', message: 'fontName is required' });
  });

  it('returns a network-error response instead of rejecting when submitFont itself throws', async () => {
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
      submitFont: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    }));
    const { handleSubmitFontMessage } = await import('../src/background/service-worker');

    const result = await handleSubmitFontMessage({
      type: 'SUBMIT_FONT',
      fontName: 'Brandon Grotesque',
      sourceUrl: null,
      blob: new Blob(),
    });

    expect(result).toEqual({ status: 'error', message: 'Network error — please try again' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: FAIL — `GET_PENDING_SUBMISSIONS`/`CONFIRM_FONT_SUBMISSION` aren't handled (fall to the `default` case), `handleSubmitFontMessage` isn't exported.

- [ ] **Step 3: Wire everything into `src/background/service-worker.ts`**

Change the import block at the top from:
```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';
import { signup, login, logout, getAuthState, saveFont, deleteSavedFont, logScan, matchImage } from './api-client';
import { captureAndCropSelection } from './image-capture';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { MatchImageMessage, MatchImageResponse } from '../shared/match-messages';
```
to:
```ts
import { isSelectionActive, markSelectionActive } from '../shared/session-state';
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
import { captureAndCropSelection } from './image-capture';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { MatchImageMessage, MatchImageResponse } from '../shared/match-messages';
import type { SubmitFontMessage, SubmitFontResponse } from '../shared/submission-messages';
```

Change `handleApiMessage`'s switch statement from:
```ts
      case 'LOG_SCAN':
        return await logScan(message.status, message.fontName, message.confidence);
      default:
        return { ok: false, error: 'Unknown message type' };
```
to:
```ts
      case 'LOG_SCAN':
        return await logScan(message.status, message.fontName, message.confidence);
      case 'GET_PENDING_SUBMISSIONS':
        return await getPendingSubmissions();
      case 'CONFIRM_FONT_SUBMISSION':
        return await confirmFontSubmission(message.id);
      default:
        return { ok: false, error: 'Unknown message type' };
```

Add `handleSubmitFontMessage`, right after the existing `handleMatchImageMessage` function:

```ts
export async function handleSubmitFontMessage(message: SubmitFontMessage): Promise<SubmitFontResponse> {
  try {
    const result = await submitFont(message.fontName, message.sourceUrl, message.blob);
    if (result.ok) {
      return { status: 'ok', submissionId: result.data.submissionId };
    }
    return { status: 'error', message: result.error };
  } catch (error) {
    // Same hazard handleMatchImageMessage's catch block already documents:
    // submitFont's fetch() call isn't wrapped internally, so a real network
    // failure would otherwise propagate an uncaught rejection here and hang
    // the content script waiting for a sendResponse that never comes.
    console.error('fontCIA: handleSubmitFontMessage failed', error);
    return { status: 'error', message: 'Network error — please try again' };
  }
}
```

Change the `chrome.runtime.onMessage.addListener` call at the bottom of the file from:
```ts
chrome.runtime.onMessage.addListener(
  (
    message: ApiMessage | CaptureSelectionMessage | MatchImageMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse,
  ) => {
    if (message.type === 'CAPTURE_SELECTION') {
      handleCaptureMessage(message, sender).then(sendResponse);
    } else if (message.type === 'MATCH_IMAGE') {
      handleMatchImageMessage(message).then(sendResponse);
    } else {
      handleApiMessage(message).then(sendResponse);
    }
    return true;
  },
);
```
to:
```ts
chrome.runtime.onMessage.addListener(
  (
    message: ApiMessage | CaptureSelectionMessage | MatchImageMessage | SubmitFontMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse,
  ) => {
    if (message.type === 'CAPTURE_SELECTION') {
      handleCaptureMessage(message, sender).then(sendResponse);
    } else if (message.type === 'MATCH_IMAGE') {
      handleMatchImageMessage(message).then(sendResponse);
    } else if (message.type === 'SUBMIT_FONT') {
      handleSubmitFontMessage(message).then(sendResponse);
    } else {
      handleApiMessage(message).then(sendResponse);
    }
    return true;
  },
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/service-worker.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/background/service-worker.ts tests/service-worker.test.ts
git commit -m "feat: dispatch SUBMIT_FONT and the pending-submissions messages in the service worker"
```

---

### Task 6: New UI States in `scan-dialogue.ts`

**Files:**
- Modify: `src/content/scan-dialogue.ts`, `src/content/theme.ts`
- Test: `tests/scan-dialogue.test.ts`

This task also changes `renderNoConfidentMatchState`'s signature (it gains a real "Name it" entry point) — the two existing tests for it need updating, not just new tests added.

- [ ] **Step 1: Update the existing `renderNoConfidentMatchState` tests and write the new failing tests**

Change the import block at the top of `tests/scan-dialogue.test.ts` from:
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
  renderRankedMatchesState,
  renderNoConfidentMatchState,
  renderMatchErrorState,
} from '../src/content/scan-dialogue';
import type { MatchResult } from '../src/content/scan-types';
import type { RankedMatch } from '../src/shared/match-messages';
```
to:
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
  renderRankedMatchesState,
  renderNoConfidentMatchState,
  renderMatchErrorState,
  renderUnrecognizedFontState,
  renderEnrollmentFormState,
  renderEnrollmentSubmittedState,
  renderEnrollmentErrorState,
} from '../src/content/scan-dialogue';
import type { MatchResult } from '../src/content/scan-types';
import type { RankedMatch } from '../src/shared/match-messages';
import type { PendingSuggestion } from '../src/content/scan-dialogue';
```

Replace the existing `describe('renderNoConfidentMatchState', ...)` block:
```ts
describe('renderNoConfidentMatchState', () => {
  it('renders distinct copy from renderNoMatchState, with a New scan button', () => {
    const body = document.createElement('div');

    renderNoConfidentMatchState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      "Couldn't find a confident match for this font.",
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderNoConfidentMatchState(body, onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
```
with:
```ts
describe('renderNoConfidentMatchState', () => {
  it('renders distinct copy from renderNoMatchState, with a New scan button', () => {
    const body = document.createElement('div');

    renderNoConfidentMatchState(body, true, vi.fn(), vi.fn(), vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      "Couldn't find a confident match for this font.",
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderNoConfidentMatchState(body, true, vi.fn(), vi.fn(), onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });

  it('shows an enabled Name it button and calls onNameIt when logged in', () => {
    const body = document.createElement('div');
    const onNameIt = vi.fn();

    renderNoConfidentMatchState(body, true, onNameIt, vi.fn(), vi.fn());

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(false);

    nameItBtn.click();
    expect(onNameIt).toHaveBeenCalledOnce();
  });

  it('shows a "Log in to name it" button instead when not logged in', () => {
    const body = document.createElement('div');
    const onLoginPrompt = vi.fn();

    renderNoConfidentMatchState(body, false, vi.fn(), onLoginPrompt, vi.fn());

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const loginBtn = buttons.find((b) => b.textContent === 'Log in to name it') as HTMLButtonElement;
    expect(buttons.some((b) => b.textContent === 'Name it')).toBe(false);

    loginBtn.click();
    expect(onLoginPrompt).toHaveBeenCalledOnce();
  });
});
```

Add these new `describe` blocks after the existing `describe('renderMatchErrorState', ...)` block (the last one in the file):

```ts
describe('renderUnrecognizedFontState', () => {
  it('renders the same message copy as renderNoMatchState, with an enabled Name it button when logged in', () => {
    const body = document.createElement('div');
    const onNameIt = vi.fn();

    renderUnrecognizedFontState(body, true, onNameIt, vi.fn(), vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe("We don't recognize this one.");
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(false);

    nameItBtn.click();
    expect(onNameIt).toHaveBeenCalledOnce();
  });

  it('shows a "Log in to name it" button instead when not logged in', () => {
    const body = document.createElement('div');
    const onLoginPrompt = vi.fn();

    renderUnrecognizedFontState(body, false, vi.fn(), onLoginPrompt, vi.fn());

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'Name it')).toBe(false);
    const loginBtn = buttons.find((b) => b.textContent === 'Log in to name it') as HTMLButtonElement;

    loginBtn.click();
    expect(onLoginPrompt).toHaveBeenCalledOnce();
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderUnrecognizedFontState(body, true, vi.fn(), vi.fn(), onNewScan);

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    const newScanBtn = buttons.find((b) => b.textContent === 'New scan') as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});

describe('renderEnrollmentFormState', () => {
  const suggestions: PendingSuggestion[] = [
    { id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 },
    { id: 'sub-2', fontName: 'Brandon Text', confirmationCount: 2 },
  ];

  it('renders a font-name input, a source-URL input, a Submit button, and a Cancel button', () => {
    const body = document.createElement('div');

    renderEnrollmentFormState(body, [], vi.fn(), vi.fn(), vi.fn());

    const inputs = body.querySelectorAll('.fontcia-input');
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).placeholder).toBe('Font name');
    expect((inputs[1] as HTMLInputElement).placeholder).toBe('Source URL (optional)');

    const buttons = Array.from(body.querySelectorAll('.fontcia-btn'));
    expect(buttons.some((b) => b.textContent === 'Submit')).toBe(true);
    expect(buttons.some((b) => b.textContent === 'Cancel')).toBe(true);
  });

  it('shows no suggestions until the font-name input has text', () => {
    const body = document.createElement('div');

    renderEnrollmentFormState(body, suggestions, vi.fn(), vi.fn(), vi.fn());

    expect(body.querySelectorAll('.fontcia-suggestion-item')).toHaveLength(0);
  });

  it('live-filters suggestions as the user types, case-insensitively', () => {
    const body = document.createElement('div');

    renderEnrollmentFormState(body, suggestions, vi.fn(), vi.fn(), vi.fn());

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'GROTESQUE';
    nameInput.dispatchEvent(new Event('input'));

    const items = body.querySelectorAll('.fontcia-suggestion-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Brandon Grotesque');
    expect(items[0].textContent).toContain('1 confirmation so far');
  });

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

  it('calls onSubmitNew with the typed name and source URL when Submit is clicked', () => {
    const body = document.createElement('div');
    const onSubmitNew = vi.fn();

    renderEnrollmentFormState(body, [], vi.fn(), onSubmitNew, vi.fn());

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'New Font Name';
    inputs[1].value = 'https://example.com';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();

    expect(onSubmitNew).toHaveBeenCalledWith('New Font Name', 'https://example.com');
  });

  it('passes null for sourceUrl when it was left blank', () => {
    const body = document.createElement('div');
    const onSubmitNew = vi.fn();

    renderEnrollmentFormState(body, [], vi.fn(), onSubmitNew, vi.fn());

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'New Font Name';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();

    expect(onSubmitNew).toHaveBeenCalledWith('New Font Name', null);
  });

  it('does not call onSubmitNew when the font name is blank', () => {
    const body = document.createElement('div');
    const onSubmitNew = vi.fn();

    renderEnrollmentFormState(body, [], vi.fn(), onSubmitNew, vi.fn());

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();

    expect(onSubmitNew).not.toHaveBeenCalled();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const body = document.createElement('div');
    const onCancel = vi.fn();

    renderEnrollmentFormState(body, [], vi.fn(), vi.fn(), onCancel);

    const cancelBtn = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    cancelBtn.click();

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('renderEnrollmentSubmittedState', () => {
  it('renders a thank-you message and a New scan button', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderEnrollmentSubmittedState(body, onNewScan);

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Thanks! Pending community confirmation.',
    );
    const newScanBtn = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'New scan',
    ) as HTMLButtonElement;
    newScanBtn.click();
    expect(onNewScan).toHaveBeenCalledOnce();
  });
});

describe('renderEnrollmentErrorState', () => {
  it('renders distinct copy from the other message states, with a New scan button', () => {
    const body = document.createElement('div');

    renderEnrollmentErrorState(body, vi.fn());

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe(
      'Something went wrong submitting this.',
    );
    const buttons = Array.from(body.querySelectorAll('.fontcia-btn-secondary'));
    expect(buttons.some((b) => b.textContent === 'New scan')).toBe(true);
  });

  it('calls onNewScan when the New scan button is clicked', () => {
    const body = document.createElement('div');
    const onNewScan = vi.fn();

    renderEnrollmentErrorState(body, onNewScan);

    const newScanBtn = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'New scan',
    ) as HTMLButtonElement;
    newScanBtn.click();

    expect(onNewScan).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: FAIL — the new functions aren't exported, and the modified `renderNoConfidentMatchState` calls don't match its current 2-parameter signature.

- [ ] **Step 3: Modify `renderNoConfidentMatchState` and add the four new functions to `src/content/scan-dialogue.ts`**

Change `renderNoConfidentMatchState` from:
```ts
export function renderNoConfidentMatchState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "Couldn't find a confident match for this font.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
```
to:
```ts
export function renderNoConfidentMatchState(
  body: HTMLElement,
  isLoggedIn: boolean,
  onNameIt: () => void,
  onLoginPrompt: () => void,
  onNewScan: () => void,
): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "Couldn't find a confident match for this font.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  if (isLoggedIn) {
    const nameItBtn = document.createElement('button');
    nameItBtn.type = 'button';
    nameItBtn.className = 'fontcia-btn fontcia-btn-secondary';
    nameItBtn.textContent = 'Name it';
    nameItBtn.addEventListener('click', onNameIt);
    actions.appendChild(nameItBtn);
  } else {
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-secondary';
    loginBtn.textContent = 'Log in to name it';
    loginBtn.addEventListener('click', onLoginPrompt);
    actions.appendChild(loginBtn);
  }

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
```

Add these four functions at the end of the file, after the (now-modified) `renderMatchErrorState`:

```ts
export function renderUnrecognizedFontState(
  body: HTMLElement,
  isLoggedIn: boolean,
  onNameIt: () => void,
  onLoginPrompt: () => void,
  onNewScan: () => void,
): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = "We don't recognize this one.";
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  if (isLoggedIn) {
    const nameItBtn = document.createElement('button');
    nameItBtn.type = 'button';
    nameItBtn.className = 'fontcia-btn fontcia-btn-secondary';
    nameItBtn.textContent = 'Name it';
    nameItBtn.addEventListener('click', onNameIt);
    actions.appendChild(nameItBtn);
  } else {
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.className = 'fontcia-btn fontcia-btn-secondary';
    loginBtn.textContent = 'Log in to name it';
    loginBtn.addEventListener('click', onLoginPrompt);
    actions.appendChild(loginBtn);
  }

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export interface PendingSuggestion {
  id: string;
  fontName: string;
  confirmationCount: number;
}

export function renderEnrollmentFormState(
  body: HTMLElement,
  pendingSuggestions: PendingSuggestion[],
  onConfirmExisting: (id: string) => void,
  onSubmitNew: (fontName: string, sourceUrl: string | null) => void,
  onCancel: () => void,
): void {
  body.replaceChildren();

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'fontcia-input';
  nameInput.placeholder = 'Font name';
  body.appendChild(nameInput);

  const suggestionsList = document.createElement('div');
  suggestionsList.className = 'fontcia-suggestions';
  body.appendChild(suggestionsList);

  function renderSuggestions(): void {
    suggestionsList.replaceChildren();
    const query = nameInput.value.trim().toLowerCase();
    if (query.length === 0) return;
    const matches = pendingSuggestions.filter((s) => s.fontName.toLowerCase().includes(query));
    for (const match of matches) {
      const suggestionBtn = document.createElement('button');
      suggestionBtn.type = 'button';
      suggestionBtn.className = 'fontcia-suggestion-item';
      const confirmationWord = match.confirmationCount === 1 ? 'confirmation' : 'confirmations';
      suggestionBtn.textContent = `Confirm as: ${match.fontName} (${match.confirmationCount} ${confirmationWord} so far)`;
      suggestionBtn.addEventListener('click', () => onConfirmExisting(match.id));
      suggestionsList.appendChild(suggestionBtn);
    }
  }

  nameInput.addEventListener('input', renderSuggestions);

  const sourceUrlInput = document.createElement('input');
  sourceUrlInput.type = 'text';
  sourceUrlInput.className = 'fontcia-input';
  sourceUrlInput.placeholder = 'Source URL (optional)';
  body.appendChild(sourceUrlInput);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'fontcia-btn fontcia-btn-primary';
  submitBtn.textContent = 'Submit';
  submitBtn.addEventListener('click', () => {
    const fontName = nameInput.value.trim();
    if (fontName.length === 0) return;
    const sourceUrl = sourceUrlInput.value.trim();
    onSubmitNew(fontName, sourceUrl.length > 0 ? sourceUrl : null);
  });
  actions.appendChild(submitBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'fontcia-btn fontcia-btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);
  actions.appendChild(cancelBtn);

  body.appendChild(actions);
}

export function renderEnrollmentSubmittedState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = 'Thanks! Pending community confirmation.';
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}

export function renderEnrollmentErrorState(body: HTMLElement, onNewScan: () => void): void {
  body.replaceChildren();

  const message = document.createElement('div');
  message.className = 'fontcia-no-match-message';
  message.textContent = 'Something went wrong submitting this.';
  body.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'fontcia-result-actions';

  const newScanBtn = document.createElement('button');
  newScanBtn.type = 'button';
  newScanBtn.className = 'fontcia-btn fontcia-btn-secondary';
  newScanBtn.textContent = 'New scan';
  newScanBtn.addEventListener('click', onNewScan);
  actions.appendChild(newScanBtn);

  body.appendChild(actions);
}
```

Each of `renderUnrecognizedFontState`/`renderEnrollmentSubmittedState`/`renderEnrollmentErrorState` is structurally close to an existing function (`renderCaptureBlockedState` etc.) but kept fully independent, matching this file's established convention and this sub-project's own spec: each situation gets its own function so a future change to one doesn't silently affect a different situation that happens to look similar today.

- [ ] **Step 4: Add the new CSS to `src/content/theme.ts`**

Change the end of `src/content/theme.ts` from:
```ts
.fontcia-match-confidence {
  font-size: 12px;
  color: var(--fontcia-text);
}
`;
```
to:
```ts
.fontcia-match-confidence {
  font-size: 12px;
  color: var(--fontcia-text);
}

.fontcia-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px solid var(--fontcia-border);
  border-radius: 6px;
  background: var(--fontcia-bg);
  color: var(--fontcia-text);
  font-size: 12px;
  font-family: inherit;
}

.fontcia-suggestions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.fontcia-suggestion-item {
  text-align: left;
  border: 1px solid var(--fontcia-border);
  border-radius: 6px;
  padding: 4px 8px;
  background: transparent;
  color: var(--fontcia-text);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.fontcia-suggestion-item:hover {
  background: var(--fontcia-border);
}
`;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/scan-dialogue.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 6: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck. **Note**: `npm test` will show failures in `tests/locked-selection.test.ts` at this point — that file still calls `renderNoConfidentMatchState`'s old 2-parameter form indirectly through `locked-selection.ts`, which Task 8 hasn't updated yet. This is expected and resolved by Task 8; don't attempt to fix `locked-selection.ts`/its tests in this task.

- [ ] **Step 7: Commit**

```bash
git add src/content/scan-dialogue.ts src/content/theme.ts tests/scan-dialogue.test.ts
git commit -m "feat: add enrollment UI states, give renderNoConfidentMatchState a real Name it"
```

---

### Task 7: `enrollment.ts` Module

**Files:**
- Create: `src/content/enrollment.ts`
- Test: `tests/enrollment.test.ts`

This is a new module, not sketched in the original spec — locked-selection.ts already juggles three flows (DOM single-result, AI ranked-candidates, and now enrollment), and enrollment's own state machine (fetch suggestions → submit-new-or-confirm-existing → show result) is a genuinely separate responsibility, not a natural growth of the other two. Extracting it keeps `locked-selection.ts` at "orchestration" rather than growing it into the largest, most tangled file in the content script. It's reused identically from both entry points via a small `getSampleBlob` strategy function the caller supplies (a real network capture for the DOM path, an instantly-resolved already-in-hand blob for the AI path).

- [ ] **Step 1: Write the failing tests**

Create `tests/enrollment.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChromeMock } from './helpers/chrome-mock';
import { startEnrollment, captureSampleBlob } from '../src/content/enrollment';
import type { CaptureResponse } from '../src/shared/capture-messages';

let chromeMock: ReturnType<typeof createChromeMock>;

beforeEach(() => {
  chromeMock = createChromeMock();
  (globalThis as unknown as { chrome: unknown }).chrome = chromeMock;
});

describe('startEnrollment', () => {
  it('fetches pending submissions and renders the form with them as suggestions', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') {
        return { ok: true, data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] };
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

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    expect(nameInput).not.toBeNull();

    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const suggestion = body.querySelector('.fontcia-suggestion-item');
    expect(suggestion?.textContent).toContain('Brandon Grotesque');
  });

  it('renders the form with no suggestions when GET_PENDING_SUBMISSIONS fails', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: false, error: 'Not logged in' };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    expect(body.querySelector('.fontcia-input')).not.toBeNull();
  });

  it('does not render if disposed before the pending-submissions fetch resolves', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => true,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    expect(body.querySelector('.fontcia-input')).toBeNull();
  });

  it('confirms an existing submission and shows the submitted state', async () => {
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

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const suggestionBtn = body.querySelector('.fontcia-suggestion-item') as HTMLButtonElement;
    suggestionBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'CONFIRM_FONT_SUBMISSION', id: 'sub-1' });
    expect(body.textContent).toContain('Thanks! Pending community confirmation.');
  });

  it('shows the enrollment error state when confirming fails', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') {
        return { ok: true, data: [{ id: 'sub-1', fontName: 'Brandon Grotesque', confirmationCount: 1 }] };
      }
      if (message.type === 'CONFIRM_FONT_SUBMISSION') {
        return { ok: false, error: 'Pending submission not found' };
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

    const nameInput = body.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'brandon';
    nameInput.dispatchEvent(new Event('input'));

    const suggestionBtn = body.querySelector('.fontcia-suggestion-item') as HTMLButtonElement;
    suggestionBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(body.textContent).toContain('Something went wrong submitting this.');
  });

  it('submits a new font using the provided getSampleBlob strategy', async () => {
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      if (message.type === 'SUBMIT_FONT') return { status: 'ok', submissionId: 'sub-1' };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'ok', blob: fakeBlob }),
    });

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'New Font Name';
    inputs[1].value = 'https://example.com';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SUBMIT_FONT',
      fontName: 'New Font Name',
      sourceUrl: 'https://example.com',
      blob: fakeBlob,
    });
    expect(body.textContent).toContain('Thanks! Pending community confirmation.');
  });

  it('renders the capture-blocked state when getSampleBlob resolves blocked', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'blocked' }),
    });

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'New Font Name';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(body.querySelector('.fontcia-no-match-message')?.textContent).toBe("Can't capture this content.");
  });

  it('renders the enrollment error state when getSampleBlob itself resolves an error', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel: vi.fn(),
      getSampleBlob: async () => ({ status: 'error', message: 'capture failed' }),
    });

    const inputs = body.querySelectorAll('.fontcia-input') as NodeListOf<HTMLInputElement>;
    inputs[0].value = 'New Font Name';

    const submitBtn = Array.from(body.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(body.textContent).toContain('Something went wrong submitting this.');
  });

  it('calls onCancel when Cancel is clicked', async () => {
    chromeMock.runtime.sendMessage.mockImplementation(async () => ({ ok: true, data: [] }));
    const onCancel = vi.fn();

    const body = document.createElement('div');
    await startEnrollment({
      body,
      isDisposed: () => false,
      onCancel,
      getSampleBlob: async () => ({ status: 'ok', blob: new Blob() }),
    });

    const cancelBtn = Array.from(body.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    cancelBtn.click();

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe('captureSampleBlob', () => {
  it('sends CAPTURE_SELECTION and maps a captured response to ok', async () => {
    const fakeBlob = new Blob(['fake']);
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ status: 'captured', blob: fakeBlob } as CaptureResponse);

    const result = await captureSampleBlob({ x: 0, y: 0, width: 10, height: 10 }, 1);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_SELECTION',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      devicePixelRatio: 1,
    });
    expect(result).toEqual({ status: 'ok', blob: fakeBlob });
  });

  it('maps a blocked response to blocked', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({ status: 'blocked' } as CaptureResponse);

    const result = await captureSampleBlob({ x: 0, y: 0, width: 10, height: 10 }, 1);

    expect(result).toEqual({ status: 'blocked' });
  });

  it('maps an error response to error', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValueOnce({
      status: 'error',
      message: 'capture failed',
    } as CaptureResponse);

    const result = await captureSampleBlob({ x: 0, y: 0, width: 10, height: 10 }, 1);

    expect(result).toEqual({ status: 'error', message: 'capture failed' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/enrollment.test.ts`
Expected: FAIL — `Cannot find module '../src/content/enrollment'`.

- [ ] **Step 3: Create `src/content/enrollment.ts`**

```ts
import type { Rect } from '../shared/selection-box';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { SubmitFontMessage, SubmitFontResponse } from '../shared/submission-messages';
import {
  renderEnrollmentFormState,
  renderEnrollmentSubmittedState,
  renderEnrollmentErrorState,
  renderCaptureBlockedState,
  type PendingSuggestion,
} from './scan-dialogue';

export type SampleBlobResult =
  | { status: 'ok'; blob: Blob }
  | { status: 'blocked' }
  | { status: 'error'; message: string };

export interface EnrollmentDeps {
  body: HTMLElement;
  isDisposed: () => boolean;
  onCancel: () => void;
  getSampleBlob: () => Promise<SampleBlobResult>;
}

function sendApiMessage<T>(message: ApiMessage): Promise<ApiResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<ApiResponse<T>>;
}

// Wraps the same CAPTURE_SELECTION round trip the AI image path already
// established (image-capture-pipeline sub-project) — the DOM path's "Name
// it" click is just a new, on-demand trigger for it, not a new mechanism.
export function captureSampleBlob(rect: Rect, devicePixelRatio: number): Promise<SampleBlobResult> {
  const message: CaptureSelectionMessage = { type: 'CAPTURE_SELECTION', rect, devicePixelRatio };
  return chrome.runtime.sendMessage(message).then((response: CaptureResponse): SampleBlobResult => {
    if (response.status === 'captured') return { status: 'ok', blob: response.blob };
    if (response.status === 'blocked') return { status: 'blocked' };
    return { status: 'error', message: response.message };
  });
}

export async function startEnrollment(deps: EnrollmentDeps): Promise<void> {
  const { body, isDisposed, onCancel, getSampleBlob } = deps;

  let pendingSuggestions: PendingSuggestion[] = [];
  try {
    const res = await sendApiMessage<PendingSuggestion[]>({ type: 'GET_PENDING_SUBMISSIONS' });
    if (res.ok) {
      pendingSuggestions = res.data;
    }
  } catch (error: unknown) {
    console.error('fontCIA: failed to fetch pending submissions', error);
  }
  if (isDisposed()) return;

  function handleConfirmExisting(id: string): void {
    sendApiMessage<{ status: string; confirmationCount: number }>({ type: 'CONFIRM_FONT_SUBMISSION', id })
      .then((res) => {
        if (isDisposed()) return;
        if (res.ok) {
          renderEnrollmentSubmittedState(body, onCancel);
        } else {
          console.error('fontCIA: confirm submission failed', res.error);
          renderEnrollmentErrorState(body, onCancel);
        }
      })
      .catch((error: unknown) => {
        if (isDisposed()) return;
        console.error('fontCIA: confirm submission message failed', error);
        renderEnrollmentErrorState(body, onCancel);
      });
  }

  function handleSubmitNew(fontName: string, sourceUrl: string | null): void {
    getSampleBlob()
      .then((sampleResult) => {
        if (isDisposed()) return;
        if (sampleResult.status === 'blocked') {
          renderCaptureBlockedState(body, onCancel);
          return;
        }
        if (sampleResult.status === 'error') {
          console.error('fontCIA: enrollment sample capture failed', sampleResult.message);
          renderEnrollmentErrorState(body, onCancel);
          return;
        }

        const message: SubmitFontMessage = { type: 'SUBMIT_FONT', fontName, sourceUrl, blob: sampleResult.blob };
        chrome.runtime
          .sendMessage(message)
          .then((response: SubmitFontResponse) => {
            if (isDisposed()) return;
            if (response.status === 'ok') {
              renderEnrollmentSubmittedState(body, onCancel);
            } else {
              console.error('fontCIA: font submission failed', response.message);
              renderEnrollmentErrorState(body, onCancel);
            }
          })
          .catch((error: unknown) => {
            if (isDisposed()) return;
            console.error('fontCIA: submit font message failed', error);
            renderEnrollmentErrorState(body, onCancel);
          });
      })
      .catch((error: unknown) => {
        if (isDisposed()) return;
        console.error('fontCIA: enrollment sample capture message failed', error);
        renderEnrollmentErrorState(body, onCancel);
      });
  }

  renderEnrollmentFormState(body, pendingSuggestions, handleConfirmExisting, handleSubmitNew, onCancel);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/enrollment.test.ts`
Expected: PASS — all tests in the file pass.

- [ ] **Step 5: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck. `tests/locked-selection.test.ts` failures from Task 6 are still expected here — resolved by Task 8.

- [ ] **Step 6: Commit**

```bash
git add src/content/enrollment.ts tests/enrollment.test.ts
git commit -m "feat: add the enrollment flow's state machine, shared by both entry points"
```

---

### Task 8: `locked-selection.ts` Wiring

**Files:**
- Modify: `src/content/locked-selection.ts`
- Test: `tests/locked-selection.test.ts`

This is the task that connects Tasks 6 and 7 to the two real entry points: the DOM path's `'unrecognized'` no-match reason, and the AI path's no-confident-match state.

- [ ] **Step 1: Update the existing tests broken by Task 6's signature change, and write the new failing tests**

Task 6 changed `renderNoConfidentMatchState`'s signature. Find this existing test in `tests/locked-selection.test.ts` (search for `'renders the no-confident-match state and logs no-match when MATCH_IMAGE succeeds with an empty array'`) — it currently passes because `locked-selection.ts` still calls the OLD 2-parameter form; once Task 8's Step 3 updates that call site, this test's assertions on rendered content remain valid (the message copy is unchanged), so **no change is needed to this specific test's assertions** — it will pass again once Step 3 lands, since it only checks `.fontcia-no-match-message`'s text and the `LOG_SCAN` call, neither of which changed.

Now add these new tests to `tests/locked-selection.test.ts`. First, add this import at the top, alongside the existing ones:
```ts
import type { PendingSubmission } from '../src/background/api-client';
```
(only needed for type annotations in the new tests below — if your editor flags it as unused because a test only needs inline object literals, it's fine to omit; the tests below don't actually require this import, so skip adding it.)

Add these tests right after the existing `'saves a candidate via SAVE_FONT using its own fontName/confidence/sources, independent of other candidates'` test (the last one before the capture-blocked/error describe blocks that follow it) — matching this file's existing flat structure (no nested `describe` blocks for these):

```ts
  it('shows an enabled Name it button on the DOM no-match state when the reason is unrecognized and logged in', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'unrecognized' }));
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
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

    expect(panel.querySelector('.fontcia-no-match-message')?.textContent).toBe("We don't recognize this one.");
    const buttons = Array.from(panel.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(false);
  });

  it('shows the bare no-match state for a mixed reason, with no working Name it button', async () => {
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

    const buttons = Array.from(panel.querySelectorAll('.fontcia-btn-secondary'));
    const nameItBtn = buttons.find((b) => b.textContent === 'Name it') as HTMLButtonElement;
    expect(nameItBtn.disabled).toBe(true);
  });

  it('starts enrollment via a fresh CAPTURE_SELECTION when Name it is clicked from the unrecognized state', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'unrecognized' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'SUBMIT_FONT') return { status: 'ok', submissionId: 'sub-1' };
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

    const nameItBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Name it',
    ) as HTMLButtonElement;
    nameItBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    const nameInput = panel.querySelector('.fontcia-input') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    nameInput.value = 'New Font Name';

    const submitBtn = Array.from(panel.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_SELECTION',
      rect: { x: 10, y: 20, width: 200, height: 30 },
      devicePixelRatio: window.devicePixelRatio,
    });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SUBMIT_FONT',
      fontName: 'New Font Name',
      sourceUrl: null,
      blob: fakeBlob,
    });
    expect(panel.textContent).toContain('Thanks! Pending community confirmation.');
  });

  it('starts enrollment reusing the already-captured blob when Name it is clicked from no-confident-match', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'no-text' }));
    const fakeBlob = new Blob(['fake image data'], { type: 'image/png' });
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'CAPTURE_SELECTION') return { status: 'captured', blob: fakeBlob };
      if (message.type === 'MATCH_IMAGE') return { status: 'ok', matches: [] };
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      if (message.type === 'SUBMIT_FONT') return { status: 'ok', submissionId: 'sub-1' };
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
    await Promise.resolve();

    const nameItBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Name it',
    ) as HTMLButtonElement;
    nameItBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    const nameInput = panel.querySelector('.fontcia-input') as HTMLInputElement;
    nameInput.value = 'New Font Name';

    const submitBtn = Array.from(panel.querySelectorAll('.fontcia-btn-primary')).find(
      (b) => b.textContent === 'Submit',
    ) as HTMLButtonElement;
    submitBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    // Only ONE CAPTURE_SELECTION call total (the original capture that fed
    // MATCH_IMAGE) — enrollment from this entry point must reuse that same
    // blob, not trigger a second capture round trip.
    const captureCalls = chromeMock.runtime.sendMessage.mock.calls.filter(
      ([msg]) => (msg as { type: string }).type === 'CAPTURE_SELECTION',
    );
    expect(captureCalls).toHaveLength(1);

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SUBMIT_FONT',
      fontName: 'New Font Name',
      sourceUrl: null,
      blob: fakeBlob,
    });
    expect(panel.textContent).toContain('Thanks! Pending community confirmation.');
  });

  it('cancelling enrollment returns to the ready state', async () => {
    const container = document.createElement('div');
    const scanFn = vi.fn(() => Promise.resolve<ScanResult>({ status: 'no-match', reason: 'unrecognized' }));
    const onRestart = vi.fn();
    chromeMock.runtime.sendMessage.mockImplementation(async (message: { type: string }) => {
      if (message.type === 'GET_AUTH_STATE') return { ok: true, data: { loggedIn: true } };
      if (message.type === 'GET_PENDING_SUBMISSIONS') return { ok: true, data: [] };
      return { ok: true, data: null };
    });

    const { panel } = renderLockedSelection(
      container,
      { x: 10, y: 20, width: 200, height: 30 },
      vi.fn(),
      onRestart,
      scanFn,
    );

    (panel.querySelector('.fontcia-btn-primary') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const nameItBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Name it',
    ) as HTMLButtonElement;
    nameItBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    const cancelBtn = Array.from(panel.querySelectorAll('.fontcia-btn-secondary')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    cancelBtn.click();

    expect(onRestart).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: FAIL — the new tests fail (no working "Name it" exists yet on either path), and existing tests fail wherever `renderNoConfidentMatchState`'s new required parameters make the current call site's output wrong.

- [ ] **Step 3: Update `src/content/locked-selection.ts`**

Change the import block at the top from:
```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult, ImageMatchResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { MatchImageMessage, MatchImageResponse, RankedMatch } from '../shared/match-messages';
import { resolveFontFromSelection } from './font-resolver';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
  renderRankedMatchesState,
  renderNoConfidentMatchState,
  renderMatchErrorState,
} from './scan-dialogue';
```
to:
```ts
import type { Rect } from '../shared/selection-box';
import type { MatchResult, ScanResult, ImageMatchResult } from './scan-types';
import type { ApiMessage, ApiResponse } from '../shared/api-messages';
import type { CaptureSelectionMessage, CaptureResponse } from '../shared/capture-messages';
import type { MatchImageMessage, MatchImageResponse, RankedMatch } from '../shared/match-messages';
import { resolveFontFromSelection } from './font-resolver';
import {
  renderReadyState,
  renderLoadingState,
  renderResultState,
  renderNoMatchState,
  renderAnalyzingImageState,
  renderCaptureBlockedState,
  renderRankedMatchesState,
  renderNoConfidentMatchState,
  renderMatchErrorState,
  renderUnrecognizedFontState,
} from './scan-dialogue';
import { startEnrollment, captureSampleBlob } from './enrollment';
```

Change `handleScan` from:
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
    let isLoggedIn = false;
    try {
      const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
      isLoggedIn = authRes.ok && authRes.data.loggedIn;
    } catch (error: unknown) {
      console.error('fontCIA: failed to check auth state', error);
    }
    if (disposed) return;
    renderUnrecognizedFontState(body, isLoggedIn, handleNameItFromDom, handleLoginPrompt, onRestart);
  }

  function handleNameItFromDom(): void {
    void startEnrollment({
      body,
      isDisposed: () => disposed,
      onCancel: onRestart,
      getSampleBlob: () => captureSampleBlob(rect, window.devicePixelRatio),
    });
  }
```

Change `renderImageMatchResult` from:
```ts
  function renderImageMatchResult(result: ImageMatchResult): void {
    if (result.status === 'matches') {
      showCandidates(result.candidates);
    } else if (result.status === 'no-confident-match') {
      renderNoConfidentMatchState(body, onRestart);
    } else {
      renderMatchErrorState(body, onRestart);
    }
  }
```
to:
```ts
  function renderImageMatchResult(result: ImageMatchResult, blob: Blob): void {
    if (result.status === 'matches') {
      showCandidates(result.candidates);
    } else if (result.status === 'no-confident-match') {
      void renderNoConfidentMatch(blob);
    } else {
      renderMatchErrorState(body, onRestart);
    }
  }

  async function renderNoConfidentMatch(blob: Blob): Promise<void> {
    let isLoggedIn = false;
    try {
      const authRes = await sendApiMessage<{ loggedIn: boolean }>({ type: 'GET_AUTH_STATE' });
      isLoggedIn = authRes.ok && authRes.data.loggedIn;
    } catch (error: unknown) {
      console.error('fontCIA: failed to check auth state', error);
    }
    if (disposed) return;
    renderNoConfidentMatchState(
      body,
      isLoggedIn,
      () => handleNameItFromBlob(blob),
      handleLoginPrompt,
      onRestart,
    );
  }

  function handleNameItFromBlob(blob: Blob): void {
    void startEnrollment({
      body,
      isDisposed: () => disposed,
      onCancel: onRestart,
      getSampleBlob: async () => ({ status: 'ok', blob }),
    });
  }
```

Change `handleImageCapture`'s call site from:
```ts
        logImageMatchResult(result);
        renderImageMatchResult(result);
```
to:
```ts
        logImageMatchResult(result);
        renderImageMatchResult(result, blob);
```

(`blob` here is `handleImageCapture`'s own parameter, already in scope — no new plumbing needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/locked-selection.test.ts`
Expected: PASS — all tests in the file pass, including the new ones.

- [ ] **Step 5: Run typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: clean typecheck; all tests pass (this is the task where the Task 6 note about expected `locked-selection.test.ts` failures resolves).

- [ ] **Step 6: Commit**

```bash
git add src/content/locked-selection.ts tests/locked-selection.test.ts
git commit -m "feat: wire Name it to enrollment from both the DOM and AI no-match states"
```

---

### Task 9: Final Verification

**Files:** None (verification only).

- [ ] **Step 1: Full typecheck and test suite (client + server)**

Run (from repo root): `npm run typecheck && npm test`
Run (from `server/`): `npx tsc --noEmit && npm test` (requires Docker's `pgvector/pgvector:pg16` postgres container up — `docker compose up -d` from `server/` if it isn't already)

Expected: clean typecheck on both; every test file passes, including all changes from Tasks 1-8.

- [ ] **Step 2: Build the extension**

Run: `npm run build`
Expected: builds cleanly, matching every prior sub-project's final verification.

- [ ] **Step 3: Optional manual smoke test**

Requires the same three-service stack verified in the font-matching-backend and image-match-client-wiring sub-projects (Docker Postgres, the embedding-service, the Node server), plus the extension loaded unpacked in Chrome. With all three running:

1. Log in (via the extension's login flow), then scan a selection containing real, rendered text in a font not in `KNOWN_FONTS` (e.g. an unusual system font, or any text rendered in something other than the 10 fonts in `src/content/known-fonts.ts`). Confirm the panel shows "We don't recognize this one." with an enabled "Name it" button.
2. Click "Name it", type a font name, submit with no source URL. Confirm "Thanks! Pending community confirmation." appears, and that (via `docker compose exec ... psql` or a Prisma Studio session) a `FontSubmission` row exists with `status = 'pending'` and a non-empty `sampleImage`.
3. Log in as a second account, trigger the same no-match scenario, open "Name it", type a name close to the first submission (different case), and confirm the live-filtered suggestion appears and can be picked instead of submitting a duplicate.
4. Confirm a screenshot-blocked page (e.g. DRM video) still shows "Can't capture this content." when "Name it" is clicked from the DOM path (reusing the existing capture-blocked state).
5. Trigger the AI image path's no-confident-match state (an image-only selection unlikely to match anything in the 100-font catalog) and confirm "Name it" is available there too, and that submitting does **not** trigger a second screenshot capture (only the original `MATCH_IMAGE` capture happened).

This step is optional given the thorough automated coverage from Tasks 1-8, but is the only way to see the real, end-to-end enrollment flow render against a real backend and a real captured screenshot — worth doing at least once before considering this sub-project fully done.

- [ ] **Step 4: If a real, fixable bug was found in Step 3**, follow the standard failing-test → fix → passing-test → commit cycle for that specific fix. If nothing broke, there's nothing to commit for this task beyond the verification itself.

---

## Self-Review Notes

- **Spec coverage:** `requireAuth`-gated `/font-submissions` with dedup-as-confirmation (Task 2) → covered; the discoverability fix — `GET /font-submissions/pending` + client-side live-filtered suggestions (Tasks 2, 6, 7) → covered; self-confirmation blocked, idempotent double-confirm, relation-count-based confirmation count, no stored counter (Task 2) → covered; sample reuse via `CAPTURE_SELECTION` on demand for the DOM path vs. the already-in-hand blob for the AI path, unified behind one `getSampleBlob` strategy (Tasks 7, 8) → covered; enrollment reachable from `'unrecognized'` only, not `'mixed'`/`'error'` (Task 8, explicit test for the `'mixed'` case staying on the disabled button) → covered; enrollment reachable from both the DOM path and the AI path's no-confident-match state (Task 8) → covered; `submitFont`'s auth-attachment fix relative to `matchImage`'s precedent, called out explicitly in the spec (Task 4) → covered; `Bytes` storage, no new blob infra (Task 1) → covered; no rejected status, no moderator gate (Task 2's schema/route have neither) → covered.
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency check:** `PendingSubmission` (Task 4, `api-client.ts`) and `PendingSuggestion` (Task 6, `scan-dialogue.ts`) are deliberately two separate, structurally-identical types rather than one shared type — `api-client.ts` and `scan-dialogue.ts` have no existing cross-import relationship in this codebase (content-script UI code doesn't import background-script API types), so introducing one here for a two-field convenience would be a new coupling for no real benefit; both shapes are simple enough (`{id, fontName, confirmationCount}`) that keeping them independently defined and structurally compatible is the lower-friction choice, consistent with how this codebase already treats `RankedMatch` vs. server-side response shapes elsewhere (never unified across the client/server boundary). `SubmitFontMessage`/`SubmitFontResponse` (Task 3) match exactly between `service-worker.ts`'s `handleSubmitFontMessage` (Task 5) and `enrollment.ts`'s `startEnrollment` (Task 7). `SampleBlobResult` (Task 7) is used identically by `captureSampleBlob` and both call sites in `locked-selection.ts` (Task 8). `renderNoConfidentMatchState`'s and `renderUnrecognizedFontState`'s parameter order (Task 6) match their call sites in `locked-selection.ts` (Task 8) exactly. `EnrollmentDeps`'s `getSampleBlob` field (Task 7) is satisfied by `captureSampleBlob(rect, window.devicePixelRatio)` (a `Rect, number => Promise<SampleBlobResult>` call, partially applied to zero args) for the DOM path and an inline `async () => ({status:'ok', blob})` for the AI path (Task 8) — both match the `() => Promise<SampleBlobResult>` shape exactly.
