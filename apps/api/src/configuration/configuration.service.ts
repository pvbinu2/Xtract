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
    return config || {
      downstreamUrl: '',
      deleteAfterDownstream: false,
      sendKeyValuePairs: false,
      useOcrForDocumentProcessing: false,
    };
  }

  async save(config: {
    downstreamUrl: string;
    deleteAfterDownstream: boolean;
    sendKeyValuePairs?: boolean;
    useOcrForDocumentProcessing?: boolean;
  }): Promise<Configuration> {
    const updated = await this.configModel
      .findOneAndUpdate(
        {},
        {
          ...config,
          sendKeyValuePairs: Boolean(config.sendKeyValuePairs),
          useOcrForDocumentProcessing: Boolean(config.useOcrForDocumentProcessing),
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .lean()
      .exec();
    return updated;
  }
}
