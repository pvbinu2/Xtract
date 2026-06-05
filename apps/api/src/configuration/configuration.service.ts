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
    const defaults = {
      downstreamUrl: '',
      deleteAfterDownstream: false,
      sendKeyValuePairs: false,
      useOcrForDocumentProcessing: false,
      documentTextMode: 'ocr',
      markdownServiceUrl: process.env.DOCLING_MARKDOWN_SERVICE_URL || '',
      classificationModel: 'gpt-5-nano',
      classificationReasoningEffort: 'low',
    };
    return {
      ...defaults,
      ...config,
      documentTextMode: config?.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
      markdownServiceUrl: config?.markdownServiceUrl || '',
      classificationModel: config?.classificationModel || defaults.classificationModel,
      classificationReasoningEffort: config?.classificationReasoningEffort || defaults.classificationReasoningEffort,
    } as Configuration;
  }

  async save(config: {
    downstreamUrl: string;
    deleteAfterDownstream: boolean;
    sendKeyValuePairs?: boolean;
    useOcrForDocumentProcessing?: boolean;
    documentTextMode?: 'ocr' | 'markdown';
    markdownServiceUrl?: string;
    classificationModel?: string;
    classificationReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  }): Promise<Configuration> {
    const documentTextMode = config.documentTextMode === 'markdown' ? 'markdown' : 'ocr';
    const updated = await this.configModel
      .findOneAndUpdate(
        {},
        {
          ...config,
          sendKeyValuePairs: Boolean(config.sendKeyValuePairs),
          useOcrForDocumentProcessing: Boolean(config.useOcrForDocumentProcessing),
          documentTextMode,
          markdownServiceUrl: config.markdownServiceUrl || '',
          classificationModel: config.classificationModel || 'gpt-5-nano',
          classificationReasoningEffort: config.classificationReasoningEffort || 'low',
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
