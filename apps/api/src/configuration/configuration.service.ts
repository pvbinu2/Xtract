import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigurationCache, decryptSecret, encryptSecret, generateDataEncryptionKey } from '@xtract/common';
import { Configuration, ConfigurationDocument } from '../schemas/configuration.schema';

@Injectable()
export class ConfigurationService {
  private readonly cache: ConfigurationCache<any>;

  constructor(
    @InjectModel(Configuration.name) private readonly configModel: Model<ConfigurationDocument>,
  ) {
    this.cache = new ConfigurationCache({ loader: () => this.loadRaw() });
  }

  private loadRaw() {
    return this.configModel
      .findOne()
      .select('+encryptedApiKey +encryptedOpenAiApiKey +encryptedCustomApiKey +encryptedVectorDatabaseApiKey +encryptedTurnstileSecretKey +encryptedStorageDataKey +encryptedDatabaseDataKey')
      .lean()
      .exec()
      .then((config) => config || {});
  }

  private normalize(config: any = {}) {
    const defaults = {
      storageEncryptionEnabled: false,
      databaseEncryptionEnabled: false,
      storageEncryptionKeyVersion: 1,
      databaseEncryptionKeyVersion: 1,
      cachingEnabled: true,
      configurationCacheTtlSeconds: 30,
      turnstileEnabled: false,
      turnstileSiteKey: '',
      turnstileExpectedHostname: '',
      turnstileExpectedAction: 'request-demo',
      downstreamUrl: '',
      deleteAfterDownstream: false,
      sendKeyValuePairs: false,
      useOcrForDocumentProcessing: false,
      documentIngestionTrigger: 'event-grid',
      documentTextMode: 'ocr',
      markdownServiceUrl: process.env.DOCLING_MARKDOWN_SERVICE_URL || '',
      aiProvider: 'openai',
      llmEndpoint: '',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'llama3.2',
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      ollamaEmbeddingModel: 'qwen3-embedding:4b',
      vectorDatabaseProvider: 'qdrant',
      vectorDatabaseEndpoint: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
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
      storageEncryptionEnabled: Boolean(config?.storageEncryptionEnabled),
      databaseEncryptionEnabled: Boolean(config?.databaseEncryptionEnabled),
      cachingEnabled: config?.cachingEnabled !== false,
      configurationCacheTtlSeconds: Math.min(86400, Math.max(1, Number(config?.configurationCacheTtlSeconds) || 30)),
      turnstileEnabled: Boolean(config?.turnstileEnabled),
      turnstileSiteKey: config?.turnstileSiteKey?.trim() || '',
      turnstileExpectedHostname: config?.turnstileExpectedHostname?.trim().toLowerCase() || '',
      turnstileExpectedAction: config?.turnstileExpectedAction?.trim() || 'request-demo',
      documentTextMode: config?.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
      documentIngestionTrigger: config?.documentIngestionTrigger === 'blob' ? 'blob' : 'event-grid',
      markdownServiceUrl: config?.markdownServiceUrl || '',
      aiProvider: ['openai', 'custom', 'ollama'].includes(config?.aiProvider) ? config.aiProvider : 'openai',
      llmEndpoint: config?.llmEndpoint || '',
      ollamaBaseUrl: config?.ollamaBaseUrl || defaults.ollamaBaseUrl,
      ollamaModel: config?.ollamaModel || defaults.ollamaModel,
      embeddingProvider: config?.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
      embeddingModel: config?.embeddingModel || defaults.embeddingModel,
      ollamaEmbeddingModel: config?.ollamaEmbeddingModel || defaults.ollamaEmbeddingModel,
      vectorDatabaseProvider: config?.vectorDatabaseProvider?.trim() || defaults.vectorDatabaseProvider,
      vectorDatabaseEndpoint: config?.vectorDatabaseEndpoint?.trim() || defaults.vectorDatabaseEndpoint,
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
    const config: any = await this.cache.get();
    const normalized: any = this.normalize(config);
    const legacyKey = config?.encryptedApiKey ? decryptSecret(config.encryptedApiKey) : '';
    const openAiApiKey = config?.encryptedOpenAiApiKey
      ? decryptSecret(config.encryptedOpenAiApiKey)
      : config?.aiProvider === 'openai' ? legacyKey : '';
    const customApiKey = config?.encryptedCustomApiKey
      ? decryptSecret(config.encryptedCustomApiKey)
      : config?.aiProvider === 'custom' ? legacyKey : '';
    const vectorDatabaseApiKey = config?.encryptedVectorDatabaseApiKey
      ? decryptSecret(config.encryptedVectorDatabaseApiKey)
      : process.env.QDRANT_API_KEY || '';
    const turnstileSecretKey = config?.encryptedTurnstileSecretKey
      ? decryptSecret(config.encryptedTurnstileSecretKey)
      : '';
    const storageDataEncryptionKey = config?.encryptedStorageDataKey ? decryptSecret(config.encryptedStorageDataKey) : '';
    const databaseDataEncryptionKey = config?.encryptedDatabaseDataKey ? decryptSecret(config.encryptedDatabaseDataKey) : '';
    return {
      ...normalized,
      openAiApiKey,
      customApiKey,
      vectorDatabaseApiKey,
      vectorDatabaseApiKeyConfigured: Boolean(vectorDatabaseApiKey),
      turnstileSecretKey,
      turnstileSecretKeyConfigured: Boolean(turnstileSecretKey),
      storageDataEncryptionKey,
      databaseDataEncryptionKey,
      storageEncryptionKeyConfigured: Boolean(storageDataEncryptionKey),
      databaseEncryptionKeyConfigured: Boolean(databaseDataEncryptionKey),
      apiKey: normalized.aiProvider === 'custom' ? customApiKey : openAiApiKey,
      openAiApiKeyConfigured: Boolean(openAiApiKey),
      customApiKeyConfigured: Boolean(customApiKey),
      encryptedApiKey: undefined,
      encryptedOpenAiApiKey: undefined,
      encryptedCustomApiKey: undefined,
      encryptedVectorDatabaseApiKey: undefined,
      encryptedTurnstileSecretKey: undefined,
      encryptedStorageDataKey: undefined,
      encryptedDatabaseDataKey: undefined,
    } as Configuration;
  }

  async getPublic(): Promise<Configuration> {
    const runtime: any = await this.get();
    const { apiKey, openAiApiKey, customApiKey, vectorDatabaseApiKey, turnstileSecretKey, storageDataEncryptionKey, databaseDataEncryptionKey, ...publicConfig } = runtime;
    return {
      ...publicConfig,
      apiKey: '',
      openAiApiKey: '',
      customApiKey: '',
      vectorDatabaseApiKey: '',
      turnstileSecretKey: '',
      apiKeyConfigured: runtime.aiProvider === 'custom'
        ? Boolean(runtime.customApiKeyConfigured)
        : Boolean(runtime.openAiApiKeyConfigured),
    } as Configuration;
  }

  async save(config: {
    cachingEnabled?: boolean;
    storageEncryptionEnabled?: boolean;
    databaseEncryptionEnabled?: boolean;
    configurationCacheTtlSeconds?: number;
    turnstileEnabled?: boolean;
    turnstileSiteKey?: string;
    turnstileSecretKey?: string;
    turnstileExpectedHostname?: string;
    turnstileExpectedAction?: string;
    downstreamUrl: string;
    deleteAfterDownstream: boolean;
    sendKeyValuePairs?: boolean;
    useOcrForDocumentProcessing?: boolean;
    documentIngestionTrigger?: 'event-grid' | 'blob';
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
    vectorDatabaseProvider?: string;
    vectorDatabaseEndpoint?: string;
    vectorDatabaseApiKey?: string;
    classificationModel?: string;
    classificationReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    classificationMode?: 'vector' | 'llm' | 'rag';
    classificationRagTopK?: number;
    preprocessingConcurrency?: number;
    vectorClassificationConcurrency?: number;
    llmClassificationConcurrency?: number;
    extractionConcurrency?: number;
  }): Promise<Configuration> {
    const cachingEnabled = config.cachingEnabled !== false;
    const configurationCacheTtlSeconds = Math.min(86400, Math.max(1, Number(config.configurationCacheTtlSeconds) || 30));
    const turnstileEnabled = Boolean(config.turnstileEnabled);
    const turnstileSiteKey = config.turnstileSiteKey?.trim() || '';
    const turnstileExpectedHostname = config.turnstileExpectedHostname?.trim().toLowerCase() || '';
    const turnstileExpectedAction = config.turnstileExpectedAction?.trim() || 'request-demo';
    const documentTextMode = config.documentTextMode === 'markdown' ? 'markdown' : 'ocr';
    const documentIngestionTrigger = config.documentIngestionTrigger === 'blob' ? 'blob' : 'event-grid';
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
    const vectorDatabaseProvider = config.vectorDatabaseProvider?.trim() || 'qdrant';
    const vectorDatabaseEndpoint = (config.vectorDatabaseEndpoint?.trim() || process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
    const existing: any = await this.configModel
      .findOne()
      .select('+encryptedApiKey +encryptedOpenAiApiKey +encryptedCustomApiKey +encryptedVectorDatabaseApiKey +encryptedTurnstileSecretKey +encryptedStorageDataKey +encryptedDatabaseDataKey')
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
    const encryptedTurnstileSecretKey = config.turnstileSecretKey?.trim()
      ? encryptSecret(config.turnstileSecretKey.trim())
      : existing?.encryptedTurnstileSecretKey || '';
    const encryptedVectorDatabaseApiKey = config.vectorDatabaseApiKey?.trim()
      ? encryptSecret(config.vectorDatabaseApiKey.trim())
      : existing?.encryptedVectorDatabaseApiKey || '';
    let encryptedStorageDataKey = existing?.encryptedStorageDataKey || '';
    let encryptedDatabaseDataKey = existing?.encryptedDatabaseDataKey || '';
    try {
      if ((config.storageEncryptionEnabled || config.databaseEncryptionEnabled) && !process.env.CONFIG_ENCRYPTION_KEY) {
        throw new Error('master key missing');
      }
      if (config.storageEncryptionEnabled && !encryptedStorageDataKey) encryptedStorageDataKey = encryptSecret(generateDataEncryptionKey());
      if (config.databaseEncryptionEnabled && !encryptedDatabaseDataKey) encryptedDatabaseDataKey = encryptSecret(generateDataEncryptionKey());
      if (config.storageEncryptionEnabled && encryptedStorageDataKey) decryptSecret(encryptedStorageDataKey);
      if (config.databaseEncryptionEnabled && encryptedDatabaseDataKey) decryptSecret(encryptedDatabaseDataKey);
    } catch {
      throw new BadRequestException('CONFIG_ENCRYPTION_KEY must be configured before application-level encryption can be enabled.');
    }
    if (turnstileSiteKey.length > 64 || (config.turnstileSecretKey?.trim().length || 0) > 128) {
      throw new BadRequestException('Turnstile credentials are too long.');
    }
    if (turnstileExpectedHostname.length > 253 || (turnstileExpectedHostname && !/^[a-z0-9.-]+$/.test(turnstileExpectedHostname))) {
      throw new BadRequestException('Enter a valid Turnstile hostname without a protocol or path.');
    }
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(turnstileExpectedAction)) {
      throw new BadRequestException('Turnstile action must contain only letters, numbers, hyphens, or underscores.');
    }
    if (turnstileEnabled && (!turnstileSiteKey || !encryptedTurnstileSecretKey || !turnstileExpectedHostname)) {
      throw new BadRequestException('Site key, secret key, and expected hostname are required when Turnstile is enabled.');
    }
    const {
      apiKey: _plainTextApiKey,
      openAiApiKey: _plainTextOpenAiApiKey,
      customApiKey: _plainTextCustomApiKey,
      vectorDatabaseApiKey: _plainTextVectorDatabaseApiKey,
      turnstileSecretKey: _plainTextTurnstileSecretKey,
      ...safeConfig
    } = config;
    const updated: any = await this.configModel
      .findOneAndUpdate(
        {},
        {
          ...safeConfig,
          cachingEnabled,
          configurationCacheTtlSeconds,
          turnstileEnabled,
          turnstileSiteKey,
          turnstileExpectedHostname,
          turnstileExpectedAction,
          encryptedTurnstileSecretKey,
          storageEncryptionEnabled: Boolean(config.storageEncryptionEnabled),
          databaseEncryptionEnabled: Boolean(config.databaseEncryptionEnabled),
          encryptedStorageDataKey,
          encryptedDatabaseDataKey,
          storageEncryptionKeyVersion: Number(existing?.storageEncryptionKeyVersion) || 1,
          databaseEncryptionKeyVersion: Number(existing?.databaseEncryptionKeyVersion) || 1,
          sendKeyValuePairs: Boolean(config.sendKeyValuePairs),
          useOcrForDocumentProcessing: Boolean(config.useOcrForDocumentProcessing),
          documentIngestionTrigger,
          documentTextMode,
          markdownServiceUrl: config.markdownServiceUrl || '',
          aiProvider,
          llmEndpoint: config.llmEndpoint?.trim() || '',
          encryptedOpenAiApiKey,
          encryptedCustomApiKey,
          vectorDatabaseProvider,
          vectorDatabaseEndpoint,
          encryptedVectorDatabaseApiKey,
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
      .select('+encryptedApiKey +encryptedOpenAiApiKey +encryptedCustomApiKey +encryptedVectorDatabaseApiKey +encryptedTurnstileSecretKey +encryptedStorageDataKey +encryptedDatabaseDataKey')
      .lean()
      .exec();
    this.cache.replace(updated || {});
    return this.getPublic();
  }

  async getDemoRequestSettings() {
    const config: any = await this.get();
    return {
      turnstileEnabled: Boolean(config.turnstileEnabled),
      turnstileSiteKey: config.turnstileSiteKey || '',
      turnstileAction: config.turnstileExpectedAction || 'request-demo',
    };
  }
}
