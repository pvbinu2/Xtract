import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigurationService } from './configuration.service';
import { Configuration } from '../schemas/configuration.schema';
import { Roles } from '../auth/auth.decorators';

@Controller('configuration')
@Roles('admin')
export class ConfigurationController {
  constructor(private readonly configurationService: ConfigurationService) {}

  @Get()
  async getConfiguration(): Promise<Configuration> {
    return this.configurationService.getPublic();
  }

  @Post()
  async saveConfiguration(
    @Body()
    body: {
      storageEncryptionEnabled?: boolean;
      databaseEncryptionEnabled?: boolean;
      cachingEnabled?: boolean;
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
    },
  ): Promise<Configuration> {
    return this.configurationService.save(body);
  }
}
