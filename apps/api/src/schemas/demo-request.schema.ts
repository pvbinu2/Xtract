import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DemoRequestDocument = HydratedDocument<DemoRequest>;

@Schema({ timestamps: true })
export class DemoRequest {
  @Prop({ required: true, trim: true, lowercase: true })
  email!: string;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ default: 'website' })
  source!: string;
}

export const DemoRequestSchema = SchemaFactory.createForClass(DemoRequest);
DemoRequestSchema.index({ createdAt: -1 });
DemoRequestSchema.index({ email: 1 });
