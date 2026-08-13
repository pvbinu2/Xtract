import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DocumentType, DocumentTypeSchema } from '../schemas/document-type.schema';
import { IncomingDocument, IncomingDocumentSchema } from '../schemas/incoming-document.schema';
import {
  BusinessReviewHistory,
  BusinessReviewHistorySchema,
  BusinessReviewSummary,
  BusinessReviewSummarySchema,
} from '../schemas/business-review.schema';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { ConfigurationModule } from '../configuration/configuration.module';
import { BlobStorageService } from '../storage/blob-storage.service';
import { IngestionController } from './ingestion.controller';
import { IngestionApiKeyGuard } from './ingestion-api-key.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IncomingDocument.name, schema: IncomingDocumentSchema },
      { name: DocumentType.name, schema: DocumentTypeSchema },
      { name: BusinessReviewSummary.name, schema: BusinessReviewSummarySchema },
      { name: BusinessReviewHistory.name, schema: BusinessReviewHistorySchema },
    ]),
    ConfigurationModule,
  ],
  controllers: [DocumentsController, IngestionController],
  providers: [DocumentsService, BlobStorageService, IngestionApiKeyGuard],
})
export class DocumentsModule {}
