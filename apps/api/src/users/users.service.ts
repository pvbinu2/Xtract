import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { hash } from 'bcryptjs';
import { Model } from 'mongoose';
import { User, UserDocument, UserRole } from '../schemas/user.schema';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  list() {
    return this.userModel
      .find({}, { passwordHash: 0 })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async create(payload: { username?: string; password?: string; role?: UserRole; enabled?: boolean }) {
    const username = payload.username?.trim().toLowerCase();
    if (!username) throw new BadRequestException('Username is required.');
    if (!payload.password || payload.password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters.');
    }
    const role = this.normalizeRole(payload.role);
    try {
      const user = await this.userModel.create({
        username,
        passwordHash: await hash(payload.password, 12),
        role,
        enabled: payload.enabled !== false,
      });
      const saved = user.toObject();
      delete saved.passwordHash;
      return saved;
    } catch (error: any) {
      if (error?.code === 11000) throw new BadRequestException('Username already exists.');
      throw error;
    }
  }

  async update(id: string, payload: { role?: UserRole; enabled?: boolean }) {
    const updates: Partial<User> = {};
    if (payload.role) updates.role = this.normalizeRole(payload.role);
    if (typeof payload.enabled === 'boolean') updates.enabled = payload.enabled;
    const user = await this.userModel
      .findByIdAndUpdate(id, updates, { new: true, projection: { passwordHash: 0 } })
      .lean()
      .exec();
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  async resetPassword(id: string, password?: string) {
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters.');
    }
    const user = await this.userModel
      .findByIdAndUpdate(id, { passwordHash: await hash(password, 12) }, { new: true, projection: { passwordHash: 0 } })
      .lean()
      .exec();
    if (!user) throw new NotFoundException('User not found.');
    return user;
  }

  async remove(id: string) {
    const deleted = await this.userModel.findByIdAndDelete(id).lean().exec();
    if (!deleted) throw new NotFoundException('User not found.');
    return { deleted: true };
  }

  private normalizeRole(role?: UserRole): UserRole {
    return role === 'admin' ? 'admin' : 'validator';
  }
}
