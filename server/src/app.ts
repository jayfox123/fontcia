import express from 'express';
import { corsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/error-handler';

export const app = express();

app.use(corsMiddleware);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use(errorHandler);
