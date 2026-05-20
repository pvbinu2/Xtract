import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DownstreamRequestDocument = DownstreamRequest & Document;

@Schema({ collection: 'downstream-requests', timestamps: true })
export class DownstreamRequest {
  _id?: Types.ObjectId;

  @Prop({ required: true })
  documentId!: string;

  @Prop({ required: true })
  fileName!: string;

  @Prop()
  category?: string;

  @Prop()
  status?: string;

  @Prop({ type: Object })
  extractedData?: Record<string, unknown>;

  @Prop({ type: Object })
  payload!: Record<string, unknown>;

  @Prop({ default: () => new Date() })
  receivedAt!: Date;
}

export const DownstreamRequestSchema = SchemaFactory.createForClass(DownstreamRequest);
