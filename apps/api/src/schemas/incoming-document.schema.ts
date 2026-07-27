import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type IncomingDocumentDocument = HydratedDocument<IncomingDocument>;
export type DocumentStatus =
  | 'received'
  | 'preprocessed'
  | 'classified'
  | 'extracted'
  | 'validated'
  | 'rejected'
  | 'failed'
  | 'uploaded'
  | 'processing';
export type ReprocessOptions = {
  documentTypeId?: string;
  extractionModel?: string;
  useOcrForDocumentProcessing?: boolean;
  documentTextMode?: 'ocr' | 'markdown';
  forceClassification?: boolean;
};

@Schema({ _id: false })
export class BoundingBox {
  @Prop({ required: true })
  page!: number;

  @Prop({ required: true })
  x!: number;

  @Prop({ required: true })
  y!: number;

  @Prop({ required: true })
  width!: number;

  @Prop({ required: true })
  height!: number;
}

const BoundingBoxSchema = SchemaFactory.createForClass(BoundingBox);

@Schema({ _id: false })
export class ExtractedValue {
  @Prop({ required: true })
  key!: string;

  @Prop({ required: true })
  label!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ type: Object })
  value!: unknown;

  @Prop()
  confidence?: number;

  @Prop({ type: [BoundingBoxSchema], default: [] })
  boundingBoxes?: BoundingBox[];
}

const ExtractedValueSchema = SchemaFactory.createForClass(ExtractedValue);

@Schema({ _id: false })
export class ProcessingMetrics {
  @Prop()
  model?: string;

  @Prop({ default: 0 })
  inputTokens?: number;

  @Prop({ default: 0 })
  outputTokens?: number;

  @Prop({ default: 0 })
  totalTokens?: number;

  @Prop({ default: 0 })
  estimatedCostUsd?: number;

  @Prop({ default: 0 })
  extractionCostUsd?: number;

  @Prop({ default: 0 })
  classificationCostUsd?: number;

  @Prop({ default: 0 })
  embeddingCostUsd?: number;

  @Prop()
  processedAt?: Date;
}

const ProcessingMetricsSchema = SchemaFactory.createForClass(ProcessingMetrics);

@Schema({ timestamps: true })
export class IncomingDocument {
  @Prop({ required: true })
  fileName!: string;

  @Prop({ required: true })
  originalName!: string;

  @Prop({ required: true })
  filePath!: string;

  @Prop()
  storageContainer?: string;

  @Prop()
  storageBlobName?: string;

  @Prop()
  textArtifactContainer?: string;

  @Prop()
  textArtifactBlobName?: string;

  @Prop()
  textArtifactMode?: 'ocr' | 'markdown';

  @Prop({ default: 'Unclassified' })
  category!: string;

  @Prop({ type: Types.ObjectId, ref: 'DocumentType' })
  documentTypeId?: Types.ObjectId;

  @Prop({ default: 'Pending classification' })
  documentTypeName!: string;

  @Prop()
  classificationScore?: number;

  @Prop({ default: 'manual' })
  classificationMethod!: 'manual' | 'vector' | 'llm' | 'rag';

  @Prop()
  classificationModel?: string;

  @Prop()
  classificationJustification?: string;

  @Prop({
    type: [{
      documentTypeId: String,
      category: String,
      name: String,
      score: Number,
      _id: false,
    }],
    default: undefined,
  })
  classificationCandidates?: Array<{
    documentTypeId: string;
    category: string;
    name: string;
    score: number;
  }>;

  @Prop()
  processingMode?: 'ocr' | 'pdf' | 'markdown';

  @Prop({ default: 'received' })
  status!: DocumentStatus;

  @Prop({ default: 0 })
  revision!: number;

  @Prop({ type: [ExtractedValueSchema], default: [] })
  extractedData!: ExtractedValue[];

  @Prop({ type: ProcessingMetricsSchema })
  processingMetrics?: ProcessingMetrics;

  @Prop({ type: Object })
  reprocessOptions?: ReprocessOptions;

  @Prop()
  error?: string;
}

export const IncomingDocumentSchema = SchemaFactory.createForClass(IncomingDocument);
IncomingDocumentSchema.index({ createdAt: -1 });
IncomingDocumentSchema.index({ status: 1, category: 1, documentTypeId: 1 });
