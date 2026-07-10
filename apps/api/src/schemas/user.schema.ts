import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type UserRole = 'admin' | 'validator';
export type PreferredCurrency = 'USD' | 'INR' | 'GBP' | 'EUR';
export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, unique: true, trim: true, lowercase: true })
  username!: string;

  @Prop({ required: true })
  passwordHash!: string;

  @Prop({ required: true, enum: ['admin', 'validator'], default: 'validator' })
  role!: UserRole;

  @Prop({ default: true })
  enabled!: boolean;

  @Prop({ required: true, enum: ['USD', 'INR', 'GBP', 'EUR'], default: 'USD' })
  preferredCurrency!: PreferredCurrency;
}

export const UserSchema = SchemaFactory.createForClass(User);
UserSchema.index({ username: 1 }, { unique: true });
