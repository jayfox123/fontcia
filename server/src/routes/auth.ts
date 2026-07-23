import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { hashPassword, verifyPassword } from '../lib/password';
import {
  signAccessToken,
  accessTokenExpiresAt,
  generateRefreshToken,
  hashRefreshToken,
} from '../lib/jwt';
import { createAuthRateLimit } from '../middleware/auth-rate-limit';
import { ApiError } from '../middleware/error-handler';

export const authRouter = Router();

const signupRateLimit = createAuthRateLimit();
const loginRateLimit = createAuthRateLimit();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

async function issueTokenPair(userId: string, email: string): Promise<TokenPairResponse> {
  const accessToken = signAccessToken({ sub: userId, email });
  const { rawToken, tokenHash, expiresAt } = generateRefreshToken();

  await prisma.refreshToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  return { accessToken, refreshToken: rawToken, expiresAt: accessTokenExpiresAt() };
}

authRouter.post('/signup', signupRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body as { email?: unknown; password?: unknown };

    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ApiError(400, 'A valid email is required');
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new ApiError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ApiError(409, 'Email already registered');
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({ data: { email, passwordHash } });

    const tokens = await issueTokenPair(user.id, user.email);
    res.status(201).json({ user: { id: user.id, email: user.email }, ...tokens });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/login', loginRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body as { email?: unknown; password?: unknown };

    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new ApiError(401, 'Invalid email or password');
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new ApiError(401, 'Invalid email or password');
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new ApiError(401, 'Invalid email or password');
    }

    const tokens = await issueTokenPair(user.id, user.email);
    res.status(200).json({ user: { id: user.id, email: user.email }, ...tokens });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body as { refreshToken?: unknown };

    if (typeof refreshToken !== 'string') {
      throw new ApiError(401, 'Invalid refresh token');
    }

    const tokenHash = hashRefreshToken(refreshToken);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!stored || stored.expiresAt.getTime() < Date.now()) {
      throw new ApiError(401, 'Invalid refresh token');
    }

    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user) {
      throw new ApiError(401, 'Invalid refresh token');
    }

    await prisma.refreshToken.delete({ where: { id: stored.id } });

    const tokens = await issueTokenPair(user.id, user.email);
    res.status(200).json(tokens);
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body as { refreshToken?: unknown };

    if (typeof refreshToken === 'string') {
      const tokenHash = hashRefreshToken(refreshToken);
      await prisma.refreshToken.deleteMany({ where: { tokenHash } });
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
