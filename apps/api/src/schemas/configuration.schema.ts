import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ConfigurationDocument = Configuration & Document;
export type AiProvider = 'openai' | 'ollama';
export type ClassificationMode = 'vector' | 'llm' | 'rag';

@Schema({ collection: 'configuration' })
export class Configuration {
  @Prop({ required: true })
  downstreamUrl!: string;

  @Prop({ default: false })
  deleteAfterDownstream!: boolean;

  @Prop({ default: false })
  sendKeyValuePairs!: boolean;

  @Prop({ default: false })
  useOcrForDocumentProcessing!: boolean;

  @Prop({ default: 'ocr' })
  documentTextMode!: 'ocr' | 'markdown';

  @Prop({ default: '' })
  markdownServiceUrl!: string;

  @Prop({ default: 'openai' })
  aiProvider!: AiProvider;

  @Prop({ default: 'http://127.0.0.1:11434' })
  ollamaBaseUrl!: string;

  @Prop({ default: 'llama3.2' })
  ollamaModel!: string;

  @Prop({ default: 'openai' })
  embeddingProvider!: AiProvider;

  @Prop({ default: 'text-embedding-3-small' })
  embeddingModel!: string;

  @Prop({ default: 'qwen3-embedding:4b' })
  ollamaEmbeddingModel!: string;

  @Prop({ default: 'gpt-5-nano' })
  classificationModel!: string;

  @Prop({ default: 'low' })
  classificationReasoningEffort!: 'low' | 'medium' | 'high' | 'xhigh';

  @Prop({ default: 'vector' })
  classificationMode!: ClassificationMode;

  @Prop({ default: 5, min: 1, max: 50 })
  classificationRagTopK!: number;
}

export const ConfigurationSchema = SchemaFactory.createForClass(Configuration);
