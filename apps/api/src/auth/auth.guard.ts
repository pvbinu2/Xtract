import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { Request } from 'express';
import { verify } from 'jsonwebtoken';
import { Model, Types } from 'mongoose';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';
import { User, UserDocument, UserRole } from '../schemas/user.schema';

export type AuthenticatedRequest = Request & {
  user?: {
    id: string;
    username: string;
    role: UserRole;
  };
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.tokenFromRequest(request);
    if (!token) throw new UnauthorizedException('Login is required.');

    let payload: { sub?: string; username?: string; role?: UserRole };
    try {
      payload = verify(token, this.jwtSecret()) as { sub?: string; username?: string; role?: UserRole };
    } catch {
      throw new UnauthorizedException('Session expired. Please log in again.');
    }

    if (!payload.sub || !Types.ObjectId.isValid(payload.sub)) {
      throw new UnauthorizedException('Invalid session.');
    }

    const user = await this.userModel.findById(payload.sub).lean().exec();
    if (!user || !user.enabled) {
      throw new UnauthorizedException('User is disabled or unavailable.');
    }

    request.user = {
      id: String(user._id),
      username: user.username,
      role: user.role,
    };

    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenException('You do not have access to this action.');
    }

    return true;
  }

  private tokenFromRequest(request: Request) {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
    const queryToken = request.query.access_token;
    return typeof queryToken === 'string' ? queryToken : '';
  }

  private jwtSecret() {
    return process.env.JWT_SECRET || 'xtract-local-dev-secret';
  }
}
