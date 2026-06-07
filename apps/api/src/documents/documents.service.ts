import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { QueueServiceClient } from '@azure/storage-queue';
import { InjectModel } from '@nestjs/mongoose';
import { unlink } from 'fs/promises';
import { Model } from 'mongoose';
import { DocumentType, DocumentTypeDocument } from '../schemas/document-type.schema';
import {
  ExtractedValue,
  IncomingDocument,
  IncomingDocumentDocument,
  ProcessingMetrics,
  ReprocessOptions,
} from '../schemas/incoming-document.schema';
import {
  BusinessReviewHistory,
  BusinessReviewHistoryDocument,
  BusinessReviewSummary,
  BusinessReviewSummaryDocument,
} from '../schemas/business-review.schema';
import { ConfigurationService } from '../configuration/configuration.service';
import { BlobStorageService, PROCESSING_CONTAINER } from '../storage/blob-storage.service';

@Injectable()
export class DocumentsService {
  constructor(
    @InjectModel(IncomingDocument.name) private readonly documentModel: Model<IncomingDocumentDocument>,
    @InjectModel(DocumentType.name) private readonly documentTypeModel: Model<DocumentTypeDocument>,
    @InjectModel(BusinessReviewSummary.name) private readonly businessReviewSummaryModel: Model<BusinessReviewSummaryDocument>,
    @InjectModel(BusinessReviewHistory.name) private readonly businessReviewHistoryModel: Model<BusinessReviewHistoryDocument>,
    private readonly configurationService: ConfigurationService,
    private readonly blobStorage: BlobStorageService,
  ) { }

  private escapeRegex(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async list(query: {
    status?: string;
    category?: string;
    name?: string;
    documentTypeId?: string;
    sort?: string;
    page?: string;
    pageSize?: string;
  }) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.category) filter.category = query.category;
    if (query.name) filter.originalName = new RegExp(this.escapeRegex(query.name), 'i');
    if (query.documentTypeId) filter.documentTypeId = query.documentTypeId;
    const sort = query.sort === 'oldest' ? ({ createdAt: 1 } as const) : ({ createdAt: -1 } as const);
    const page = Math.max(Number(query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize) || 25, 5), 100);
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      this.documentModel.find(filter).sort(sort).skip(skip).limit(pageSize).lean(),
      this.documentModel.countDocuments(filter),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
  }

  async upload(payload: {
    fileName: string;
    originalName: string;
    buffer: Buffer;
    mimeType?: string;
    category?: string;
    documentTypeId?: string;
  }[]) {
    this.queueConnectionString();
    const documents = [] as IncomingDocumentDocument[];

    for (const item of payload) {
      const docType = item.documentTypeId ? await this.documentTypeModel.findById(item.documentTypeId) : undefined;
      if (item.documentTypeId && !docType) throw new NotFoundException('Document type not found');

      const blobName = this.blobStorage.createBlobName(item.originalName);
      await this.blobStorage.uploadBuffer(PROCESSING_CONTAINER, blobName, item.buffer, item.mimeType);

      const document = await this.documentModel.create({
        fileName: blobName,
        originalName: item.originalName,
        filePath: `azure://${PROCESSING_CONTAINER}/${blobName}`,
        storageContainer: PROCESSING_CONTAINER,
        storageBlobName: blobName,
        category: docType?.category ?? 'Unclassified',
        documentTypeId: docType?._id,
        documentTypeName: docType?.name ?? 'Pending classification',
        classificationScore: docType ? 1 : undefined,
        classificationMethod: docType ? 'manual' : 'vector',
        classificationModel: docType ? 'manual' : undefined,
        status: 'processing',
        extractedData: [],
      });

      documents.push(document);
      await this.enqueueProcessing(document.id);
    }

    return Promise.all(documents.map((document) => this.findById(document.id)));
  }

  private queueConnectionString() {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
    if (!connectionString) {
      throw new BadRequestException('Document processing requires AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage for the function queue.');
    }
    return connectionString;
  }

  private async enqueueProcessing(documentId: string) {
    const connectionString = this.queueConnectionString();
    const queue = QueueServiceClient.fromConnectionString(connectionString).getQueueClient('document-processing');
    await queue.createIfNotExists();
    await queue.sendMessage(Buffer.from(JSON.stringify({ documentId })).toString('base64'));
  }

  async reprocess(id: string, options: ReprocessOptions = {}) {
    const document = await this.documentModel.findById(id);
    if (!document) throw new NotFoundException('Document not found');

    // If a new document type is provided, update it
    const newDocumentTypeId = options.documentTypeId;
    if (newDocumentTypeId) {
      const newDocType = await this.documentTypeModel.findById(newDocumentTypeId);
      if (!newDocType) throw new NotFoundException('Document type not found');

      document.documentTypeId = newDocType._id;
      document.documentTypeName = newDocType.name;
      document.category = newDocType.category;
    }

    this.queueConnectionString();
    const forceClassification = options.forceClassification ?? !newDocumentTypeId;
    document.status = 'processing';
    document.extractedData = [];
    document.error = undefined;
    if (forceClassification) {
      document.classificationScore = undefined;
    }
    document.reprocessOptions = {
      extractionModel: options.extractionModel,
      useOcrForDocumentProcessing: options.useOcrForDocumentProcessing,
      documentTextMode: options.documentTextMode,
      forceClassification,
    };
    await document.save();

    await this.enqueueProcessing(document.id);

    return this.findById(document.id);
  }

  async findById(id: string) {
    const document = await this.documentModel.findById(id).lean();
    if (!document) throw new NotFoundException('Document not found');
    return document;
  }

  async getFile(id: string) {
    const document = await this.documentModel.findById(id).lean();
    if (!document) throw new NotFoundException('Document not found');

    if (document.storageContainer && document.storageBlobName) {
      return {
        buffer: await this.blobStorage.downloadBuffer(document.storageContainer, document.storageBlobName),
        contentType: 'application/pdf',
      };
    }

    const { readFile } = await import('fs/promises');
    return {
      buffer: await readFile(document.filePath),
      contentType: 'application/pdf',
    };
  }

  async updateExtractedData(id: string, extractedData: ExtractedValue[]) {
    const updated = await this.documentModel.findByIdAndUpdate(
      id,
      { extractedData },
      { new: true },
    ).lean();
    if (!updated) throw new NotFoundException('Document not found');
    return updated;
  }

  private async recordBusinessReviewProcessing(document: IncomingDocumentDocument, metrics: ProcessingMetrics) {
    const processedAt = metrics.processedAt ?? new Date();
    const extractionCostUsd = Number(metrics.extractionCostUsd ?? metrics.estimatedCostUsd ?? 0);
    const classificationCostUsd = Number(metrics.classificationCostUsd || 0);
    const embeddingCostUsd = Number(metrics.embeddingCostUsd || 0);
    const estimatedCostUsd = Number((extractionCostUsd + classificationCostUsd + embeddingCostUsd).toFixed(8));
    await this.businessReviewSummaryModel.findOneAndUpdate(
      { key: 'global' },
      {
        $setOnInsert: { key: 'global' },
        $inc: {
          filesProcessed: 1,
          inputTokens: Number(metrics.inputTokens || 0),
          outputTokens: Number(metrics.outputTokens || 0),
          totalTokens: Number(metrics.totalTokens || 0),
          estimatedCostUsd,
          extractionCostUsd,
          classificationCostUsd,
          embeddingCostUsd,
        },
      },
      { upsert: true, new: true },
    );

    await this.businessReviewHistoryModel.create({
      documentId: String(document._id),
      fileName: document.originalName,
      documentTypeName: document.documentTypeName,
      category: document.category,
      status: document.status,
      model: metrics.model,
      classificationModel: document.classificationModel,
      extractionModel: metrics.model,
      inputTokens: Number(metrics.inputTokens || 0),
      outputTokens: Number(metrics.outputTokens || 0),
      totalTokens: Number(metrics.totalTokens || 0),
      estimatedCostUsd,
      extractionCostUsd,
      classificationCostUsd,
      embeddingCostUsd,
      processedAt,
    });

    const staleHistory = await this.businessReviewHistoryModel
      .find()
      .select('_id')
      .sort({ processedAt: -1, _id: -1 })
      .skip(5)
      .lean();

    if (staleHistory.length) {
      await this.businessReviewHistoryModel.deleteMany({ _id: { $in: staleHistory.map((entry) => entry._id) } });
    }
  }

  async businessReviewSummary() {
    const [totalFiles, filesProcessing, filesFailed, persistedSummary, recentDocuments] = await Promise.all([
      this.documentModel.countDocuments(),
      this.documentModel.countDocuments({ status: 'processing' }),
      this.documentModel.countDocuments({ status: 'failed' }),
      this.businessReviewSummaryModel.findOneAndUpdate(
        { key: 'global' },
        { $setOnInsert: { key: 'global' } },
        { upsert: true, new: true },
      ),
      this.businessReviewHistoryModel
        .find()
        .sort({ processedAt: -1, _id: -1 })
        .limit(5)
        .lean(),
    ]);

    return {
      totalFiles,
      filesProcessed: persistedSummary?.filesProcessed || 0,
      filesProcessing,
      filesFailed,
      tokens: {
        input: persistedSummary?.inputTokens || 0,
        output: persistedSummary?.outputTokens || 0,
        total: persistedSummary?.totalTokens || 0,
      },
      estimatedCostUsd: Number((persistedSummary?.estimatedCostUsd || 0).toFixed(8)),
      extractionCostUsd: Number((persistedSummary?.extractionCostUsd || 0).toFixed(8)),
      classificationCostUsd: Number((persistedSummary?.classificationCostUsd || 0).toFixed(8)),
      embeddingCostUsd: Number((persistedSummary?.embeddingCostUsd || 0).toFixed(8)),
      documentsWithRecordedUsage: persistedSummary?.filesProcessed || 0,
      recentDocuments: recentDocuments.map((doc) => ({
        id: doc.documentId,
        name: doc.fileName,
        status: doc.status || 'extracted',
        tokens: doc.totalTokens || 0,
        estimatedCostUsd: doc.estimatedCostUsd || 0,
        extractionCostUsd: doc.extractionCostUsd ?? doc.estimatedCostUsd ?? 0,
        classificationCostUsd: doc.classificationCostUsd || 0,
        embeddingCostUsd: doc.embeddingCostUsd || 0,
        classificationModel: doc.classificationModel,
        extractionModel: doc.extractionModel || doc.model,
        processedAt: doc.processedAt || (doc as unknown as { updatedAt?: Date }).updatedAt,
      })),
    };
  }

  async resetBusinessReview() {
    await Promise.all([
      this.businessReviewSummaryModel.deleteMany({}),
      this.businessReviewHistoryModel.deleteMany({}),
    ]);

    return { reset: true };
  }

  private async getDownstreamConfig(overrideUrl?: string, overrideSendKeyValuePairs?: boolean) {
    const resolvedUrl = overrideUrl?.trim();
    let url = resolvedUrl || process.env.DOWNSTREAM_API_URL?.trim();
    let useEnv = Boolean(resolvedUrl);
    let sendKeyValuePairs = Boolean(overrideSendKeyValuePairs);

    const configuration = await this.configurationService.get();
    sendKeyValuePairs = overrideSendKeyValuePairs ?? Boolean(configuration.sendKeyValuePairs);

    if (!resolvedUrl) {
      url = configuration.downstreamUrl?.trim() || url;
      useEnv = !configuration.downstreamUrl?.trim();
    }

    if (!url) return null;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (process.env.DOWNSTREAM_API_KEY) {
      headers.Authorization = `Bearer ${process.env.DOWNSTREAM_API_KEY}`;
    }

    if (process.env.DOWNSTREAM_API_AUTH_HEADER) {
      const [headerName, ...headerValueParts] = process.env.DOWNSTREAM_API_AUTH_HEADER.split(':');
      const headerValue = headerValueParts.join(':').trim();
      if (headerName && headerValue) {
        headers[headerName.trim()] = headerValue;
      }
    }

    return { url, headers, source: useEnv ? 'environment' : 'database', sendKeyValuePairs };
  }

  private normalizeTableRows(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
      return value.map((row) =>
        row && typeof row === 'object' && !Array.isArray(row)
          ? row as Record<string, unknown>
          : { value: row },
      );
    }
    if (typeof value === 'string') {
      try {
        return this.normalizeTableRows(JSON.parse(value));
      } catch {
        return [];
      }
    }
    return [];
  }

  private buildKeyValueExtractedData(extractedData: ExtractedValue[]) {
    return extractedData.reduce<Record<string, unknown>>((acc, item) => {
      acc[item.key] = item.type === 'table' ? this.normalizeTableRows(item.value) : item.value;
      return acc;
    }, {});
  }

  private buildDownstreamPayload(
    document: IncomingDocumentDocument,
    extractedData: ExtractedValue[],
    sendKeyValuePairs = false,
  ) {
    return {
      documentId: document.id,
      fileName: document.originalName,
      category: document.category,
      documentTypeId: document.documentTypeId?.toString(),
      documentTypeName: document.documentTypeName,
      classificationScore: document.classificationScore,
      classificationMethod: document.classificationMethod,
      status: document.status,
      processedAt: new Date().toISOString(),
      extractedData: sendKeyValuePairs
        ? this.buildKeyValueExtractedData(extractedData)
        : extractedData.map((item) => ({
          key: item.key,
          label: item.label,
          type: item.type,
          value: item.value,
          confidence: item.confidence,
        })),
    };
  }

  private async sendToDownstream(
    document: IncomingDocumentDocument,
    extractedData: ExtractedValue[],
    config: NonNullable<Awaited<ReturnType<DocumentsService['getDownstreamConfig']>>>,
  ) {
    if (!config) return;

    const payload = this.buildDownstreamPayload(document, extractedData, config.sendKeyValuePairs);
    const response = await fetch(config.url, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new BadRequestException(
        `Downstream API request failed (${response.status}): ${errorText || response.statusText}`,
      );
    }
  }

  async validate(
    id: string,
    extractedData: ExtractedValue[],
    deleteAfterDownstream = false,
    downstreamUrl?: string,
    sendKeyValuePairs?: boolean,
  ) {
    const updated = await this.documentModel.findByIdAndUpdate(
      id,
      { extractedData, status: 'validated' },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Document not found');

    const downstreamConfig = await this.getDownstreamConfig(downstreamUrl, sendKeyValuePairs);
    if (downstreamConfig) {
      try {
        await this.sendToDownstream(updated, extractedData, downstreamConfig);
        // Only delete after successful downstream send
        if (deleteAfterDownstream) {
          await this.remove(updated.id);
          return { deleted: true };
        }
      } catch (error) {
        // If downstream send fails, don't delete the document
        throw error;
      }
    }

    return updated;
  }

  async reject(id: string, deleteAfterDownstream = false, downstreamUrl?: string, sendKeyValuePairs?: boolean) {
    const updated = await this.documentModel.findByIdAndUpdate(
      id,
      { status: 'rejected' },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Document not found');

    const downstreamConfig = await this.getDownstreamConfig(downstreamUrl, sendKeyValuePairs);
    if (downstreamConfig) {
      try {
        await this.sendToDownstream(updated, updated.extractedData || [], downstreamConfig);
        if (deleteAfterDownstream) {
          await this.remove(updated.id);
          return { deleted: true };
        }
      } catch (error) {
        // Log error but don't fail the reject operation
        console.error('Failed to send rejected document to downstream:', error);
      }
    }

    return updated;
  }

  async remove(id: string) {
    const document = await this.documentModel.findById(id);
    if (!document) throw new NotFoundException('Document not found');

    if (document.storageContainer && document.storageBlobName) {
      await this.blobStorage.deleteBlob(document.storageContainer, document.storageBlobName);
    } else {
      try {
        await unlink(document.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    await this.documentModel.deleteOne({ _id: document._id });

    return { deleted: true };
  }
}
