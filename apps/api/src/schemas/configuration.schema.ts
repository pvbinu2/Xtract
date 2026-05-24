import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ConfigurationDocument = Configuration & Document;

@Schema({ collection: 'configuration' })
export class Configuration {
  @Prop({ required: true })
  downstreamUrl!: string;

  @Prop({ default: false })
  deleteAfterDownstream!: boolean;

  @Prop({ default: false })
  sendKeyValuePairs!: boolean;
}

export const ConfigurationSchema = SchemaFactory.createForClass(Configuration);
