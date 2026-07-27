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
      aiProvider: 'openai',
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
      embeddingProvider: 'openai',
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      ollamaEmbeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:4b',
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
      aiProvider: config?.aiProvider === 'ollama' ? 'ollama' : 'openai',
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
    } as Configuration;
  }

  async save(config: {
    downstreamUrl: string;
    deleteAfterDownstream: boolean;
    sendKeyValuePairs?: boolean;
    useOcrForDocumentProcessing?: boolean;
    documentTextMode?: 'ocr' | 'markdown';
    markdownServiceUrl?: string;
    aiProvider?: 'openai' | 'ollama';
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
    const aiProvider = config.aiProvider === 'ollama' ? 'ollama' : 'openai';
    const embeddingProvider = config.embeddingProvider === 'ollama' ? 'ollama' : 'openai';
    const classificationMode = ['vector', 'llm', 'rag'].includes(config.classificationMode || '')
      ? config.classificationMode
      : 'vector';
    const classificationRagTopK = Math.min(50, Math.max(1, Number(config.classificationRagTopK) || 5));
    const preprocessingConcurrency = Math.min(16, Math.max(1, Number(config.preprocessingConcurrency) || 4));
    const vectorClassificationConcurrency = Math.min(16, Math.max(1, Number(config.vectorClassificationConcurrency) || 4));
    const llmClassificationConcurrency = Math.min(16, Math.max(1, Number(config.llmClassificationConcurrency) || 1));
    const extractionConcurrency = Math.min(16, Math.max(1, Number(config.extractionConcurrency) || 1));
    const updated = await this.configModel
      .findOneAndUpdate(
        {},
        {
          ...config,
          sendKeyValuePairs: Boolean(config.sendKeyValuePairs),
          useOcrForDocumentProcessing: Boolean(config.useOcrForDocumentProcessing),
          documentTextMode,
          markdownServiceUrl: config.markdownServiceUrl || '',
          aiProvider,
          ollamaBaseUrl: config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
          ollamaModel: config.ollamaModel || process.env.OLLAMA_MODEL || 'llama3.2',
          embeddingProvider,
          embeddingModel: config.embeddingModel || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
          ollamaEmbeddingModel: config.ollamaEmbeddingModel || process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:4b',
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
      .lean()
      .exec();
    return updated;
  }
}
