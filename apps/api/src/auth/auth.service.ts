import { BadRequestException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { compare, hash } from 'bcryptjs';
import { sign, verify } from 'jsonwebtoken';
import { Model } from 'mongoose';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { decryptSecret, encryptSecret } from '@xtract/common';
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
      ? await this.userModel.findOne({ username: normalizedUsername }).select('+encryptedTwoFactorSecret').exec()
      : null;
    if (!user || !user.enabled || !(await compare(password || '', user.passwordHash))) {
      throw new UnauthorizedException('Invalid username or password.');
    }

    const profile = this.profile(user);

    if (user.twoFactorEnabled && user.encryptedTwoFactorSecret) {
      return {
        requiresTwoFactor: true,
        twoFactorToken: sign(
          { sub: profile.id, purpose: 'two-factor-login' },
          this.jwtSecret(),
          { expiresIn: '5m' },
        ),
      };
    }

    return {
      requiresTwoFactorSetup: true,
      twoFactorSetupToken: sign(
        { sub: profile.id, purpose: 'two-factor-setup' },
        this.jwtSecret(),
        { expiresIn: '10m' },
      ),
    };
  }

  async verifyTwoFactorLogin(twoFactorToken: string, code: string) {
    let payload: { sub?: string; purpose?: string };
    try {
      payload = verify(twoFactorToken || '', this.jwtSecret()) as { sub?: string; purpose?: string };
    } catch {
      throw new UnauthorizedException('Two-factor verification expired. Please sign in again.');
    }
    if (!payload.sub || payload.purpose !== 'two-factor-login') {
      throw new UnauthorizedException('Invalid two-factor verification request.');
    }
    const user = await this.userModel.findById(payload.sub).select('+encryptedTwoFactorSecret').exec();
    if (!user || !user.enabled || !user.twoFactorEnabled || !user.encryptedTwoFactorSecret) {
      throw new UnauthorizedException('Two-factor authentication is unavailable.');
    }
    if (!authenticator.check(this.normalizeCode(code), decryptSecret(user.encryptedTwoFactorSecret))) {
      throw new UnauthorizedException('Invalid authentication code.');
    }
    return this.createSession(this.profile(user));
  }

  async beginRequiredTwoFactorSetup(twoFactorSetupToken: string) {
    const user = await this.userFromSetupToken(twoFactorSetupToken);
    return this.createTwoFactorSetup(user);
  }

  async completeRequiredTwoFactorSetup(twoFactorSetupToken: string, secret: string, code: string) {
    const user = await this.userFromSetupToken(twoFactorSetupToken);
    await this.storeTwoFactorSecret(user, secret, code);
    return this.createSession(this.profile(user));
  }

  async beginTwoFactorSetup(userId: string) {
    const user = await this.userModel.findById(userId).exec();
    if (!user || !user.enabled) throw new UnauthorizedException('User is unavailable.');
    return this.createTwoFactorSetup(user);
  }

  private async createTwoFactorSetup(user: UserDocument) {
    const secret = authenticator.generateSecret();
    const uri = authenticator.keyuri(user.username, 'Xtract', secret);
    return {
      secret,
      qrCodeDataUrl: await QRCode.toDataURL(uri, { width: 240, margin: 1 }),
    };
  }

  async enableTwoFactor(userId: string, secret: string, code: string) {
    const user = await this.userModel.findById(userId).exec();
    if (!user) throw new UnauthorizedException('User is unavailable.');
    await this.storeTwoFactorSecret(user, secret, code);
    return { enabled: true };
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
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
    };
  }

  private profile(user: UserDocument | any) {
    return {
      id: String(user._id),
      username: user.username,
      role: user.role,
      enabled: user.enabled,
      preferredCurrency: user.preferredCurrency || 'USD',
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
    };
  }

  private createSession(profile: ReturnType<AuthService['profile']>) {
    return {
      user: profile,
      token: sign(
        { sub: profile.id, username: profile.username, role: profile.role, twoFactorVerified: true },
        this.jwtSecret(),
        { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
      ),
    };
  }

  private normalizeCode(code: string) {
    return String(code || '').replace(/\s/g, '');
  }

  private async userFromSetupToken(twoFactorSetupToken: string) {
    let payload: { sub?: string; purpose?: string };
    try {
      payload = verify(twoFactorSetupToken || '', this.jwtSecret()) as { sub?: string; purpose?: string };
    } catch {
      throw new UnauthorizedException('Two-factor setup expired. Please sign in again.');
    }
    if (!payload.sub || payload.purpose !== 'two-factor-setup') {
      throw new UnauthorizedException('Invalid two-factor setup request.');
    }
    const user = await this.userModel.findById(payload.sub).exec();
    if (!user || !user.enabled || user.twoFactorEnabled) {
      throw new UnauthorizedException('Two-factor setup is unavailable.');
    }
    return user;
  }

  private async storeTwoFactorSecret(user: UserDocument, secret: string, code: string) {
    if (!secret || !authenticator.check(this.normalizeCode(code), secret)) {
      throw new BadRequestException('Invalid authentication code. Check your authenticator app and try again.');
    }
    user.twoFactorEnabled = true;
    user.encryptedTwoFactorSecret = encryptSecret(secret);
    await user.save();
  }

  private normalizePreferredCurrency(currency?: PreferredCurrency): PreferredCurrency {
    return ['USD', 'INR', 'GBP', 'EUR'].includes(currency || '') ? currency! : 'USD';
  }

  private jwtSecret() {
    return process.env.JWT_SECRET || 'xtract-local-dev-secret-change-me-32';
  }
}
