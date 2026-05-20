import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentType, DocumentTypeSchema } from '../schemas/document-type.schema';
import { IncomingDocument, IncomingDocumentSchema } from '../schemas/incoming-document.schema';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { ConfigurationModule } from '../configuration/configuration.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IncomingDocument.name, schema: IncomingDocumentSchema },
      { name: DocumentType.name, schema: DocumentTypeSchema },
    ]),
    ConfigurationModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
