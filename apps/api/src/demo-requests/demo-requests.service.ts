import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DemoRequest, DemoRequestDocument } from '../schemas/demo-request.schema';

@Injectable()
export class DemoRequestsService {
  constructor(
    @InjectModel(DemoRequest.name) private readonly demoRequestModel: Model<DemoRequestDocument>,
  ) {}

  async create(payload: { email?: string; phone?: string; source?: string }) {
    const email = payload.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email address is required.');
    }

    return this.demoRequestModel.create({
      email,
      phone: payload.phone?.trim() || undefined,
      source: payload.source?.trim() || 'website',
    });
  }

  async list() {
    return this.demoRequestModel.find().sort({ createdAt: -1 }).limit(250).lean().exec();
  }
}
