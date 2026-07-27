import { BadRequestException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { compare, hash } from 'bcryptjs';
import { sign } from 'jsonwebtoken';
import { Model } from 'mongoose';
import { PreferredCurrency, User, UserDocument } from '../schemas/user.schema';

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async onModuleInit() {
    const existingUsers = await this.userModel.estimatedDocumentCount().exec();
    if (existingUsers > 0) return;

    const username = (process.env.DEFAULT_ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
    await this.userModel.create({
      username,
      passwordHash: await hash(password, 12),
      role: 'admin',
      enabled: true,
      preferredCurrency: 'USD',
    });
  }

  async login(username: string, password: string) {
    const normalizedUsername = username?.trim().toLowerCase();
    const user = normalizedUsername
      ? await this.userModel.findOne({ username: normalizedUsername }).exec()
      : null;
    if (!user || !user.enabled || !(await compare(password || '', user.passwordHash))) {
      throw new UnauthorizedException('Invalid username or password.');
    }

    const profile = {
      id: String(user._id),
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      preferredCurrency: user.preferredCurrency || 'USD',
    };

    return {
      user: profile,
      token: sign(
        { sub: profile.id, username: profile.username, role: profile.role },
        this.jwtSecret(),
        { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
      ),
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters.');
    }
    const user = await this.userModel.findById(userId).exec();
    if (!user || !(await compare(currentPassword || '', user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect.');
    }
    user.passwordHash = await hash(newPassword, 12);
    await user.save();
    return { changed: true };
  }

  async updatePreferences(userId: string, payload: { preferredCurrency?: PreferredCurrency }) {
    const preferredCurrency = this.normalizePreferredCurrency(payload.preferredCurrency);
    const user = await this.userModel
      .findByIdAndUpdate(userId, { preferredCurrency }, { new: true, projection: { passwordHash: 0 } })
      .lean()
      .exec();
    if (!user) throw new UnauthorizedException('User is unavailable.');
    return {
      id: String(user._id),
      _id: String(user._id),
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      preferredCurrency: user.preferredCurrency || 'USD',
    };
  }

  private normalizePreferredCurrency(currency?: PreferredCurrency): PreferredCurrency {
    return ['USD', 'INR', 'GBP', 'EUR'].includes(currency || '') ? currency! : 'USD';
  }

  private jwtSecret() {
    return process.env.JWT_SECRET || 'xtract-local-dev-secret-change-me-32';
  }
}
