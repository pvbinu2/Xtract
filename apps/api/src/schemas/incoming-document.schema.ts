import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type IncomingDocumentDocument = HydratedDocument<IncomingDocument>;
export type DocumentStatus = 'uploaded' | 'processing' | 'extracted' | 'validated' | 'failed';

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

@Schema({ timestamps: true })
export class IncomingDocument {
  @Prop({ required: true })
  fileName!: string;

  @Prop({ required: true })
  originalName!: string;

  @Prop({ required: true })
  filePath!: string;

  @Prop({ required: true })
  category!: string;

  @Prop({ type: Types.ObjectId, ref: 'DocumentType', required: true })
  documentTypeId!: Types.ObjectId;

  @Prop({ required: true })
  documentTypeName!: string;

  @Prop({ default: 'uploaded' })
  status!: DocumentStatus;

  @Prop({ type: [ExtractedValueSchema], default: [] })
  extractedData!: ExtractedValue[];

  @Prop()
  error?: string;
}

export const IncomingDocumentSchema = SchemaFactory.createForClass(IncomingDocument);
IncomingDocumentSchema.index({ createdAt: -1 });
IncomingDocumentSchema.index({ status: 1, category: 1, documentTypeId: 1 });
