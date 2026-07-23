import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/jwt';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  req.userId = payload.sub;
  next();
}
