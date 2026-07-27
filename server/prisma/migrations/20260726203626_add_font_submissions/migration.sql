-- CreateTable
CREATE TABLE "FontSubmission" (
    "id" TEXT NOT NULL,
    "fontName" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sampleImage" BYTEA NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FontSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FontSubmissionConfirmation" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FontSubmissionConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FontSubmissionConfirmation_submissionId_confirmedBy_key" ON "FontSubmissionConfirmation"("submissionId", "confirmedBy");

-- AddForeignKey
ALTER TABLE "FontSubmission" ADD CONSTRAINT "FontSubmission_submittedBy_fkey" FOREIGN KEY ("submittedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FontSubmissionConfirmation" ADD CONSTRAINT "FontSubmissionConfirmation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FontSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FontSubmissionConfirmation" ADD CONSTRAINT "FontSubmissionConfirmation_confirmedBy_fkey" FOREIGN KEY ("confirmedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
