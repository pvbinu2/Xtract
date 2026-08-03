import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { decryptSecret, encryptSecret } from '@xtract/common';
import { Configuration, ConfigurationDocument } from '../schemas/configuration.schema';

@Injectable()
export class ConfigurationService {
  constructor(
    @InjectModel(Configuration.name) private readonly configModel: Model<ConfigurationDocument>,
  ) {}

  private normalize(config: any = {}) {
    const defaults = {
      downstreamUrl: '',
      deleteAfterDownstream: false,
      sendKeyValuePairs: false,
      useOcrForDocumentProcessing: false,
      documentTextMode: 'ocr',
      markdownServiceUrl: process.env.DOCLING_MARKDOWN_SERVICE_URL || '',
      aiProvider: 'openai',
      llmEndpoint: '',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'llama3.2',
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      ollamaEmbeddingModel: 'qwen3-embedding:4b',
      classificationModel: 'gpt-5-nano',
      classificationReasoningEffort: 'low',
      classificationMode: 'vector',
      classificationRagTopK: 5,
      preprocessingConcurrency: 4,
      vectorClassificationConcurrency: 4,
      llmClassificationConcurrency: 1,
      extractionConcurrency: 1,
    };
    return {
      ...defaults,
      ...config,
      documentTextMode: config?.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
      markdownServiceUrl: config?.markdownServiceUrl || '',
      aiProvider: ['openai', 'custom', 'ollama'].includes(config?.aiProvider) ? config.aiProvider : 'openai',
      llmEndpoint: config?.llmEndpoint || '',
      ollamaBaseUrl: config?.ollamaBaseUrl || defaults.ollamaBaseUrl,
      ollamaModel: config?.ollamaModel || defaults.ollamaModel,
      embeddingProvider: config?.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
      embeddingModel: config?.embeddingModel || defaults.embeddingModel,
      ollamaEmbeddingModel: config?.ollamaEmbeddingModel || defaults.ollamaEmbeddingModel,
      classificationModel: config?.classificationModel || defaults.classificationModel,
      classificationReasoningEffort: config?.classificationReasoningEffort || defaults.classificationReasoningEffort,
      classificationMode: ['vector', 'llm', 'rag'].includes(config?.classificationMode || '')
        ? config?.classificationMode
        : defaults.classificationMode,
      classificationRagTopK: Math.min(50, Math.max(1, Number(config?.classificationRagTopK) || defaults.classificationRagTopK)),
      preprocessingConcurrency: Math.min(16, Math.max(1, Number(config?.preprocessingConcurrency) || defaults.preprocessingConcurrency)),
      vectorClassificationConcurrency: Math.min(16, Math.max(1, Number(config?.vectorClassificationConcurrency) || defaults.vectorClassificationConcurrency)),
      llmClassificationConcurrency: Math.min(16, Math.max(1, Number(config?.llmClassificationConcurrency) || defaults.llmClassificationConcurrency)),
      extractionConcurrency: Math.min(16, Math.max(1, Number(config?.extractionConcurrency) || defaults.extractionConcurrency)),
    };
  }

  async get(): Promise<Configuration> {
    const config: any = await this.configModel
      .findOne()
      .select('+encryptedApiKey +encryptedOpenAiApiKey +encryptedCustomApiKey')
      .lean()
      .exec();
    const normalized: any = this.normalize(config);
    const legacyKey = config?.encryptedApiKey ? decryptSecret(config.encryptedApiKey) : '';
    const openAiApiKey = config?.encryptedOpenAiApiKey
      ? decryptSecret(config.encryptedOpenAiApiKey)
      : config?.aiProvider === 'openai' ? legacyKey : '';
    const customApiKey = config?.encryptedCustomApiKey
      ? decryptSecret(config.encryptedCustomApiKey)
      : config?.aiProvider === 'custom' ? legacyKey : '';
    return {
      ...normalized,
      openAiApiKey,
      customApiKey,
      apiKey: normalized.aiProvider === 'custom' ? customApiKey : openAiApiKey,
      openAiApiKeyConfigured: Boolean(openAiApiKey),
      customApiKeyConfigured: Boolean(customApiKey),
      encryptedApiKey: undefined,
      encryptedOpenAiApiKey: undefined,
      encryptedCustomApiKey: undefined,
    } as Configuration;
  }

  async getPublic(): Promise<Configuration> {
    const runtime: any = await this.get();
    const { apiKey, openAiApiKey, customApiKey, ...publicConfig } = runtime;
    return {
      ...publicConfig,
      apiKey: '',
      openAiApiKey: '',
      customApiKey: '',
      apiKeyConfigured: runtime.aiProvider === 'custom'
        ? Boolean(runtime.customApiKeyConfigured)
        : Boolean(runtime.openAiApiKeyConfigured),
    } as Configuration;
  }

  async save(config: {
    downstreamUrl: string;
    deleteAfterDownstream: boolean;
    sendKeyValuePairs?: boolean;
    useOcrForDocumentProcessing?: boolean;
    documentTextMode?: 'ocr' | 'markdown';
    markdownServiceUrl?: string;
    aiProvider?: 'openai' | 'custom' | 'ollama';
    llmEndpoint?: string;
    apiKey?: string;
    openAiApiKey?: string;
    customApiKey?: string;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
    embeddingProvider?: 'openai' | 'ollama';
    embeddingModel?: string;
    ollamaEmbeddingModel?: string;
    classificationModel?: string;
    classificationReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    classificationMode?: 'vector' | 'llm' | 'rag';
    classificationRagTopK?: number;
    preprocessingConcurrency?: number;
    vectorClassificationConcurrency?: number;
    llmClassificationConcurrency?: number;
    extractionConcurrency?: number;
  }): Promise<Configuration> {
    const documentTextMode = config.documentTextMode === 'markdown' ? 'markdown' : 'ocr';
    const aiProvider = ['openai', 'custom', 'ollama'].includes(config.aiProvider || '')
      ? config.aiProvider
      : 'openai';
    const embeddingProvider = config.embeddingProvider === 'ollama' ? 'ollama' : 'openai';
    const classificationMode = ['vector', 'llm', 'rag'].includes(config.classificationMode || '')
      ? config.classificationMode
      : 'vector';
    const classificationRagTopK = Math.min(50, Math.max(1, Number(config.classificationRagTopK) || 5));
    const preprocessingConcurrency = Math.min(16, Math.max(1, Number(config.preprocessingConcurrency) || 4));
    const vectorClassificationConcurrency = Math.min(16, Math.max(1, Number(config.vectorClassificationConcurrency) || 4));
    const llmClassificationConcurrency = Math.min(16, Math.max(1, Number(config.llmClassificationConcurrency) || 1));
    const extractionConcurrency = Math.min(16, Math.max(1, Number(config.extractionConcurrency) || 1));
    const existing: any = await this.configModel
      .findOne()
      .select('+encryptedApiKey +encryptedOpenAiApiKey +encryptedCustomApiKey')
      .lean()
      .exec();
    const encryptedOpenAiApiKey = config.openAiApiKey?.trim()
      ? encryptSecret(config.openAiApiKey.trim())
      : existing?.encryptedOpenAiApiKey
        || (existing?.aiProvider === 'openai' ? existing?.encryptedApiKey : '');
    const encryptedCustomApiKey = config.customApiKey?.trim()
      ? encryptSecret(config.customApiKey.trim())
      : existing?.encryptedCustomApiKey
        || (existing?.aiProvider === 'custom' ? existing?.encryptedApiKey : '');
    const {
      apiKey: _plainTextApiKey,
      openAiApiKey: _plainTextOpenAiApiKey,
      customApiKey: _plainTextCustomApiKey,
      ...safeConfig
    } = config;
    await this.configModel
      .findOneAndUpdate(
        {},
        {
          ...safeConfig,
          sendKeyValuePairs: Boolean(config.sendKeyValuePairs),
          useOcrForDocumentProcessing: Boolean(config.useOcrForDocumentProcessing),
          documentTextMode,
          markdownServiceUrl: config.markdownServiceUrl || '',
          aiProvider,
          llmEndpoint: config.llmEndpoint?.trim() || '',
          encryptedOpenAiApiKey,
          encryptedCustomApiKey,
          ollamaBaseUrl: config.ollamaBaseUrl || 'http://127.0.0.1:11434',
          ollamaModel: config.ollamaModel || 'llama3.2',
          embeddingProvider,
          embeddingModel: config.embeddingModel || 'text-embedding-3-small',
          ollamaEmbeddingModel: config.ollamaEmbeddingModel || 'qwen3-embedding:4b',
          classificationModel: config.classificationModel || 'gpt-5-nano',
          classificationReasoningEffort: config.classificationReasoningEffort || 'low',
          classificationMode,
          classificationRagTopK,
          preprocessingConcurrency,
          vectorClassificationConcurrency,
          llmClassificationConcurrency,
          extractionConcurrency,
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        },
      )
      .exec();
    return this.getPublic();
  }
}
