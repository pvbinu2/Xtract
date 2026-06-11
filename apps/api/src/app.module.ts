import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentTypesModule } from './document-types/document-types.module';
import { DocumentsModule } from './documents/documents.module';
import { ConfigurationModule } from './configuration/configuration.module';
import { DemoRequestsModule } from './demo-requests/demo-requests.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/xtract'),
    AuthModule,
    UsersModule,
    DocumentTypesModule,
    DocumentsModule,
    ConfigurationModule,
    DemoRequestsModule,
  ],
})
export class AppModule {}
