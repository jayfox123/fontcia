# Font Matching Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a cropped image, identify which font it most likely shows by comparing a DINOv2 embedding of the crop against a pgvector-indexed reference set built from a curated 100-font Google Fonts subset, and return ranked matches through a new `POST /font-matches` endpoint.

**Architecture:** A new standalone Python FastAPI microservice (`embedding-service/`) wraps a pretrained DINOv2 model as a fixed feature extractor — no training. The existing Node/Express/Prisma backend (`server/`, from sub-project 4a) gains `Font`/`FontEmbedding` models on a pgvector-enabled Postgres, a route that calls the embedding service and runs a cosine-similarity nearest-neighbor query, and two offline scripts (build the reference set via Puppeteer-rendered font samples; evaluate real retrieval accuracy).

**Tech Stack:** Python 3.11, FastAPI, `transformers`/`torch` (DINOv2), Node/Express/Prisma (existing), PostgreSQL + pgvector, Puppeteer, Vitest + supertest, pytest.

---

## File Structure

```
embedding-service/                    — new, sibling to server/
  main.py                              — FastAPI app, loads DINOv2 once, exposes /health and /embed
  requirements.txt
  Dockerfile
  tests/
    test_health.py
    test_embed.py

server/                                — existing 4a/4b backend, gains:
  docker-compose.yml                   — postgres image swapped for a pgvector-enabled one (modified)
  prisma/schema.prisma                 — Font, FontEmbedding models (modified)
  src/
    env.ts                             — EMBEDDING_SERVICE_URL added (modified)
    app.ts                             — mounts fontMatchesRouter (modified)
    lib/
      embedding-client.ts              — calls embedding-service's /embed (new)
      vector-format.ts                 — number[] -> pgvector literal string (new)
      google-fonts.ts                  — fetch a Google Font file as a data URL (new)
    routes/
      font-matches.ts                  — POST /font-matches (new)
  scripts/
    fonts.json                         — curated 100-font list (new)
    lib/
      render-font-sample.ts            — Puppeteer: render text in a font, screenshot it (new)
    build-reference-set.ts             — populate Font/FontEmbedding from fonts.json (new)
    evaluate-matching.ts               — measure real top-1/3/5 retrieval accuracy (new)
  tests/
    helpers/reset-db.ts                — Font, FontEmbedding added to TRUNCATE list (modified)
    font-embedding-schema.test.ts      — pgvector round-trip through Prisma raw queries (new)
    embedding-client.test.ts           — new
    google-fonts.test.ts               — new
    font-matches.test.ts               — new
```

`.env.example` and `.env.test.example` both gain `EMBEDDING_SERVICE_URL`.

---

### Task 1: Embedding Service Scaffolding

**Files:**
- Create: `embedding-service/main.py`, `embedding-service/requirements.txt`, `embedding-service/Dockerfile`
- Test: `embedding-service/tests/test_health.py`

This is the first Python code in the repo. No dependency on anything in `server/` or `src/`.

- [ ] **Step 1: Create `embedding-service/requirements.txt`**

```
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
python-multipart>=0.0.12
pytest>=8.3.0
httpx>=0.27.0
```

(`torch`, `transformers`, `pillow` are added in Task 2, once they're actually needed — keeps this scaffolding step's install fast and its scope minimal.)

- [ ] **Step 2: Write the failing test**

`embedding-service/tests/test_health.py`:

```python
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def test_health_returns_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 3: Set up the Python environment and run the test to verify it fails**

Run (from `embedding-service/`):
```bash
python3 -m venv venv
source venv/bin/activate   # on Windows: venv\Scripts\activate
pip install -r requirements.txt
pytest tests/test_health.py -v
```
Expected: FAIL — `Cannot find module main` / `ModuleNotFoundError: No module named 'main'` (or similar — `main.py` doesn't exist yet).

- [ ] **Step 4: Create `embedding-service/main.py`**

```python
from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest tests/test_health.py -v`
Expected: PASS — 1 test passed.

- [ ] **Step 6: Create `embedding-service/Dockerfile`**

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 7: Verify the server boots and responds**

Run: `uvicorn main:app --port 8000` (from `embedding-service/`, with the venv active; leave running)

In a second terminal: `curl http://localhost:8000/health`
Expected: `{"status":"ok"}`

Stop the server before continuing.

- [ ] **Step 8: Commit**

```bash
git add embedding-service/requirements.txt embedding-service/main.py embedding-service/Dockerfile embedding-service/tests/test_health.py
git commit -m "chore: scaffold the embedding service (FastAPI, health check)"
```

---

### Task 2: Real DINOv2 `/embed` Endpoint

**Files:**
- Modify: `embedding-service/requirements.txt`, `embedding-service/main.py`, `embedding-service/Dockerfile`
- Test: `embedding-service/tests/test_embed.py`

- [ ] **Step 1: Add ML dependencies to `embedding-service/requirements.txt`**

Change from:
```
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
python-multipart>=0.0.12
pytest>=8.3.0
httpx>=0.27.0
```
to:
```
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
python-multipart>=0.0.12
pytest>=8.3.0
httpx>=0.27.0
torch>=2.5.0
transformers>=4.46.0
pillow>=11.0.0
```

- [ ] **Step 2: Write the failing tests**

`embedding-service/tests/test_embed.py`:

```python
import io

from fastapi.testclient import TestClient
from PIL import Image

from main import app

client = TestClient(app)


def _make_test_image(color: tuple[int, int, int]) -> bytes:
    img = Image.new("RGB", (100, 100), color=color)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def test_embed_returns_a_384_length_vector():
    image_bytes = _make_test_image((255, 0, 0))
    response = client.post("/embed", files={"image": ("test.png", image_bytes, "image/png")})

    assert response.status_code == 200
    embedding = response.json()["embedding"]
    assert len(embedding) == 384
    assert all(isinstance(v, float) for v in embedding)


def test_embed_is_deterministic_for_the_same_image():
    image_bytes = _make_test_image((0, 255, 0))

    response_a = client.post("/embed", files={"image": ("test.png", image_bytes, "image/png")})
    response_b = client.post("/embed", files={"image": ("test.png", image_bytes, "image/png")})

    assert response_a.json()["embedding"] == response_b.json()["embedding"]


def test_embed_differs_for_visibly_different_images():
    red_image = _make_test_image((255, 0, 0))
    blue_image = _make_test_image((0, 0, 255))

    response_a = client.post("/embed", files={"image": ("a.png", red_image, "image/png")})
    response_b = client.post("/embed", files={"image": ("b.png", blue_image, "image/png")})

    assert response_a.json()["embedding"] != response_b.json()["embedding"]


def test_embed_rejects_invalid_image_data():
    response = client.post("/embed", files={"image": ("bad.png", b"not an image", "image/png")})

    assert response.status_code == 400
```

- [ ] **Step 3: Install the new dependencies and run the tests to verify they fail**

Run (from `embedding-service/`, venv active): `pip install -r requirements.txt && pytest tests/test_embed.py -v`
Expected: FAIL — `404 Not Found` for `/embed` (route doesn't exist yet).

- [ ] **Step 4: Modify `embedding-service/main.py`**

Replace the entire file with:

```python
import io

from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image
from transformers import AutoImageProcessor, AutoModel
import torch

app = FastAPI()

MODEL_NAME = "facebook/dinov2-small"
_processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
_model = AutoModel.from_pretrained(MODEL_NAME)
_model.eval()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/embed")
async def embed(image: UploadFile = File(...)) -> dict[str, list[float]]:
    try:
        contents = await image.read()
        pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc

    inputs = _processor(images=pil_image, return_tensors="pt")
    with torch.no_grad():
        outputs = _model(**inputs)

    # Mean-pool the last hidden state across patch tokens to get one
    # fixed-length vector per image (the [CLS] token, index 0, is an
    # equally common choice — mean-pooling is used here for a slightly
    # more robust whole-image representation across DINOv2's patch grid).
    embedding = outputs.last_hidden_state.mean(dim=1).squeeze().tolist()

    return {"embedding": embedding}
```

**Note:** the first time this module loads, `AutoImageProcessor.from_pretrained`/`AutoModel.from_pretrained` download the DINOv2-small weights (roughly 100MB) from Hugging Face — this requires internet access and will take noticeably longer than every subsequent load (cached locally afterward, typically under `~/.cache/huggingface`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pytest tests/test_embed.py -v`
Expected: PASS — 4 tests passed. (First run will be slow due to the model download noted above — this is expected, not a failure.)

- [ ] **Step 6: Run the full test suite**

Run: `pytest -v`
Expected: PASS — 5 tests passed (1 from Task 1 + 4 new).

- [ ] **Step 7: Update `embedding-service/Dockerfile` to pre-download the model at build time**

Change from:
```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```
to:
```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Pre-download the model weights at build time so the container's first real
# request doesn't pay that cost, and so the image works without outbound
# network access at runtime.
RUN python -c "from transformers import AutoImageProcessor, AutoModel; AutoImageProcessor.from_pretrained('facebook/dinov2-small'); AutoModel.from_pretrained('facebook/dinov2-small')"

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 8: Verify the server boots and produces a real embedding**

Run: `uvicorn main:app --port 8000` (leave running)

In a second terminal, create a small test PNG and post it:
```bash
python3 -c "from PIL import Image; Image.new('RGB', (100,100), color=(200,50,50)).save('/tmp/test.png')"
curl -X POST -F "image=@/tmp/test.png" http://localhost:8000/embed
```
Expected: a JSON object with an `"embedding"` array of 384 numbers.

Stop the server before continuing.

- [ ] **Step 9: Commit**

```bash
git add embedding-service/requirements.txt embedding-service/main.py embedding-service/Dockerfile embedding-service/tests/test_embed.py
git commit -m "feat: load DINOv2 and implement the real /embed endpoint"
```

---

### Task 3: `Font`/`FontEmbedding` Schema on pgvector

**Files:**
- Modify: `server/docker-compose.yml`, `server/prisma/schema.prisma`, `server/tests/helpers/reset-db.ts`, `server/.env.example`, `server/.env.test.example`, `server/src/env.ts`
- Test: `server/tests/font-embedding-schema.test.ts`

- [ ] **Step 1: Swap the Postgres image for a pgvector-enabled one**

Change `server/docker-compose.yml` from:
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
to:
```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
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

`pgvector/pgvector:pg16` is built on top of the same Postgres 16 as before, just with the pgvector extension installed — the existing data volume is compatible, nothing needs to be recreated.

- [ ] **Step 2: Recreate the container on the new image and enable the extension**

Run (from `server/`):
```bash
docker compose up -d
docker compose exec -T postgres psql -U fontcia -d fontcia_dev -c "CREATE EXTENSION IF NOT EXISTS vector;"
docker compose exec -T postgres psql -U fontcia -d fontcia_test -c "CREATE EXTENSION IF NOT EXISTS vector;"
```
Expected: `docker compose up -d` reports the postgres service recreated with the new image (or pulls it first if not cached); both `CREATE EXTENSION` commands report success (or that the extension already exists, harmless either way).

- [ ] **Step 3: Add `Font` and `FontEmbedding` to `server/prisma/schema.prisma`**

Add at the end of the file (after the existing `RefreshToken` model):

```prisma

model Font {
  id         String          @id @default(uuid())
  name       String          @unique
  googleSlug String
  category   String?
  embeddings FontEmbedding[]
}

model FontEmbedding {
  id            String   @id @default(uuid())
  fontId        String
  font          Font     @relation(fields: [fontId], references: [id])
  renderVariant String
  embedding     Unsupported("vector(384)")
  createdAt     DateTime @default(now())

  @@unique([fontId, renderVariant])
}
```

`embedding` uses Prisma's `Unsupported(...)` escape hatch since pgvector's `vector` type has no native Prisma equivalent — the raw type string passes straight through into the generated migration SQL. Fields of this type are excluded from Prisma Client's normal `create`/`update`/`findMany` methods entirely; reading and writing them requires `$queryRaw`/`$executeRaw`, which Tasks 5 and 6 use. `@@unique([fontId, renderVariant])` makes re-running the reference-set build idempotent (Task 6) and gives `fontId` lookups an index for free, the same reasoning already used for `SavedFont`'s `@@unique([userId, fontName])`.

- [ ] **Step 4: Generate the migration without applying it, so the ANN index can be added by hand**

Run: `npx prisma migrate dev --create-only --name add_font_embeddings`
Expected: creates `server/prisma/migrations/<timestamp>_add_font_embeddings/migration.sql`, does NOT apply it yet.

- [ ] **Step 5: Append the ivfflat index to the generated migration file**

Open the newly-created `server/prisma/migrations/<timestamp>_add_font_embeddings/migration.sql` and add this line at the end:

```sql
CREATE INDEX "FontEmbedding_embedding_idx" ON "FontEmbedding" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
```

`lists = 10` is sized for the ~100-row v1 catalog (pgvector's own guidance is roughly `rows / 1000` for larger tables, with a small fixed value being fine at this scale) — revisit if the catalog grows substantially. `vector_cosine_ops` matches the cosine-distance (`<=>`) queries Task 5's route uses.

- [ ] **Step 6: Apply the migration to the dev database, then the test database**

Run:
```bash
npx prisma migrate dev
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_test" npx prisma migrate deploy
```
Expected: both commands report the `add_font_embeddings` migration applied successfully.

- [ ] **Step 7: Add `Font` and `FontEmbedding` to the test-reset helper**

Change `server/tests/helpers/reset-db.ts` from:
```ts
import { prisma } from '../../src/lib/prisma';

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "User" RESTART IDENTITY CASCADE',
  );
}
```
to:
```ts
import { prisma } from '../../src/lib/prisma';

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "RefreshToken", "SavedFont", "Scan", "User", "FontEmbedding", "Font" RESTART IDENTITY CASCADE',
  );
}
```

- [ ] **Step 8: Write the failing test**

`server/tests/font-embedding-schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

beforeEach(async () => {
  await resetDb();
});

describe('Font / FontEmbedding schema', () => {
  it('stores and retrieves a vector via raw SQL, and cosine distance to itself is ~0', async () => {
    const font = await prisma.font.create({
      data: { name: 'Test Font', googleSlug: 'Test Font', category: 'sans-serif' },
    });

    const embeddingId = randomUUID();
    const vectorLiteral = `[${Array.from({ length: 384 }, (_, i) => i / 384).join(',')}]`;

    await prisma.$executeRaw`
      INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
      VALUES (${embeddingId}, ${font.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
    `;

    const result = await prisma.$queryRaw<Array<{ distance: number }>>`
      SELECT embedding <=> ${vectorLiteral}::vector AS distance
      FROM "FontEmbedding"
      WHERE id = ${embeddingId}
    `;

    expect(result).toHaveLength(1);
    expect(result[0].distance).toBeCloseTo(0, 5);
  });

  it('enforces one embedding per (font, renderVariant)', async () => {
    const font = await prisma.font.create({
      data: { name: 'Duplicate Test Font', googleSlug: 'Duplicate Test Font' },
    });
    const vectorLiteral = `[${Array.from({ length: 384 }, () => 0).join(',')}]`;

    await prisma.$executeRaw`
      INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
      VALUES (${randomUUID()}, ${font.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
    `;

    await expect(
      prisma.$executeRaw`
        INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
        VALUES (${randomUUID()}, ${font.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
      `,
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/font-embedding-schema.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 10: Add `EMBEDDING_SERVICE_URL` to env files and `env.ts`**

Change `server/.env.example` from:
```
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_dev"
JWT_SECRET="replace-with-a-long-random-string-in-real-deployments"
PORT=3001
```
to:
```
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_dev"
JWT_SECRET="replace-with-a-long-random-string-in-real-deployments"
PORT=3001
EMBEDDING_SERVICE_URL="http://localhost:8000"
```

Change `server/.env.test.example` from:
```
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_test"
JWT_SECRET="test-secret-not-for-production"
PORT=3002
```
to:
```
DATABASE_URL="postgresql://fontcia:fontcia@localhost:5433/fontcia_test"
JWT_SECRET="test-secret-not-for-production"
PORT=3002
EMBEDDING_SERVICE_URL="http://localhost:8000"
```

Copy the changes into the real, uncommitted `.env`/`.env.test` files too:
```bash
echo 'EMBEDDING_SERVICE_URL="http://localhost:8000"' >> .env
echo 'EMBEDDING_SERVICE_URL="http://localhost:8000"' >> .env.test
```

Change `server/src/env.ts` from:
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
to:
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
  EMBEDDING_SERVICE_URL: requireEnv('EMBEDDING_SERVICE_URL'),
};
```

- [ ] **Step 11: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass (2 new + all pre-existing 4a/4b tests, since `.env.test` now has the value `env.ts` requires).

- [ ] **Step 12: Commit**

```bash
git add server/docker-compose.yml server/prisma server/tests/helpers/reset-db.ts server/tests/font-embedding-schema.test.ts server/.env.example server/.env.test.example server/src/env.ts
git commit -m "feat: add Font/FontEmbedding schema on pgvector"
```

Note: `server/.env` and `server/.env.test` are gitignored — the `echo >>` commands in Step 10 update your local copies only, not tracked by git.

---

### Task 4: Embedding Client and Vector Formatting

**Files:**
- Create: `server/src/lib/embedding-client.ts`, `server/src/lib/vector-format.ts`
- Test: `server/tests/embedding-client.test.ts`, `server/tests/vector-format.test.ts`

- [ ] **Step 1: Write the failing tests**

`server/tests/vector-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toVectorLiteral } from '../src/lib/vector-format';

describe('toVectorLiteral', () => {
  it('formats a number array as a pgvector literal string', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });

  it('formats an empty array', () => {
    expect(toVectorLiteral([])).toBe('[]');
  });

  it('formats negative and integer values correctly', () => {
    expect(toVectorLiteral([-1, 0, 1.5])).toBe('[-1,0,1.5]');
  });
});
```

`server/tests/embedding-client.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getEmbedding } from '../src/lib/embedding-client';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getEmbedding', () => {
  it('posts the image buffer as multipart form data and returns the embedding', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    });

    const result = await getEmbedding(Buffer.from('fake image bytes'));

    expect(result).toEqual([0.1, 0.2, 0.3]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8000/embed');
    expect(options.method).toBe('POST');
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('throws a clear error when the embedding service responds with a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ detail: 'Invalid image' }),
    });

    await expect(getEmbedding(Buffer.from('bad'))).rejects.toThrow('Embedding service returned 400: Invalid image');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/vector-format.test.ts tests/embedding-client.test.ts`
Expected: FAIL — both modules don't exist yet.

- [ ] **Step 3: Write `server/src/lib/vector-format.ts`**

```ts
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
```

- [ ] **Step 4: Write `server/src/lib/embedding-client.ts`**

```ts
import { env } from '../env';

export async function getEmbedding(imageBuffer: Buffer): Promise<number[]> {
  const formData = new FormData();
  formData.append('image', new Blob([imageBuffer]), 'crop.png');

  const res = await fetch(`${env.EMBEDDING_SERVICE_URL}/embed`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(`Embedding service returned ${res.status}: ${body?.detail ?? 'unknown error'}`);
  }

  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/vector-format.test.ts tests/embedding-client.test.ts`
Expected: PASS — 3 + 2 = 5 tests passed.

- [ ] **Step 6: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/embedding-client.ts server/src/lib/vector-format.ts server/tests/embedding-client.test.ts server/tests/vector-format.test.ts
git commit -m "feat: add embedding-service HTTP client and pgvector literal formatting"
```

---

### Task 5: `POST /font-matches`

**Files:**
- Create: `server/src/routes/font-matches.ts`
- Modify: `server/src/app.ts`, `server/package.json`
- Test: `server/tests/font-matches.test.ts`

- [ ] **Step 1: Add `multer` to `server/package.json`**

Change the `dependencies` block from:
```json
  "dependencies": {
    "@prisma/client": "^6.1.0",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.1",
    "jsonwebtoken": "^9.0.2"
  },
```
to:
```json
  "dependencies": {
    "@prisma/client": "^6.1.0",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.1",
    "jsonwebtoken": "^9.0.2",
    "multer": "^1.4.5-lts.1"
  },
```

Change the `devDependencies` block to add `"@types/multer": "^1.4.12"` (alphabetically, after `"@types/jsonwebtoken"`):
```json
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/multer": "^1.4.12",
    "@types/node": "^22.7.0",
    "@types/supertest": "^6.0.2",
    "prisma": "^6.1.0",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
```

Run: `npm install`
Expected: installs cleanly, `multer` and `@types/multer` present in `node_modules`. `@types/multer` augments Express's request type with `req.file`/`req.files` automatically — no manual `.d.ts` edit needed.

- [ ] **Step 2: Write the failing tests**

`server/tests/font-matches.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { resetDb } from './helpers/reset-db';

vi.mock('../src/lib/embedding-client', () => ({
  getEmbedding: vi.fn(),
}));

import { getEmbedding } from '../src/lib/embedding-client';

async function seedFontEmbedding(fontName: string, embedding: number[]): Promise<void> {
  const font = await prisma.font.create({ data: { name: fontName, googleSlug: fontName, category: 'sans-serif' } });
  const vectorLiteral = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`
    INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
    VALUES (${randomUUID()}, ${font.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
  `;
}

beforeEach(async () => {
  await resetDb();
  vi.mocked(getEmbedding).mockReset();
});

describe('POST /font-matches', () => {
  it('rejects a request with no image', async () => {
    const res = await request(app).post('/font-matches');
    expect(res.status).toBe(400);
  });

  it('returns the closest font first, with confidence near 100 for an exact match', async () => {
    const queryEmbedding = Array.from({ length: 384 }, () => 1);
    const farEmbedding = Array.from({ length: 384 }, () => -1);

    await seedFontEmbedding('Exact Match Font', queryEmbedding);
    await seedFontEmbedding('Far Font', farEmbedding);

    vi.mocked(getEmbedding).mockResolvedValueOnce(queryEmbedding);

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(201);
    expect(res.body.matches[0].fontName).toBe('Exact Match Font');
    expect(res.body.matches[0].confidence).toBeGreaterThanOrEqual(99);
    expect(res.body.matches[0].sources[0]).toEqual({
      url: 'https://fonts.google.com/specimen/Exact+Match+Font',
      label: 'Google Fonts',
      votes: 1,
    });
  });

  it('returns an empty matches array when no reference embeddings exist', async () => {
    vi.mocked(getEmbedding).mockResolvedValueOnce(Array.from({ length: 384 }, () => 0));

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(201);
    expect(res.body.matches).toEqual([]);
  });

  it('returns at most 5 matches even when more reference fonts exist', async () => {
    for (let i = 0; i < 7; i++) {
      await seedFontEmbedding(`Font ${i}`, Array.from({ length: 384 }, () => i));
    }
    vi.mocked(getEmbedding).mockResolvedValueOnce(Array.from({ length: 384 }, () => 0));

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(201);
    expect(res.body.matches).toHaveLength(5);
  });

  it('returns a 500 without crashing when the embedding service call fails', async () => {
    vi.mocked(getEmbedding).mockRejectedValueOnce(new Error('embedding service unreachable'));

    const res = await request(app).post('/font-matches').attach('image', Buffer.from('fake-image'), 'crop.png');

    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/font-matches.test.ts`
Expected: FAIL — no `/font-matches` route exists yet (404s where the tests expect 400/201/500).

- [ ] **Step 4: Write `server/src/routes/font-matches.ts`**

```ts
import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma';
import { optionalAuth } from '../middleware/optional-auth';
import { ApiError } from '../middleware/error-handler';
import { getEmbedding } from '../lib/embedding-client';
import { toVectorLiteral } from '../lib/vector-format';

export const fontMatchesRouter = Router();

const upload = multer({ storage: multer.memoryStorage() });

const TOP_K = 5;

interface MatchRow {
  fontName: string;
  googleSlug: string;
  distance: number;
}

fontMatchesRouter.post('/', optionalAuth, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      throw new ApiError(400, 'image is required');
    }

    const embedding = await getEmbedding(req.file.buffer);
    const vectorLiteral = toVectorLiteral(embedding);

    const rows = await prisma.$queryRaw<MatchRow[]>`
      SELECT "Font".name AS "fontName", "Font"."googleSlug" AS "googleSlug",
             "FontEmbedding".embedding <=> ${vectorLiteral}::vector AS distance
      FROM "FontEmbedding"
      JOIN "Font" ON "Font".id = "FontEmbedding"."fontId"
      ORDER BY distance ASC
      LIMIT ${TOP_K}
    `;

    const matches = rows.map((row) => ({
      fontName: row.fontName,
      confidence: Math.round((1 - row.distance / 2) * 100),
      sources: [
        {
          url: `https://fonts.google.com/specimen/${row.googleSlug.replace(/ /g, '+')}`,
          label: 'Google Fonts',
          votes: 1,
        },
      ],
    }));

    res.status(201).json({ matches });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 5: Mount the router in `server/src/app.ts`**

Change from:
```ts
import express from 'express';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';
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
to:
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

Note `multer`'s `upload.single('image')` runs BEFORE `express.json()` would apply to this route's body — that's fine and expected, since `express.json()` only parses `application/json` bodies and multer only parses `multipart/form-data` ones; they don't conflict, each middleware only acts on requests with the content-type it understands.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/font-matches.test.ts`
Expected: PASS — 5 tests passed.

- [ ] **Step 7: Verify typecheck and full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json server/src/routes/font-matches.ts server/src/app.ts server/tests/font-matches.test.ts
git commit -m "feat: add POST /font-matches with pgvector cosine-similarity search"
```

---

### Task 6: Reference-Set Build Pipeline

**Files:**
- Create: `server/scripts/fonts.json`, `server/src/lib/google-fonts.ts`, `server/scripts/lib/render-font-sample.ts`, `server/scripts/build-reference-set.ts`
- Modify: `server/package.json`
- Test: `server/tests/google-fonts.test.ts`

- [ ] **Step 1: Add `puppeteer` to `server/package.json`**

Change the `dependencies` block (from Task 5's state) to add `puppeteer` after `multer`:
```json
  "dependencies": {
    "@prisma/client": "^6.1.0",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.21.0",
    "express-rate-limit": "^7.4.1",
    "jsonwebtoken": "^9.0.2",
    "multer": "^1.4.5-lts.1",
    "puppeteer": "^23.9.0"
  },
```

Also add two new scripts to the `"scripts"` block:
```json
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build-reference-set": "tsx scripts/build-reference-set.ts",
    "evaluate-matching": "tsx scripts/evaluate-matching.ts"
  },
```

Run: `npm install`
Expected: installs cleanly (Puppeteer downloads a bundled Chromium during install — this can take a few minutes and needs internet access; that's expected, not a failure).

- [ ] **Step 2: Write the failing test for the pure Google-Fonts-CSS-parsing logic**

`server/tests/google-fonts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractFontFileUrl } from '../src/lib/google-fonts';

describe('extractFontFileUrl', () => {
  it('extracts the font file URL from a realistic Google Fonts CSS2 response', () => {
    const css = `
      /* latin */
      @font-face {
        font-family: 'Inter';
        font-style: normal;
        font-weight: 400;
        src: url(https://fonts.gstatic.com/s/inter/v13/abc123.woff2) format('woff2');
      }
    `;
    expect(extractFontFileUrl(css)).toBe('https://fonts.gstatic.com/s/inter/v13/abc123.woff2');
  });

  it('returns null when no font-face src is found', () => {
    expect(extractFontFileUrl('not valid css')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/google-fonts.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/google-fonts'`

- [ ] **Step 4: Write `server/src/lib/google-fonts.ts`**

```ts
export function extractFontFileUrl(css2ResponseText: string): string | null {
  const match = css2ResponseText.match(/src: url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
  return match ? match[1] : null;
}

// The one function in this file that touches the real network — fetches a
// font's CSS from Google Fonts, then fetches the actual font file it points
// at, and returns it as a data URL a browser page's @font-face rule can load
// directly with no separate static file server. Not unit-tested: it's a thin
// network-glue wrapper around extractFontFileUrl (which IS tested above),
// verified for real by actually running build-reference-set.ts (Task 6's
// own later step) and evaluate-matching.ts (Task 7).
export async function fetchGoogleFontDataUrl(fontName: string): Promise<string> {
  const cssRes = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}&display=swap`);
  const css = await cssRes.text();

  const fontFileUrl = extractFontFileUrl(css);
  if (!fontFileUrl) {
    throw new Error(`Could not find a font file URL for "${fontName}" in the Google Fonts CSS response`);
  }

  const fontRes = await fetch(fontFileUrl);
  const fontBuffer = Buffer.from(await fontRes.arrayBuffer());
  return `data:font/woff2;base64,${fontBuffer.toString('base64')}`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/google-fonts.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 6: Create `server/scripts/fonts.json`**

```json
[
  { "name": "Inter" },
  { "name": "Roboto" },
  { "name": "Open Sans" },
  { "name": "Lato" },
  { "name": "Montserrat" },
  { "name": "Poppins" },
  { "name": "Nunito" },
  { "name": "Source Sans Pro" },
  { "name": "Playfair Display" },
  { "name": "Merriweather" },
  { "name": "Oswald" },
  { "name": "Raleway" },
  { "name": "PT Sans" },
  { "name": "Ubuntu" },
  { "name": "Noto Sans" },
  { "name": "Work Sans" },
  { "name": "Rubik" },
  { "name": "Quicksand" },
  { "name": "Karla" },
  { "name": "Mulish" },
  { "name": "Barlow" },
  { "name": "DM Sans" },
  { "name": "Inconsolata" },
  { "name": "Fira Sans" },
  { "name": "Josefin Sans" },
  { "name": "Cabin" },
  { "name": "Titillium Web" },
  { "name": "Libre Baskerville" },
  { "name": "Crimson Text" },
  { "name": "EB Garamond" },
  { "name": "Bitter" },
  { "name": "Archivo" },
  { "name": "Manrope" },
  { "name": "Space Grotesk" },
  { "name": "Outfit" },
  { "name": "Sora" },
  { "name": "Plus Jakarta Sans" },
  { "name": "Lexend" },
  { "name": "Figtree" },
  { "name": "Epilogue" },
  { "name": "IBM Plex Sans" },
  { "name": "IBM Plex Serif" },
  { "name": "IBM Plex Mono" },
  { "name": "Roboto Slab" },
  { "name": "Roboto Mono" },
  { "name": "Roboto Condensed" },
  { "name": "PT Serif" },
  { "name": "Domine" },
  { "name": "Lora" },
  { "name": "Vollkorn" },
  { "name": "Alegreya" },
  { "name": "Cormorant Garamond" },
  { "name": "Spectral" },
  { "name": "Zilla Slab" },
  { "name": "Arvo" },
  { "name": "Bree Serif" },
  { "name": "Abril Fatface" },
  { "name": "Bebas Neue" },
  { "name": "Anton" },
  { "name": "Righteous" },
  { "name": "Pacifico" },
  { "name": "Caveat" },
  { "name": "Dancing Script" },
  { "name": "Shadows Into Light" },
  { "name": "Indie Flower" },
  { "name": "Permanent Marker" },
  { "name": "Amatic SC" },
  { "name": "Comfortaa" },
  { "name": "Baloo 2" },
  { "name": "Fredoka" },
  { "name": "Nunito Sans" },
  { "name": "Hind" },
  { "name": "Assistant" },
  { "name": "Heebo" },
  { "name": "Varela Round" },
  { "name": "Josefin Slab" },
  { "name": "Yanone Kaffeesatz" },
  { "name": "Signika" },
  { "name": "Overpass" },
  { "name": "Exo 2" },
  { "name": "Orbitron" },
  { "name": "Rajdhani" },
  { "name": "Chivo" },
  { "name": "Prompt" },
  { "name": "Kanit" },
  { "name": "Maven Pro" },
  { "name": "Catamaran" },
  { "name": "Teko" },
  { "name": "Saira" },
  { "name": "Red Hat Display" },
  { "name": "Public Sans" },
  { "name": "Be Vietnam Pro" },
  { "name": "Urbanist" },
  { "name": "Sen" },
  { "name": "Jost" },
  { "name": "Asap" },
  { "name": "Questrial" },
  { "name": "Krub" },
  { "name": "Mukta" },
  { "name": "Cardo" }
]
```

(100 entries — the first 10 are the same families already seeded in the extension's `src/content/known-fonts.ts`.)

- [ ] **Step 7: Create `server/scripts/lib/render-font-sample.ts`**

```ts
import type { Browser } from 'puppeteer';

// Real-browser-only glue (Puppeteer) — not unit-tested, same treatment
// google-fonts.ts's fetchGoogleFontDataUrl got above. Verified by actually
// running build-reference-set.ts and evaluate-matching.ts.
export async function renderFontSample(browser: Browser, fontDataUrl: string, text: string): Promise<Buffer> {
  const page = await browser.newPage();
  await page.setViewport({ width: 500, height: 120 });
  await page.setContent(`
    <html>
      <head>
        <style>
          @font-face { font-family: 'SampleFont'; src: url('${fontDataUrl}'); }
          body { margin: 0; padding: 10px; background: white; }
          #sample { font-family: 'SampleFont'; font-size: 32px; color: black; }
        </style>
      </head>
      <body><div id="sample">${text}</div></body>
    </html>
  `);
  await page.evaluate(() => document.fonts.ready);
  const el = await page.$('#sample');
  if (!el) throw new Error('Sample element not found');
  const buffer = (await el.screenshot({ type: 'png' })) as Buffer;
  await page.close();
  return buffer;
}
```

- [ ] **Step 8: Create `server/scripts/build-reference-set.ts`**

```ts
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { fetchGoogleFontDataUrl } from '../src/lib/google-fonts';
import { toVectorLiteral } from '../src/lib/vector-format';
import { getEmbedding } from '../src/lib/embedding-client';
import { renderFontSample } from './lib/render-font-sample';

interface FontEntry {
  name: string;
}

const BUILD_PHRASE = 'The quick brown fox jumps over the lazy dog';

async function main(): Promise<void> {
  const fonts: FontEntry[] = JSON.parse(readFileSync(resolve(__dirname, 'fonts.json'), 'utf-8'));
  const browser = await puppeteer.launch();

  let succeeded = 0;
  let failed = 0;

  for (const [index, font] of fonts.entries()) {
    console.log(`[${index + 1}/${fonts.length}] ${font.name}`);
    try {
      const dataUrl = await fetchGoogleFontDataUrl(font.name);
      const image = await renderFontSample(browser, dataUrl, BUILD_PHRASE);
      const embedding = await getEmbedding(image);

      const fontRow = await prisma.font.upsert({
        where: { name: font.name },
        create: { name: font.name, googleSlug: font.name, category: null },
        update: {},
      });

      const vectorLiteral = toVectorLiteral(embedding);
      await prisma.$executeRaw`
        INSERT INTO "FontEmbedding" (id, "fontId", "renderVariant", embedding, "createdAt")
        VALUES (${randomUUID()}, ${fontRow.id}, 'regular-pangram', ${vectorLiteral}::vector, now())
        ON CONFLICT ("fontId", "renderVariant") DO UPDATE SET embedding = EXCLUDED.embedding
      `;
      succeeded++;
    } catch (error) {
      failed++;
      console.error(`  Failed: ${font.name}`, error);
    }
  }

  await browser.close();
  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed out of ${fonts.length}.`);
}

main().catch((error) => {
  console.error('build-reference-set failed:', error);
  process.exit(1);
});
```

`ON CONFLICT ("fontId", "renderVariant") DO UPDATE SET embedding = EXCLUDED.embedding` targets the `@@unique([fontId, renderVariant])` constraint from Task 3 — re-running this script re-embeds and overwrites rather than erroring or duplicating, which matters since Task 8 needs to run this for real and may need to re-run it if something fails partway.

- [ ] **Step 9: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all tests pass (only `google-fonts.test.ts`'s 2 tests are new in this task — `build-reference-set.ts` and `render-font-sample.ts` are deliberately untested, per the comments above them).

- [ ] **Step 11: Commit**

```bash
git add server/package.json server/package-lock.json server/src/lib/google-fonts.ts server/scripts server/tests/google-fonts.test.ts
git commit -m "feat: add the Puppeteer-based reference-set build pipeline"
```

(Do NOT run `npm run build-reference-set` for real yet — that's Task 8, once the embedding service is actually running and this is the final, reviewed state of the pipeline.)

---

### Task 7: Evaluation Script

**Files:**
- Create: `server/scripts/evaluate-matching.ts`

No dedicated test — this script's only new logic beyond what Task 6 already built and tested is HTTP orchestration (calling the live `/font-matches` endpoint) and console reporting, which is exactly the kind of real-network, real-server, manual/on-demand tool this project already treats as verified-by-actually-running-it rather than unit-tested (matching `build-reference-set.ts`'s treatment in Task 6).

- [ ] **Step 1: Create `server/scripts/evaluate-matching.ts`**

```ts
import puppeteer from 'puppeteer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchGoogleFontDataUrl } from '../src/lib/google-fonts';
import { renderFontSample } from './lib/render-font-sample';

interface FontEntry {
  name: string;
}

const EVAL_PHRASE = 'Pack my box with five dozen liquor jugs';
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3001';

async function matchFont(imageBuffer: Buffer): Promise<string[]> {
  const formData = new FormData();
  formData.append('image', new Blob([imageBuffer]), 'eval.png');

  const res = await fetch(`${SERVER_URL}/font-matches`, { method: 'POST', body: formData });
  if (!res.ok) {
    throw new Error(`/font-matches returned ${res.status}`);
  }
  const body = (await res.json()) as { matches: Array<{ fontName: string }> };
  return body.matches.map((m) => m.fontName);
}

async function main(): Promise<void> {
  const fonts: FontEntry[] = JSON.parse(readFileSync(resolve(__dirname, 'fonts.json'), 'utf-8'));
  const browser = await puppeteer.launch();

  let top1 = 0;
  let top3 = 0;
  let top5 = 0;
  let errors = 0;

  for (const [index, font] of fonts.entries()) {
    try {
      const dataUrl = await fetchGoogleFontDataUrl(font.name);
      const image = await renderFontSample(browser, dataUrl, EVAL_PHRASE);
      const results = await matchFont(image);

      const rank = results.indexOf(font.name);
      if (rank === 0) top1++;
      if (rank !== -1 && rank < 3) top3++;
      if (rank !== -1 && rank < 5) top5++;

      console.log(
        `[${index + 1}/${fonts.length}] ${font.name}: top result "${results[0] ?? 'none'}" ${rank === 0 ? '✓' : '✗'}`,
      );
    } catch (error) {
      errors++;
      console.error(`  Error evaluating ${font.name}:`, error);
    }
  }

  await browser.close();

  const total = fonts.length;
  console.log('\n--- Evaluation results ---');
  console.log(`Total fonts evaluated: ${total} (${errors} errors)`);
  console.log(`Top-1 accuracy: ${top1}/${total} (${((top1 / total) * 100).toFixed(1)}%)`);
  console.log(`Top-3 accuracy: ${top3}/${total} (${((top3 / total) * 100).toFixed(1)}%)`);
  console.log(`Top-5 accuracy: ${top5}/${total} (${((top5 / total) * 100).toFixed(1)}%)`);
}

main().catch((error) => {
  console.error('evaluate-matching failed:', error);
  process.exit(1);
});
```

It deliberately renders a DIFFERENT phrase (`EVAL_PHRASE`) than `build-reference-set.ts`'s `BUILD_PHRASE` — testing retrieval against a font sample the reference set wasn't built from, not the exact image it was indexed with.

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/evaluate-matching.ts
git commit -m "feat: add the retrieval-accuracy evaluation script"
```

(Do NOT run it for real yet — that's Task 8, once the reference set has actually been built.)

---

### Task 8: Final Verification — Build the Real Reference Set and Measure Real Accuracy

**Files:** None (verification only, though a small fix may be needed and committed if something real is found).

This task requires: Docker running, Python 3.11 with the embedding-service's dependencies installed, and outbound internet access to `fonts.googleapis.com`/`fonts.gstatic.com` and Hugging Face's model hub. It is long-running — expect the reference-set build (100 fonts, each a real network fetch + real Puppeteer render + real model inference call) and the evaluation run (another 100, same cost) to together take a meaningful amount of wall-clock time, plausibly tens of minutes depending on network and CPU inference speed. This is expected, not a sign of a problem.

- [ ] **Step 1: Start all services**

```bash
cd server
docker compose up -d
```

In a separate terminal, start the embedding service (from `embedding-service/`, with its venv active):
```bash
uvicorn main:app --port 8000
```
Leave it running. Verify: `curl http://localhost:8000/health` → `{"status":"ok"}`.

In a separate terminal, build and start the Node server (from `server/`):
```bash
npm run build
npm run start
```
Leave it running. Verify: `curl http://localhost:3001/health` → `{"status":"ok"}`.

- [ ] **Step 2: Full automated suite and typecheck**

In a separate terminal (from `server/`): `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass, including everything added across Tasks 1-7.

Also run the Python suite (from `embedding-service/`, venv active): `pytest -v`
Expected: 5 tests passed.

- [ ] **Step 3: Build the real reference set**

From `server/`: `npm run build-reference-set`
Expected: prints progress for all 100 fonts, ending with `Done. N succeeded, M failed out of 100.` If any fonts fail (e.g. a transient network error, or a font name that doesn't resolve via the Google Fonts CSS2 API as expected), that's useful, honest information — report exactly which ones and why, don't silently ignore it. A handful of failures out of 100 doesn't block proceeding to Step 4; a large fraction failing is a real problem worth stopping to investigate (likely a systemic issue with the fetch/render pipeline, not per-font flukes).

Spot-check the result: `docker compose exec -T postgres psql -U fontcia -d fontcia_dev -c 'SELECT COUNT(*) FROM "Font";'` and `-c 'SELECT COUNT(*) FROM "FontEmbedding";'` — both counts should be close to 100 (equal to `succeeded` from Step 3's output).

- [ ] **Step 4: Run the real evaluation**

From `server/`: `npm run evaluate-matching`
Expected: prints per-font results, ending with the Top-1/Top-3/Top-5 accuracy report.

- [ ] **Step 5: Record and report the results honestly**

Report the exact accuracy numbers from Step 4 plainly — do not editorialize them as "good enough" or "needs work." Per the design spec, no numeric accuracy bar was pre-committed; whether these results are sufficient to build client wiring on top of is a decision to make with the user after seeing the real numbers, not before. If the numbers look unexpectedly low (e.g., close to what random guessing among 100 fonts would produce, roughly 1% top-1), that's a real, important finding to flag clearly rather than downplay — it would mean DINOv2-as-fixed-feature-extractor may not be discriminating fonts well enough, which is exactly the kind of signal this evaluation step exists to surface.

- [ ] **Step 6: Stop the running services**

Stop the Node server, the embedding service, and leave `docker compose` running (or `docker compose down` if you're fully done for now — your call, matching how this project has handled leaving local dev infra up between sessions before).

- [ ] **Step 7: If a real, fixable bug was found anywhere in Steps 1-5** (not an accuracy-quality finding — an actual code defect, like a crash, a wrong response shape, or a script that fails outright rather than just underperforming), fix it following the standard failing-test → fix → passing-test → commit cycle for that specific fix. If nothing broke, there's nothing to commit for this task beyond the verification itself.

---

## Self-Review Notes

- **Spec coverage:** pretrained DINOv2 embedding, no training (Tasks 1-2) → covered; Python microservice, not ONNX-in-Node (Tasks 1-2) → covered; Puppeteer-based rendering (Task 6, `render-font-sample.ts`) → covered; pgvector storage with an ANN index, paying down the `Font`/`FontEmbedding` schema debt from 4a (Task 3) → covered; curated 100-font catalog, not the full ~1,500 (Task 6's `fonts.json`) → covered; minimal crop preprocessing — note: the spec called for resize/pad preprocessing of the incoming crop before embedding, but Task 5's route currently forwards `req.file.buffer` to `getEmbedding` unmodified, relying on the embedding-service's own `_processor` (Hugging Face's `AutoImageProcessor`) to handle resizing internally, which it does automatically as part of standard DINOv2 preprocessing — this satisfies the spec's intent (minimal preprocessing, no deskew/binarization) without needing separate resize code on the Node side; flagging this explicitly since the spec's wording could be read as expecting Node-side preprocessing. `POST /font-matches` with optional auth and `ScanSource`-shaped response (Task 5) → covered; mandatory evaluation deliverable with no pre-committed accuracy bar (Task 7 + Task 8 Step 5) → covered.
- **Placeholder scan:** none found — every step has complete, runnable code, including the full real 100-font list (not a truncated "...and more").
- **Type consistency check:** `toVectorLiteral` (Task 4) is used identically in `font-matches.ts` (Task 5) and `build-reference-set.ts` (Task 6) — same function, same import path, no reimplementation. `getEmbedding`'s `(imageBuffer: Buffer) => Promise<number[]>` signature (Task 4) matches exactly how it's called in both `font-matches.ts` (Task 5, on `req.file.buffer`) and `build-reference-set.ts` (Task 6, on a Puppeteer screenshot `Buffer`). `extractFontFileUrl`/`fetchGoogleFontDataUrl` (Task 6) are imported with matching names/signatures into both `build-reference-set.ts` and `evaluate-matching.ts` (Task 7) — no drift. `renderFontSample(browser, fontDataUrl, text)`'s parameter order (Task 6) matches both call sites in Task 6 and Task 7 exactly. The `FontEmbedding` raw-SQL column list (`id, "fontId", "renderVariant", embedding, "createdAt"`) is identical across the Task 3 test, Task 5's route query, and Task 6's insert — no column-name drift.
