import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Configuration, ConfigurationDocument } from '../schemas/configuration.schema';

@Injectable()
export class ConfigurationService {
  constructor(
    @InjectModel(Configuration.name) private readonly configModel: Model<ConfigurationDocument>,
  ) {}

  async get(): Promise<Configuration> {
    const config = await this.configModel.findOne().lean().exec();
    return config || { downstreamUrl: '', deleteAfterDownstream: false };
  }

  async save(config: { downstreamUrl: string; deleteAfterDownstream: boolean }): Promise<Configuration> {
    const updated = await this.configModel
      .findOneAndUpdate({}, config, {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      })
      .lean()
      .exec();
    return updated;
  }
}
