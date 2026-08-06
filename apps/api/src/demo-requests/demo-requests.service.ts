import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DemoRequest, DemoRequestDocument } from '../schemas/demo-request.schema';
import { ConfigurationService } from '../configuration/configuration.service';

type DemoRequestPayload = {
  email?: string;
  phone?: string;
  turnstileToken?: string;
  website?: string;
};

@Injectable()
export class DemoRequestsService {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    @InjectModel(DemoRequest.name) private readonly demoRequestModel: Model<DemoRequestDocument>,
    private readonly configurationService: ConfigurationService,
  ) {}

  async publicSettings() {
    return this.configurationService.getDemoRequestSettings();
  }

  async create(payload: DemoRequestPayload, clientIp: string) {
    this.enforceRateLimit(clientIp);
    this.validateFields(payload);
    if (payload.website?.trim()) return { accepted: true };

    const email = payload.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required.');
    }
    const phone = payload.phone?.trim();
    if (phone && !/^[+()\-\s.0-9]{3,32}$/.test(phone)) {
      throw new BadRequestException('Enter a valid phone number.');
    }

    const config: any = await this.configurationService.get();
    if (config.turnstileEnabled) await this.verifyTurnstile(payload.turnstileToken, config, clientIp);

    const duplicateSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const duplicate = await this.demoRequestModel.exists({ email, createdAt: { $gte: duplicateSince } });
    if (duplicate) return { accepted: true };

    await this.demoRequestModel.create({
      email,
      phone: phone || undefined,
      source: 'xtractor-marketing-site',
    });
    return { accepted: true };
  }

  async list() {
    return this.demoRequestModel.find().sort({ createdAt: -1 }).limit(250).lean().exec();
  }

  private validateFields(payload: DemoRequestPayload) {
    const allowedFields = new Set(['email', 'phone', 'turnstileToken', 'website']);
    if (Object.keys(payload || {}).some((field) => !allowedFields.has(field))) {
      throw new BadRequestException('The request contains unsupported fields.');
    }
    if ((payload.email?.length || 0) > 254) throw new BadRequestException('Email is too long.');
    if ((payload.phone?.length || 0) > 32) throw new BadRequestException('Phone number is too long.');
    if ((payload.turnstileToken?.length || 0) > 2048) throw new BadRequestException('Verification token is invalid.');
    if ((payload.website?.length || 0) > 200) throw new BadRequestException('The request is invalid.');
  }

  private enforceRateLimit(clientIp: string) {
    const now = Date.now();
    const windowStart = now - 10 * 60 * 1000;
    const recent = (this.attempts.get(clientIp) || []).filter((timestamp) => timestamp > windowStart);
    if (recent.length >= 5) {
      throw new HttpException('Too many demo requests. Please try again later.', 429);
    }
    recent.push(now);
    this.attempts.set(clientIp, recent);
    if (this.attempts.size > 10000) {
      for (const [ip, timestamps] of this.attempts) {
        if (!timestamps.some((timestamp) => timestamp > windowStart)) this.attempts.delete(ip);
      }
    }
  }

  private async verifyTurnstile(token: string | undefined, config: any, clientIp: string) {
    if (!token || !config.turnstileSecretKey || !config.turnstileSiteKey) {
      throw new ServiceUnavailableException('Demo verification is temporarily unavailable. Please try again later.');
    }
    const body = new URLSearchParams({
      secret: config.turnstileSecretKey,
      response: token,
      remoteip: clientIp,
    });
    let response: Response;
    try {
      response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new ServiceUnavailableException('Demo verification is temporarily unavailable. Please try again later.');
    }
    if (!response.ok) {
      throw new ServiceUnavailableException('Demo verification is temporarily unavailable. Please try again later.');
    }
    const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
    const expectedHostname = config.turnstileExpectedHostname?.trim().toLowerCase();
    const expectedAction = config.turnstileExpectedAction?.trim();
    if (!result.success
      || (expectedHostname && result.hostname?.toLowerCase() !== expectedHostname)
      || (expectedAction && result.action !== expectedAction)) {
      throw new BadRequestException('Verification failed. Please refresh and try again.');
    }
  }
}
