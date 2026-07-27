-- AlterTable
ALTER TABLE "Font" ADD COLUMN     "matchKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "googleSlug" DROP NOT NULL;

-- AlterTable
ALTER TABLE "FontSubmissionConfirmation" ADD COLUMN     "sourceUrl" TEXT;

-- CreateTable
CREATE TABLE "FontSource" (
    "id" TEXT NOT NULL,
    "fontId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "votes" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FontSource_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "FontSource" ADD CONSTRAINT "FontSource_fontId_fkey" FOREIGN KEY ("fontId") REFERENCES "Font"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
