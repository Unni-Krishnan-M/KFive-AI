import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { HydratedDocument, Model, Schema, model } from 'mongoose';

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
  generateTokens(): { accessToken: string; refreshToken: string };
}

type UserModel = Model<UserRecord, object, UserMethods>;
export type UserDocument = HydratedDocument<UserRecord, UserMethods>;

const userSchema = new Schema<UserRecord, UserModel, UserMethods>({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true, minlength: 8, select: false },
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
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.generateTokens = function generateTokens() {
  const payload = { userId: this._id.toString(), email: this.email, role: this.role };
  const accessOptions: SignOptions = {
    expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: 'kfive-ai',
    audience: 'kfive-web',
  };
  const refreshOptions: SignOptions = {
    expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as SignOptions['expiresIn'],
    algorithm: 'HS256',
    issuer: 'kfive-ai',
    audience: 'kfive-web',
  };

  return {
    accessToken: jwt.sign(payload, process.env.JWT_SECRET!, accessOptions),
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
