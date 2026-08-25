import { Router } from 'express';
import { body } from 'express-validator';
import { asyncHandler } from '@/middleware/errorHandler';
import { validate } from '@/middleware/validate';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';

const router = Router();

const hashRefreshToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

// Validation rules
const registerValidation = [
  body('email').isEmail().withMessage('Must be a valid email address').normalizeEmail(),
  body('username').isLength({ min: 3, max: 30 }).withMessage('Username must be 3-30 characters').matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, and underscores'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters long'),
  body('firstName').optional().isLength({ max: 50 }),
  body('lastName').optional().isLength({ max: 50 }),
];

const loginValidation = [
  body('email').isEmail().withMessage('Must be a valid email address').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
];

// Routes
router.post('/register', registerValidation, validate, asyncHandler(async (req, res) => {
  const { email, username, password, firstName, lastName } = req.body;
  
  const existingUser = await User.findOne({ $or: [{ email }, { username }] });
  if (existingUser) {
    throw new AppError('Email or username already exists', 400);
  }

  const user = await User.create({
    email,
    username,
    password,
    firstName,
    lastName,
  });

  const { accessToken, refreshToken } = user.generateTokens();
  
  user.refreshTokens.push(hashRefreshToken(refreshToken));
  await user.save();

  res.status(201).json({
    success: true,
    data: {
      user,
      accessToken,
      refreshToken
    }
  });
}));

router.post('/login', loginValidation, validate, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password +refreshTokens');
  
  if (!user || !(await user.comparePassword(password))) {
    throw new AppError('Invalid email or password', 401);
  }

  const { accessToken, refreshToken } = user.generateTokens();
  
  user.refreshTokens.push(hashRefreshToken(refreshToken));
  await user.save();

  res.json({
    success: true,
    data: {
      user,
      accessToken,
      refreshToken
    }
  });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) throw new AppError('Refresh token required', 400);

  const refreshTokenHash = hashRefreshToken(refreshToken);
  const user = await User.findOne({ refreshTokens: refreshTokenHash }).select('+refreshTokens');
  if (!user) throw new AppError('Invalid refresh token', 401);

  try {
    jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!, {
      algorithms: ['HS256'],
      issuer: 'kfive-ai',
      audience: 'kfive-web',
    });
    
    // Create new tokens
    const tokens = user.generateTokens();
    
    // Replace old refresh token with new one
    user.refreshTokens = user.refreshTokens.filter((tokenHash: string) => tokenHash !== refreshTokenHash);
    user.refreshTokens.push(hashRefreshToken(tokens.refreshToken));
    await user.save();

    res.json({
      success: true,
      data: tokens
    });
  } catch (error) {
    user.refreshTokens = user.refreshTokens.filter((tokenHash: string) => tokenHash !== refreshTokenHash);
    await user.save();
    throw new AppError('Invalid or expired refresh token', 401);
  }
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const user = await User.findOne({ refreshTokens: refreshTokenHash }).select('+refreshTokens');
    if (user) {
      user.refreshTokens = user.refreshTokens.filter((tokenHash: string) => tokenHash !== refreshTokenHash);
      await user.save();
    }
  }
  res.json({ success: true, message: 'Logged out successfully' });
}));

export default router;
