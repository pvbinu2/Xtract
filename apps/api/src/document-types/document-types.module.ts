import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentType, DocumentTypeSchema } from '../schemas/document-type.schema';
import { BlobStorageService } from '../storage/blob-storage.service';
import { ConfigurationModule } from '../configuration/configuration.module';
import { DocumentTypesController } from './document-types.controller';
import { DocumentTypesService } from './document-types.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DocumentType.name, schema: DocumentTypeSchema }]),
    ConfigurationModule,
  ],
  controllers: [DocumentTypesController],
  providers: [DocumentTypesService, BlobStorageService],
  exports: [DocumentTypesService],
})
export class DocumentTypesModule {}
