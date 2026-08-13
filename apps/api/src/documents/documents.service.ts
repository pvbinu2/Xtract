import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { InjectModel } from '@nestjs/mongoose';
import { unlink } from 'fs/promises';
import { Model, Types } from 'mongoose';
import { PDFDocument } from 'pdf-lib';
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
import type { AuthenticatedUser } from '../auth/auth.guard';
import { decryptJson, encryptJson, resolveDataEncryptionSettings } from '@xtract/common';
import { hasServiceBusConfiguration, sendServiceBusMessage } from '../service-bus';

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

  private async encryptionSettings() {
    return resolveDataEncryptionSettings(await this.configurationService.get() as any);
  }

  private async storageReadKeys() {
    const settings = await this.encryptionSettings();
    return { keys: settings.storage.key ? { [String(settings.storage.keyVersion)]: settings.storage.key } : {} };
  }

  private requireServiceBus() {
    if (!hasServiceBusConfiguration()) {
      throw new BadRequestException('Document processing requires Service Bus configuration.');
    }
  }

  private policyFor(settings: any) {
    return {
      storageEncryptionEnabled: settings.storage.enabled,
      databaseEncryptionEnabled: settings.database.enabled,
      storageEncryptionKeyVersion: settings.storage.enabled ? settings.storage.keyVersion : undefined,
      databaseEncryptionKeyVersion: settings.database.enabled ? settings.database.keyVersion : undefined,
    };
  }

  private decryptExtractedData(document: any, settings: any): ExtractedValue[] {
    if (!document.encryptedExtractedData) return document.extractedData || [];
    return decryptJson(document.encryptedExtractedData, {
      keys: { [String(settings.database.keyVersion)]: settings.database.key },
      context: `${String(document._id)}:extractedData`,
    }) as ExtractedValue[];
  }

  private extractedDataUpdate(document: any, data: ExtractedValue[], settings: any) {
    if (!document.encryptionPolicy?.databaseEncryptionEnabled) {
      return { $set: { extractedData: data }, $unset: { encryptedExtractedData: '' } };
    }
    const keyVersion = Number(document.encryptionPolicy.databaseEncryptionKeyVersion) || 1;
    return {
      $set: { encryptedExtractedData: encryptJson(data, { key: settings.database.key, keyVersion, context: `${String(document._id)}:extractedData` }) },
      $unset: { extractedData: '' },
    };
  }

  private transitionStatus(
    document: IncomingDocumentDocument,
    status: IncomingDocument['status'],
    reset = false,
    completed = false,
  ) {
    const now = new Date();
    const timings = reset ? [] : [...(document.stageTimings || [])];
    for (const timing of timings) {
      if (!timing.endTime) timing.endTime = now;
    }
    timings.push({ status, startTime: now, ...(completed ? { endTime: now } : {}) } as any);
    document.stageTimings = timings as any;
    document.status = status;
    document.revision = Number(document.revision || 0) + 1;
  }

  async list(query: {
    status?: string;
    category?: string;
    name?: string;
    documentTypeId?: string;
    sort?: string;
    page?: string;
    pageSize?: string;
  }): Promise<any> {
    const filter: Record<string, unknown> = {};
    if (query.status === 'in-progress') {
      filter.status = { $in: ['received', 'preprocessed', 'classified', 'uploaded', 'processing'] };
    } else if (query.status) {
      filter.status = query.status;
    }
    if (query.category) filter.category = query.category;
    if (query.name) filter.originalName = new RegExp(this.escapeRegex(query.name), 'i');
    if (query.documentTypeId) filter.documentTypeId = query.documentTypeId;
    const sort = query.sort === 'oldest' ? ({ createdAt: 1 } as const) : ({ createdAt: -1 } as const);
    const page = Math.max(Number(query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize) || 25, 5), 100);
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      this.documentModel.find(filter).select('-extractedData -encryptedExtractedData').sort(sort).skip(skip).limit(pageSize).lean(),
      this.documentModel.countDocuments(filter),
    ]);

    return {
      items: items.map((item) => ({ ...item, extractedData: [] })),
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
  }[]): Promise<any> {
    this.requireServiceBus();
    const documents = [] as IncomingDocumentDocument[];
    const settings = await this.encryptionSettings();

    for (const item of payload) {
      const docType = item.documentTypeId ? await this.documentTypeModel.findById(item.documentTypeId) : undefined;
      if (item.documentTypeId && !docType) throw new NotFoundException('Document type not found');
      const result = await this.createIngestedDocument(item, docType, settings, { ingestionSource: 'ui' });
      documents.push(result.document);
    }

    return Promise.all(documents.map((document) => this.findById(document.id)));
  }

  async ingestExternal(item: {
    fileName: string;
    originalName: string;
    buffer: Buffer;
    mimeType?: string;
    category?: string;
    type?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    this.requireServiceBus();
    const hasCategory = Boolean(item.category);
    const hasType = Boolean(item.type);
    if (hasCategory !== hasType) {
      throw new BadRequestException('Category and type must be supplied together or both omitted.');
    }
    const idempotencyHash = createHash('sha256').update(item.idempotencyKey).digest('hex');
    const existing = await this.documentModel.findOne({ ingestionIdempotencyKeyHash: idempotencyHash });
    if (existing) {
      if (existing.status === 'failed') {
        throw new ConflictException('The original ingestion request failed. Use a new Idempotency-Key to retry.');
      }
      return this.ingestionReceipt(existing, true);
    }

    const docType = hasCategory
      ? await this.documentTypeModel.findOne({ category: item.category, name: item.type })
      : undefined;
    if (hasCategory && !docType) throw new NotFoundException('Document category and type were not found.');

    const settings = await this.encryptionSettings();
    const result = await this.createIngestedDocument(item, docType, settings, {
      ingestionSource: 'api',
      ingestionMetadata: item.metadata,
      ingestionIdempotencyKeyHash: idempotencyHash,
    });
    return this.ingestionReceipt(result.document, result.deduplicated);
  }

  private async createIngestedDocument(
    item: { fileName: string; originalName: string; buffer: Buffer; mimeType?: string },
    docType: DocumentTypeDocument | null | undefined,
    settings: any,
    ingestion: {
      ingestionSource: 'ui' | 'api';
      ingestionMetadata?: Record<string, unknown>;
      ingestionIdempotencyKeyHash?: string;
    },
  ): Promise<{ document: IncomingDocumentDocument; deduplicated: boolean }> {
    const documentId = new Types.ObjectId();
    const blobName = this.blobStorage.createBlobName(item.originalName, documentId.toString());
    await this.blobStorage.uploadBuffer(
      PROCESSING_CONTAINER,
      blobName,
      item.buffer,
      item.mimeType,
      settings.storage.enabled ? { key: settings.storage.key, keyVersion: settings.storage.keyVersion } : undefined,
    );

    const initialPayload = settings.database.enabled
      ? { encryptedExtractedData: encryptJson([], { key: settings.database.key, keyVersion: settings.database.keyVersion, context: `${documentId}:extractedData` }) }
      : { extractedData: [] };
    let document: IncomingDocumentDocument;
    try {
      document = await this.documentModel.create({
        _id: documentId,
        fileName: blobName,
        originalName: item.originalName,
        mimeType: item.mimeType,
        filePath: `azure://${PROCESSING_CONTAINER}/${blobName}`,
        storageContainer: PROCESSING_CONTAINER,
        storageBlobName: blobName,
        category: docType?.category ?? 'Unclassified',
        documentTypeId: docType?._id,
        documentTypeName: docType?.name ?? 'Pending classification',
        classificationScore: docType ? 1 : undefined,
        classificationMethod: docType ? 'manual' : 'vector',
        classificationModel: docType ? 'manual' : undefined,
        status: 'received',
        stageTimings: [{ status: 'received', startTime: new Date(), endTime: new Date() }],
        revision: 1,
        encryptionPolicy: this.policyFor(settings),
        ...ingestion,
        ...initialPayload,
      });
    } catch (error) {
      await this.blobStorage.deleteBlob(PROCESSING_CONTAINER, blobName).catch(() => undefined);
      if ((error as { code?: number }).code === 11000 && ingestion.ingestionIdempotencyKeyHash) {
        const existing = await this.documentModel.findOne({
          ingestionIdempotencyKeyHash: ingestion.ingestionIdempotencyKeyHash,
        });
        if (existing) return { document: existing, deduplicated: true };
      }
      throw error;
    }

    await this.publishDocumentChanged(document, ['status']);
    try {
      await this.enqueueProcessing(document.id);
    } catch (error) {
      document.status = 'failed';
      document.error = error instanceof Error ? error.message : String(error);
      document.revision = Number(document.revision || 0) + 1;
      await document.save();
      await this.publishDocumentChanged(document, ['status', 'error']);
      throw error;
    }
    return { document, deduplicated: false };
  }

  private ingestionReceipt(document: IncomingDocumentDocument, deduplicated: boolean) {
    const manual = Boolean(document.documentTypeId);
    return {
      documentId: document.id,
      status: document.status,
      category: document.category,
      type: manual ? document.documentTypeName : undefined,
      documentTypeId: document.documentTypeId?.toString(),
      classificationMode: manual ? 'manual' : 'automatic',
      deduplicated,
    };
  }

  private async enqueueProcessing(documentId: string) {
    try {
      await sendServiceBusMessage('document-processing', { documentId });
    } catch (error) {
      throw new BadRequestException((error as Error)?.message || 'Document processing could not be queued.');
    }
  }

  private async publishDocumentChanged(
    document: any,
    changedFields: string[],
  ) {
    if (process.env.SIGNALR_ENABLED === 'false' || !process.env.REALTIME_BROADCAST_URL) return;
    try {
      const eventId = randomUUID();
      await sendServiceBusMessage('document-events', {
        eventId,
        documentId: document.id || String(document._id),
        revision: Number(document.revision || 0),
        status: document.status,
        changedFields,
        updatedAt: new Date(document.updatedAt || Date.now()).toISOString(),
      }, eventId);
    } catch (error) {
      console.warn(`Document real-time event could not be queued: ${(error as Error)?.message || String(error)}`);
    }
  }

  async reprocess(id: string, options: ReprocessOptions = {}): Promise<any> {
    const document = await this.documentModel.findById(id);
    if (!document) throw new NotFoundException('Document not found');
    if (document.status === 'validated' || document.status === 'rejected') {
      throw new BadRequestException(
        `${document.status === 'validated' ? 'Validated' : 'Rejected'} documents cannot be reclassified or reprocessed.`,
      );
    }

    // If a new document type is provided, update it
    const newDocumentTypeId = options.documentTypeId;
    if (newDocumentTypeId) {
      const newDocType = await this.documentTypeModel.findById(newDocumentTypeId);
      if (!newDocType) throw new NotFoundException('Document type not found');

      document.documentTypeId = newDocType._id;
      document.documentTypeName = newDocType.name;
      document.category = newDocType.category;
    }

    this.requireServiceBus();
    const forceClassification = options.forceClassification ?? !newDocumentTypeId;
    this.transitionStatus(document, 'received', true, true);
    const settings = await this.encryptionSettings();
    if (document.spatialTextArtifactContainer && document.spatialTextArtifactBlobName) {
      await this.blobStorage.deleteBlob(document.spatialTextArtifactContainer, document.spatialTextArtifactBlobName);
      document.spatialTextArtifactContainer = undefined;
      document.spatialTextArtifactBlobName = undefined;
    }
    document.validatedBy = undefined;
    document.validatedAt = undefined;
    document.rejectedBy = undefined;
    document.rejectedAt = undefined;
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
    await this.documentModel.updateOne({ _id: document._id }, this.extractedDataUpdate(document, [], settings));
    await this.publishDocumentChanged(document, [
      'status',
      'extractedData',
      'validatedBy',
      'validatedAt',
      'rejectedBy',
      'rejectedAt',
      'spatialTextArtifactBlobName',
    ]);

    await this.enqueueProcessing(document.id);

    return this.findById(document.id);
  }

  async findById(id: string): Promise<any> {
    const document = await this.documentModel.findById(id).lean();
    if (!document) throw new NotFoundException('Document not found');
    const settings = await this.encryptionSettings();
    return { ...document, extractedData: this.decryptExtractedData(document, settings), encryptedExtractedData: undefined };
  }

  async getFile(id: string) {
    const document = await this.documentModel.findById(id).lean();
    if (!document) throw new NotFoundException('Document not found');

    if (document.storageContainer && document.storageBlobName) {
      return {
        buffer: await this.blobStorage.downloadBuffer(document.storageContainer, document.storageBlobName, await this.storageReadKeys()),
        contentType: document.convertedToPdf ? 'application/pdf' : (document.mimeType || 'application/octet-stream'),
      };
    }

    const { readFile } = await import('fs/promises');
    return {
      buffer: await readFile(document.filePath),
      contentType: 'application/pdf',
    };
  }

  async getTextArtifact(id: string) {
    const document = await this.documentModel.findById(id).lean();
    if (!document) throw new NotFoundException('Document not found');
    if (!document.textArtifactContainer || !document.textArtifactBlobName) {
      throw new NotFoundException('OCR/markdown artifact is not available for this document');
    }

    return {
      buffer: await this.blobStorage.downloadBuffer(
        document.textArtifactContainer,
        document.textArtifactBlobName,
        await this.storageReadKeys(),
      ),
      contentType: document.textArtifactMode === 'markdown'
        ? 'text/markdown; charset=utf-8'
        : 'text/plain; charset=utf-8',
      fileName: document.textArtifactBlobName.split('/').at(-1) || `document.${document.textArtifactMode === 'markdown' ? 'md' : 'ocr'}`,
    };
  }

  async getSpatialTextPage(id: string, pageNumberInput: string) {
    const pageNumber = Number(pageNumberInput);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new BadRequestException('Page number must be a positive integer');
    }
    const document = await this.documentModel.findById(id).lean();
    if (!document) throw new NotFoundException('Document not found');
    if (!document.spatialTextArtifactContainer || !document.spatialTextArtifactBlobName) {
      throw new NotFoundException('Selectable text is unavailable. Reprocess this document to generate it.');
    }

    const buffer = await this.blobStorage.downloadBuffer(
      document.spatialTextArtifactContainer,
      document.spatialTextArtifactBlobName,
      await this.storageReadKeys(),
    );
    let artifact: { version?: unknown; items?: unknown };
    try {
      artifact = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new BadRequestException('The selectable text artifact is invalid.');
    }
    if (artifact.version !== 1 || !Array.isArray(artifact.items)) {
      throw new BadRequestException('The selectable text artifact version is unsupported.');
    }
    const pageIndex = pageNumber - 1;
    const items = artifact.items.flatMap((candidate: any) => {
      if (
        candidate?.page !== pageIndex || typeof candidate.text !== 'string' || !candidate.text.trim() ||
        ![candidate.x, candidate.y, candidate.width, candidate.height].every(Number.isFinite)
      ) return [];
      return [{
        text: candidate.text,
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
        lineKey: typeof candidate.lineKey === 'string' ? candidate.lineKey : undefined,
        order: Number.isFinite(candidate.order) ? candidate.order : 0,
      }];
    }).sort((a, b) => a.order - b.order);
    return { version: 1 as const, page: pageNumber, items };
  }

  async getPdfPageCount(id: string) {
    const file = await this.getFile(id);
    const pdf = await PDFDocument.load(file.buffer);
    return { pageCount: pdf.getPageCount() };
  }

  async getPdfPage(id: string, pageNumberInput: string) {
    const pageNumber = Number(pageNumberInput);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new BadRequestException('Page number must be a positive integer.');
    }

    const file = await this.getFile(id);
    const sourcePdf = await PDFDocument.load(file.buffer);
    const pageCount = sourcePdf.getPageCount();
    if (pageNumber > pageCount) {
      throw new BadRequestException(`Page number must be between 1 and ${pageCount}.`);
    }

    const pagePdf = await PDFDocument.create();
    const [page] = await pagePdf.copyPages(sourcePdf, [pageNumber - 1]);
    pagePdf.addPage(page);
    const pageBytes = await pagePdf.save();

    return {
      buffer: Buffer.from(pageBytes),
      contentType: 'application/pdf',
      pageCount,
      pageNumber,
    };
  }

  async updateExtractedData(id: string, extractedData: ExtractedValue[]) {
    const document: any = await this.documentModel.findById(id).lean();
    if (!document) throw new NotFoundException('Document not found');
    const settings = await this.encryptionSettings();
    const update: any = this.extractedDataUpdate(document, extractedData, settings);
    update.$inc = { revision: 1 };
    const updated: any = await this.documentModel.findByIdAndUpdate(id, update, { new: true }).lean();
    await this.publishDocumentChanged(updated, ['extractedData']);
    return { ...updated, extractedData, encryptedExtractedData: undefined };
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
      this.documentModel.countDocuments({
        status: { $in: ['received', 'preprocessed', 'classified', 'uploaded', 'processing'] },
      }),
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

  private async getDownstreamConfig() {
    let url = process.env.DOWNSTREAM_API_URL?.trim();
    let useEnv = Boolean(url);
    let sendKeyValuePairs = false;

    const configuration = await this.configurationService.get();
    sendKeyValuePairs = Boolean(configuration.sendKeyValuePairs);

    const configuredUrl = configuration.downstreamUrl?.trim();
    if (configuredUrl) {
      url = configuredUrl;
      useEnv = false;
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
      metadata: document.ingestionMetadata,
      documentTypeId: document.documentTypeId?.toString(),
      documentTypeName: document.documentTypeName,
      classificationScore: document.classificationScore,
      classificationMethod: document.classificationMethod,
      status: document.status,
      validatedBy: document.validatedBy,
      validatedAt: document.validatedAt?.toISOString(),
      rejectedBy: document.rejectedBy,
      rejectedAt: document.rejectedAt?.toISOString(),
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
    user: AuthenticatedUser,
  ): Promise<any> {
    const updated = await this.documentModel.findById(id);
    if (!updated) throw new NotFoundException('Document not found');
    updated.validatedBy = {
      userId: user.id,
      username: user.username,
      role: user.role,
    };
    updated.validatedAt = new Date();
    this.transitionStatus(updated, 'validated', false, true);
    await updated.save();
    const encryptionSettings = await this.encryptionSettings();
    await this.documentModel.updateOne({ _id: updated._id }, this.extractedDataUpdate(updated, extractedData, encryptionSettings));
    await this.publishDocumentChanged(updated, ['status', 'extractedData', 'validatedBy', 'validatedAt']);

    const configuration = await this.configurationService.get();
    const downstreamConfig = await this.getDownstreamConfig();
    if (downstreamConfig) {
      try {
        await this.sendToDownstream(updated, extractedData, downstreamConfig);
        // Only delete after successful downstream send
        if (configuration.deleteAfterDownstream) {
          await this.remove(updated.id);
          return { deleted: true };
        }
      } catch (error) {
        // If downstream send fails, don't delete the document
        throw error;
      }
    }

    return this.findById(updated.id);
  }

  async reject(id: string, user: AuthenticatedUser): Promise<any> {
    const updated = await this.documentModel.findById(id);
    if (!updated) throw new NotFoundException('Document not found');
    updated.rejectedBy = {
      userId: user.id,
      username: user.username,
      role: user.role,
    };
    updated.rejectedAt = new Date();
    this.transitionStatus(updated, 'rejected', false, true);
    await updated.save();
    await this.publishDocumentChanged(updated, ['status', 'rejectedBy', 'rejectedAt']);

    const configuration = await this.configurationService.get();
    const extractedData = this.decryptExtractedData(updated.toObject(), resolveDataEncryptionSettings(configuration as any));
    const downstreamConfig = await this.getDownstreamConfig();
    if (downstreamConfig) {
      try {
        await this.sendToDownstream(updated, extractedData, downstreamConfig);
        if (configuration.deleteAfterDownstream) {
          await this.remove(updated.id);
          return { deleted: true };
        }
      } catch (error) {
        // Log error but don't fail the reject operation
        console.error('Failed to send rejected document to downstream:', error);
      }
    }

    return this.findById(updated.id);
  }

  async remove(id: string) {
    const document = await this.documentModel.findById(id);
    if (!document) throw new NotFoundException('Document not found');

    if (document.storageContainer && document.storageBlobName) {
      await this.blobStorage.deleteBlob(document.storageContainer, document.storageBlobName);
      if (document.textArtifactContainer && document.textArtifactBlobName) {
        await this.blobStorage.deleteBlob(document.textArtifactContainer, document.textArtifactBlobName);
      }
    } else {
      try {
        await unlink(document.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
    if (document.spatialTextArtifactContainer && document.spatialTextArtifactBlobName) {
      await this.blobStorage.deleteBlob(document.spatialTextArtifactContainer, document.spatialTextArtifactBlobName);
    }

    await this.documentModel.deleteOne({ _id: document._id });

    return { deleted: true };
  }
}
