import { Request, Response, Router } from 'express';
import { body } from 'express-validator';
import { asyncHandler } from '@/middleware/errorHandler';
import { validate } from '@/middleware/validate';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { Types } from 'mongoose';
import {
  AUTH_SESSION_LIMIT,
  buildRefreshRotationPipeline,
  isAcceptedPassword,
  isAcceptedRefreshToken,
  shouldRemoveRejectedRefreshToken,
} from '@/security/authPolicy';
import { EnvironmentConfig } from '@/config/environment';
import {
  assertCookieCsrf,
  clearRefreshCookie,
  deriveCookieCsrf,
  parseRefreshCookie,
  serializeRefreshCookie,
} from '@/security/authCookie';

const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

const passwordMessage = 'Password must be between 8 and 72 UTF-8 bytes';
const COOKIE_TRANSPORT_HEADER = 'x-kfive-auth-transport';
const COOKIE_TRANSPORT_VALUE = 'cookie';
const COOKIE_CSRF_HEADER = 'x-kfive-csrf';

function usesCookieTransport(req: Request): boolean {
  const value = req.header(COOKIE_TRANSPORT_HEADER);
  if (value === undefined) return false;
  if (value !== COOKIE_TRANSPORT_VALUE) throw new AppError('Invalid authentication transport', 400);
  return true;
}

function requireCookieOrigin(req: Request, config: EnvironmentConfig): void {
  const origin = req.header('origin');
  if (!origin || !config.corsOrigins.includes(origin)) throw new AppError('Exact allowed Origin required for browser authentication', 403);
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function setBrowserSession(res: Response, refreshToken: string, config: EnvironmentConfig): string {
  res.append('Set-Cookie', serializeRefreshCookie(refreshToken, config.nodeEnv));
  return deriveCookieCsrf(refreshToken, config.jwtRefreshSecret);
}

function clearBrowserSession(res: Response, config: EnvironmentConfig): void {
  res.append('Set-Cookie', clearRefreshCookie(config.nodeEnv));
}

function readBrowserRefreshToken(req: Request, res: Response, config: EnvironmentConfig): string | undefined {
  try {
    return parseRefreshCookie(req.header('cookie'), config.nodeEnv);
  } catch (error) {
    noStore(res);
    clearBrowserSession(res, config);
    throw error;
  }
}

async function appendRefreshSession(userId: Types.ObjectId, refreshToken: string): Promise<void> {
  const result = await User.updateOne(
    { _id: userId },
    { $push: { refreshTokens: { $each: [hashRefreshToken(refreshToken)], $slice: -AUTH_SESSION_LIMIT } } },
  );
  if (result.matchedCount !== 1) throw new AppError('Unable to create session', 500);
}

function readReplacementRefreshToken(req: Request, config: EnvironmentConfig): string | undefined {
  try {
    return parseRefreshCookie(req.header('cookie'), config.nodeEnv);
  } catch {
    // A successful login/registration overwrites an untrusted or malformed
    // cookie. It must not mutate any stored session based on that value.
    return undefined;
  }
}

async function revokePresentedRefreshSession(refreshToken: string | undefined, config: EnvironmentConfig): Promise<void> {
  if (!refreshToken) return;
  const refreshTokenHash = hashRefreshToken(refreshToken);
  let verified: string | jwt.JwtPayload;
  try {
    verified = jwt.verify(refreshToken, config.jwtRefreshSecret, {
      algorithms: ['HS256'],
      issuer: 'kfive-ai',
      audience: 'kfive-web',
    });
  } catch (error) {
    if (shouldRemoveRejectedRefreshToken(error)) {
      await User.updateOne(
        { refreshTokens: refreshTokenHash },
        { $pull: { refreshTokens: refreshTokenHash } },
      );
    }
    return;
  }
  if (typeof verified === 'string'
    || verified.type !== 'refresh'
    || typeof verified.userId !== 'string'
    || !Types.ObjectId.isValid(verified.userId)) {
    return;
  }
  await User.updateOne(
    { _id: new Types.ObjectId(verified.userId), refreshTokens: refreshTokenHash },
    { $pull: { refreshTokens: refreshTokenHash } },
  );
}

async function replaceBrowserRefreshSession(
  userId: Types.ObjectId,
  successor: string,
  predecessor: string | undefined,
  config: EnvironmentConfig,
): Promise<void> {
  // Revoke first. If datastore mutation fails, do not append or publish the
  // successor; the replacement request fails closed and can be retried.
  await revokePresentedRefreshSession(predecessor, config);
  await appendRefreshSession(userId, successor);
}

// Validation rules
const registerValidation = [
  body('email').isEmail().withMessage('Must be a valid email address').normalizeEmail(),
  body('username').isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 characters').matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, and underscores'),
  body('password').custom(isAcceptedPassword).withMessage(passwordMessage),
  body('firstName').optional().isLength({ max: 50 }),
  body('lastName').optional().isLength({ max: 50 }),
];

const loginValidation = [
  body('email').isEmail().withMessage('Must be a valid email address').normalizeEmail(),
  body('password').custom(isAcceptedPassword).withMessage(passwordMessage),
];

export function createAuthRouter(config: EnvironmentConfig): Router {
  const router = Router();
  const tokenLifetimes = { access: config.jwtExpiresIn, refresh: config.jwtRefreshExpiresIn };

// Routes
router.post('/register', registerValidation, validate, asyncHandler(async (req, res) => {
  const cookieTransport = usesCookieTransport(req);
  if (cookieTransport) requireCookieOrigin(req, config);
  const { email, username, password, firstName, lastName } = req.body;
  
  const existingUser = await User.findOne({ $or: [{ email }, { username }] });
  if (existingUser) {
    throw new AppError('Email or username already exists', 400);
  }
  const predecessor = cookieTransport ? readReplacementRefreshToken(req, config) : undefined;

  const user = await User.create({
    email,
    username,
    password,
    firstName,
    lastName,
  });

  const { accessToken, refreshToken } = user.generateTokens(tokenLifetimes);
  
  if (cookieTransport) {
    await replaceBrowserRefreshSession(user._id, refreshToken, predecessor, config);
  } else {
    await appendRefreshSession(user._id, refreshToken);
  }

  noStore(res);
  const csrfToken = cookieTransport ? setBrowserSession(res, refreshToken, config) : undefined;

  res.status(201).json({
    success: true,
    data: {
      user,
      accessToken,
      ...(cookieTransport ? { csrfToken } : { refreshToken }),
    }
  });
}));

router.post('/login', loginValidation, validate, asyncHandler(async (req, res) => {
  const cookieTransport = usesCookieTransport(req);
  if (cookieTransport) requireCookieOrigin(req, config);
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password');
  
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }
  const predecessor = cookieTransport ? readReplacementRefreshToken(req, config) : undefined;

  const { accessToken, refreshToken } = user.generateTokens(tokenLifetimes);
  
  if (cookieTransport) {
    await replaceBrowserRefreshSession(user._id, refreshToken, predecessor, config);
  } else {
    await appendRefreshSession(user._id, refreshToken);
  }

  noStore(res);
  const csrfToken = cookieTransport ? setBrowserSession(res, refreshToken, config) : undefined;

  res.json({
    success: true,
    data: {
      user,
      accessToken,
      ...(cookieTransport ? { csrfToken } : { refreshToken }),
    }
  });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const cookieTransport = usesCookieTransport(req);
  let refreshToken: unknown;
  if (cookieTransport) {
    requireCookieOrigin(req, config);
    noStore(res);
    if (req.body?.refreshToken !== undefined) throw new AppError('Ambiguous refresh credentials', 400);
    const cookieToken = readBrowserRefreshToken(req, res, config);
    if (!cookieToken) {
      clearBrowserSession(res, config);
      throw new AppError('Browser refresh cookie required', 401);
    }
    assertCookieCsrf(cookieToken, req.header(COOKIE_CSRF_HEADER), config.jwtRefreshSecret);
    refreshToken = cookieToken;
  } else {
    refreshToken = req.body?.refreshToken;
  }

  if (!isAcceptedRefreshToken(refreshToken)) throw new AppError('Valid refresh token required', 400);

  const refreshTokenHash = hashRefreshToken(refreshToken);
  let decoded: jwt.JwtPayload;
  try {
    const verified = jwt.verify(refreshToken, config.jwtRefreshSecret, {
      algorithms: ['HS256'],
      issuer: 'kfive-ai',
      audience: 'kfive-web',
    });
    if (typeof verified === 'string'
      || verified.type !== 'refresh'
      || typeof verified.userId !== 'string'
      || !Types.ObjectId.isValid(verified.userId)) {
      throw new jwt.JsonWebTokenError('Invalid refresh token payload');
    }
    decoded = verified;
  } catch (error) {
    if (shouldRemoveRejectedRefreshToken(error)) {
      const cleanup = await User.updateOne(
        { refreshTokens: refreshTokenHash },
        { $pull: { refreshTokens: refreshTokenHash } },
      );
      if (cookieTransport && cleanup.modifiedCount === 1) clearBrowserSession(res, config);
    }
    throw new AppError('Invalid or expired refresh token', 401);
  }

  const user = await User.findOne({ _id: decoded.userId, refreshTokens: refreshTokenHash });
  if (!user) {
    throw new AppError('Invalid refresh token', 401);
  }

  const tokens = user.generateTokens(tokenLifetimes);
  const rotated = await User.findOneAndUpdate(
    { _id: user._id, refreshTokens: refreshTokenHash },
    buildRefreshRotationPipeline(refreshTokenHash, hashRefreshToken(tokens.refreshToken)),
    { new: true, updatePipeline: true },
  );
  if (!rotated) {
    throw new AppError('Invalid refresh token', 401);
  }

  noStore(res);
  const csrfToken = cookieTransport ? setBrowserSession(res, tokens.refreshToken, config) : undefined;

  res.json({
    success: true,
    data: cookieTransport ? { accessToken: tokens.accessToken, csrfToken } : tokens,
  });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const cookieTransport = usesCookieTransport(req);
  let refreshToken: unknown;
  if (cookieTransport) {
    requireCookieOrigin(req, config);
    noStore(res);
    if (req.body?.refreshToken !== undefined) throw new AppError('Ambiguous refresh credentials', 400);
    const cookieToken = readBrowserRefreshToken(req, res, config);
    if (!cookieToken) {
      clearBrowserSession(res, config);
      res.json({ success: true, message: 'Logged out successfully' });
      return;
    }
    assertCookieCsrf(cookieToken, req.header(COOKIE_CSRF_HEADER), config.jwtRefreshSecret);
    refreshToken = cookieToken;
  } else {
    refreshToken = req.body?.refreshToken;
  }
  if (refreshToken !== undefined && !isAcceptedRefreshToken(refreshToken)) {
    throw new AppError('Valid refresh token required', 400);
  }
  if (refreshToken) {
    const refreshTokenHash = hashRefreshToken(refreshToken);
    await User.updateOne(
      { refreshTokens: refreshTokenHash },
      { $pull: { refreshTokens: refreshTokenHash } },
    );
  }
  noStore(res);
  if (cookieTransport) clearBrowserSession(res, config);
  res.json({ success: true, message: 'Logged out successfully' });
}));

  return router;
}
