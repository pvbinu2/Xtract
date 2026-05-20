import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DownstreamRequest, DownstreamRequestDocument } from '../schemas/downstream-request.schema';

@Injectable()
export class DownstreamService {
  constructor(
    @InjectModel(DownstreamRequest.name) private readonly requestModel: Model<DownstreamRequestDocument>,
  ) {}

  async storeRequest(payload: Record<string, unknown>): Promise<DownstreamRequest> {
    const request = new this.requestModel({
      documentId: payload.documentId,
      fileName: payload.fileName,
      category: payload.category,
      status: payload.status,
      extractedData: payload.extractedData,
      payload,
    });
    return request.save();
  }

  async getRequests(limit: number = 100): Promise<DownstreamRequest[]> {
    return this.requestModel
      .find()
      .sort({ receivedAt: -1 })
      .limit(limit)
      .lean()
      .exec();
  }

  async getRequest(id: string): Promise<DownstreamRequest | null> {
    return this.requestModel.findById(id).lean().exec();
  }

  async deleteRequest(id: string): Promise<void> {
    await this.requestModel.findByIdAndDelete(id).exec();
  }

  async clearAll(): Promise<void> {
    await this.requestModel.deleteMany({}).exec();
  }

  async count(): Promise<number> {
    return this.requestModel.countDocuments().exec();
  }
}
