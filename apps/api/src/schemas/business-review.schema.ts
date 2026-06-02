import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BusinessReviewSummaryDocument = HydratedDocument<BusinessReviewSummary>;
export type BusinessReviewHistoryDocument = HydratedDocument<BusinessReviewHistory>;

@Schema({ collection: 'business_review_summaries', timestamps: true })
export class BusinessReviewSummary {
  @Prop({ required: true, unique: true, default: 'global' })
  key!: string;

  @Prop({ default: 0 })
  filesProcessed!: number;

  @Prop({ default: 0 })
  inputTokens!: number;

  @Prop({ default: 0 })
  outputTokens!: number;

  @Prop({ default: 0 })
  totalTokens!: number;

  @Prop({ default: 0 })
  estimatedCostUsd!: number;
}

export const BusinessReviewSummarySchema = SchemaFactory.createForClass(BusinessReviewSummary);

@Schema({ collection: 'business_review_history', timestamps: true })
export class BusinessReviewHistory {
  @Prop({ required: true })
  documentId!: string;

  @Prop({ required: true })
  fileName!: string;

  @Prop()
  documentTypeName?: string;

  @Prop()
  category?: string;

  @Prop()
  model?: string;

  @Prop({ default: 0 })
  inputTokens!: number;

  @Prop({ default: 0 })
  outputTokens!: number;

  @Prop({ default: 0 })
  totalTokens!: number;

  @Prop({ default: 0 })
  estimatedCostUsd!: number;

  @Prop()
  processedAt?: Date;
}

export const BusinessReviewHistorySchema = SchemaFactory.createForClass(BusinessReviewHistory);
BusinessReviewHistorySchema.index({ processedAt: -1 });
