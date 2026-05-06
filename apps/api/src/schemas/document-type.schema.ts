import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DocumentTypeDocument = HydratedDocument<DocumentType>;

export type FieldType = 'string' | 'number' | 'date' | 'currency' | 'boolean' | 'table';

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

  @Prop({ type: [ExtractionFieldSchema], default: [] })
  fields!: ExtractionField[];

  @Prop({ default: false })
  finalized!: boolean;
}

export const DocumentTypeSchema = SchemaFactory.createForClass(DocumentType);
DocumentTypeSchema.index({ category: 1, name: 1 }, { unique: true });
