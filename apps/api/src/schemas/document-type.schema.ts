import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DocumentTypeDocument = HydratedDocument<DocumentType>;

export type FieldType = 'string' | 'number' | 'date' | 'currency' | 'boolean' | 'table';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

@Schema({ _id: false })
export class TableColumn {
  @Prop({ required: true })
  key!: string;

  @Prop({ required: true })
  label!: string;

  @Prop({ required: true })
  type!: FieldType;

  @Prop()
  description?: string;
}

const TableColumnSchema = SchemaFactory.createForClass(TableColumn);

@Schema({ _id: false })
export class ExtractionField extends TableColumn {
  @Prop({ type: [TableColumnSchema], default: [] })
  columns!: TableColumn[];

  @Prop({ default: true })
  selected!: boolean;
}

const ExtractionFieldSchema = SchemaFactory.createForClass(ExtractionField);

@Schema({ timestamps: true })
export class DocumentType {
  @Prop({ required: true, trim: true })
  category!: string;

  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ default: '' })
  prompt!: string;

  @Prop({ type: [String], default: [] })
  sampleFiles!: string[];

  @Prop({ default: false })
  includeInClassification!: boolean;

  @Prop({ default: 'untrained' })
  classifierTrainingStatus!: 'untrained' | 'training' | 'trained' | 'failed';

  @Prop({ default: '' })
  classifierProfile!: string;

  @Prop()
  classifierTrainedAt?: Date;

  @Prop()
  classifierTrainedBy?: string;

  @Prop()
  classifierTrainingError?: string;

  @Prop({ type: [ExtractionFieldSchema], default: [] })
  fields!: ExtractionField[];

  @Prop({ default: 'gpt-5-nano' })
  extractionModel!: string;

  @Prop({ default: 'low' })
  extractionReasoningEffort!: ReasoningEffort;

  @Prop({ default: false })
  extractionVerification!: boolean;

  @Prop({ default: false })
  finalized!: boolean;
}

export const DocumentTypeSchema = SchemaFactory.createForClass(DocumentType);
DocumentTypeSchema.index({ category: 1, name: 1 }, { unique: true });
