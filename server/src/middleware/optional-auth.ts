import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../lib/jwt';

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (token) {
    const payload = verifyAccessToken(token);
    if (payload) {
      req.userId = payload.sub;
    }
  }

  next();
}
