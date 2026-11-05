import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { HydratedDocument, Model, Schema, model } from 'mongoose';
import { isAcceptedPassword } from '@/security/authPolicy';

export interface UserUsage {
  conversationsCount: number;
  documentsUploaded: number;
  tokensUsed: number;
}

export interface UserRecord {
  email: string;
  username: string;
  password: string;
  firstName?: string;
  lastName?: string;
  role: 'user' | 'admin';
  refreshTokens: string[];
  preferences: {
    theme: 'dark' | 'light' | 'system';
    language: string;
    ai: {
      defaultModel: string;
      voiceEnabled: boolean;
    };
  };
  usage: UserUsage;
}

interface UserMethods {
  comparePassword(candidate: string): Promise<boolean>;
  generateTokens(lifetimes: { access: string; refresh: string }): { accessToken: string; refreshToken: string };
}

type UserModel = Model<UserRecord, object, UserMethods>;
export type UserDocument = HydratedDocument<UserRecord, UserMethods>;

const userSchema = new Schema<UserRecord, UserModel, UserMethods>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true },
  password: {
    type: String,
    required: true,
    select: false,
    validate: {
      validator: isAcceptedPassword,
      message: 'Password must be between 8 and 72 UTF-8 bytes',
    },
  },
  firstName: { type: String, trim: true, maxlength: 50 },
  lastName: { type: String, trim: true, maxlength: 50 },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  refreshTokens: { type: [String], default: [], select: false },
  preferences: {
    theme: { type: String, enum: ['dark', 'light', 'system'], default: 'dark' },
    language: { type: String, default: 'en' },
    ai: {
      defaultModel: { type: String, default: 'phi3' },
      voiceEnabled: { type: Boolean, default: true },
    },
  },
  usage: {
    conversationsCount: { type: Number, default: 0, min: 0 },
    documentsUploaded: { type: Number, default: 0, min: 0 },
    tokensUsed: { type: Number, default: 0, min: 0 },
  },
}, { timestamps: true });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate: string): Promise<boolean> {
  if (!isAcceptedPassword(candidate)) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.generateTokens = function generateTokens(lifetimes: { access: string; refresh: string }) {
  const payload = { userId: this._id.toString(), email: this.email, role: this.role };
  const accessOptions: SignOptions = {
    expiresIn: lifetimes.access as SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: 'kfive-ai',
    audience: 'kfive-web',
    jwtid: randomUUID(),
  };
  const refreshOptions: SignOptions = {
    expiresIn: lifetimes.refresh as SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: 'kfive-ai',
    audience: 'kfive-web',
    jwtid: randomUUID(),
  };

  return {
    accessToken: jwt.sign({ ...payload, type: 'access' }, process.env.JWT_SECRET!, accessOptions),
    refreshToken: jwt.sign({ ...payload, type: 'refresh' }, process.env.JWT_REFRESH_SECRET!, refreshOptions),
  };
};

userSchema.set('toJSON', {
  transform: (_document, returned) => {
    const safeUser = returned as Partial<UserRecord>;
    delete safeUser.password;
    delete safeUser.refreshTokens;
    return returned;
  },
});

export const User = model<UserRecord, UserModel>('User', userSchema);
