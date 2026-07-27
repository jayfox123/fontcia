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
