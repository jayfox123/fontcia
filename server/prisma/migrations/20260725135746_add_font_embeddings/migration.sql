-- CreateExtension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "Font" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "googleSlug" TEXT NOT NULL,
    "category" TEXT,

    CONSTRAINT "Font_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FontEmbedding" (
    "id" TEXT NOT NULL,
    "fontId" TEXT NOT NULL,
    "renderVariant" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FontEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Font_name_key" ON "Font"("name");

-- CreateIndex
CREATE UNIQUE INDEX "FontEmbedding_fontId_renderVariant_key" ON "FontEmbedding"("fontId", "renderVariant");

-- AddForeignKey
ALTER TABLE "FontEmbedding" ADD CONSTRAINT "FontEmbedding_fontId_fkey" FOREIGN KEY ("fontId") REFERENCES "Font"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "FontEmbedding_embedding_idx" ON "FontEmbedding" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
