import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { QueueServiceClient } from '@azure/storage-queue';
import { InjectModel } from '@nestjs/mongoose';
import { unlink } from 'fs/promises';
import { Model } from 'mongoose';
import { attachBoundingBoxes } from '../pdf-bounding-box';
import { extractValuesWithOpenAI } from '../openai-document-ai';
import { DocumentType, DocumentTypeDocument } from '../schemas/document-type.schema';
import {
  ExtractedValue,
  IncomingDocument,
  IncomingDocumentDocument,
} from '../schemas/incoming-document.schema';
import { ConfigurationService } from '../configuration/configuration.service';

function mockValue(label: string, type: string, index: number) {
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'number') return index + 1;
  if (type === 'currency') return Number((250 + index * 125.5).toFixed(2));
  if (type === 'boolean') return true;
  if (type === 'table') return [{ item: 'Sample line', quantity: 1, amount: 100 }];
  return `Extracted ${label}`;
}

function mockExtractionFromSchema(docType: DocumentTypeDocument): ExtractedValue[] {
  return docType.fields
    .filter((field) => field.selected)
    .map((field, index) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      value: mockValue(field.label, field.type, index),
      confidence: Number((0.82 + Math.min(index, 8) * 0.015).toFixed(2)),
      boundingBoxes: [],
    }));
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectModel(IncomingDocument.name) private readonly documentModel: Model<IncomingDocumentDocument>,
    @InjectModel(DocumentType.name) private readonly documentTypeModel: Model<DocumentTypeDocument>,
    private readonly configurationService: ConfigurationService,
  ) {}

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
    filePath: string;
    category?: string;
    documentTypeId?: string;
  }[]) {
    const documents = [] as IncomingDocumentDocument[];

    for (const item of payload) {
      const docType = item.documentTypeId ? await this.documentTypeModel.findById(item.documentTypeId) : undefined;
      if (item.documentTypeId && !docType) throw new NotFoundException('Document type not found');
      const autoClassify = !docType;
      if (autoClassify && !this.hasQueueConnection()) {
        throw new BadRequestException('Automatic classification requires Azure queue storage and the function worker.');
      }

      const document = await this.documentModel.create({
        ...item,
        category: docType?.category ?? 'Unclassified',
        documentTypeId: docType?._id,
        documentTypeName: docType?.name ?? 'Pending classification',
        classificationScore: docType ? 1 : undefined,
        classificationMethod: docType ? 'manual' : 'vector',
        status: 'processing',
        extractedData: [],
      });

      documents.push(document);
      if (autoClassify || process.env.PROCESSING_MODE === 'queue') {
        await this.enqueueProcessing(document.id);
      } else {
        await this.processDocument(document.id);
      }
    }

    return Promise.all(documents.map((document) => this.findById(document.id)));
  }

  private hasQueueConnection() {
    return Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage);
  }

  private async enqueueProcessing(documentId: string) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
    if (!connectionString) {
      throw new Error('Queue processing requires AZURE_STORAGE_CONNECTION_STRING or AzureWebJobsStorage');
    }
    const queue = QueueServiceClient.fromConnectionString(connectionString).getQueueClient('document-processing');
    await queue.createIfNotExists();
    await queue.sendMessage(Buffer.from(JSON.stringify({ documentId })).toString('base64'));
  }

  async processDocument(id: string) {
    const document = await this.documentModel.findById(id);
    if (!document) throw new NotFoundException('Document not found');
    const docType = await this.documentTypeModel.findById(document.documentTypeId);
    if (!docType) throw new NotFoundException('Document type not found');

    document.extractedData = await attachBoundingBoxes(
      document.filePath,
      (await extractValuesWithOpenAI(document.filePath, docType.fields, docType.name)) ??
        mockExtractionFromSchema(docType),
    );
    document.status = 'extracted';
    document.error = undefined;
    return document.save();
  }

  async reprocess(id: string, newDocumentTypeId?: string) {
    const document = await this.documentModel.findById(id);
    if (!document) throw new NotFoundException('Document not found');

    // If a new document type is provided, update it
    if (newDocumentTypeId) {
      const newDocType = await this.documentTypeModel.findById(newDocumentTypeId);
      if (!newDocType) throw new NotFoundException('Document type not found');
      
      document.documentTypeId = newDocType._id;
      document.documentTypeName = newDocType.name;
      document.category = newDocType.category;
    }

    document.status = 'processing';
    document.extractedData = [];
    document.error = undefined;
    await document.save();

    const documentWasAutoClassified = document.classificationMethod !== 'manual';
    const shouldQueue = process.env.PROCESSING_MODE === 'queue' || documentWasAutoClassified;
    if (shouldQueue) {
      if (!this.hasQueueConnection()) {
        throw new BadRequestException('Automatic classification requires Azure queue storage and the function worker.');
      }
      await this.enqueueProcessing(document.id);
    } else {
      await this.processDocument(document.id);
    }

    return this.findById(document.id);
  }

  async findById(id: string) {
    const document = await this.documentModel.findById(id).lean();
    if (!document) throw new NotFoundException('Document not found');
    return document;
  }

  private async getDownstreamConfig(overrideUrl?: string) {
    const resolvedUrl = overrideUrl?.trim();
    let url = resolvedUrl || process.env.DOWNSTREAM_API_URL?.trim();
    let useEnv = Boolean(resolvedUrl);

    if (!resolvedUrl) {
      const configuration = await this.configurationService.get();
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

    return { url, headers, source: useEnv ? 'environment' : 'database' };
  }

  private buildDownstreamPayload(document: IncomingDocumentDocument, extractedData: ExtractedValue[]) {
    return {
      documentId: document.id,
      fileName: document.originalName,
      category: document.category,
      documentTypeId: document.documentTypeId?.toString(),
      documentTypeName: document.documentTypeName,
      classificationScore: document.classificationScore,
      classificationMethod: document.classificationMethod,
      validatedAt: new Date().toISOString(),
      extractedData: extractedData.map((item) => ({
        key: item.key,
        label: item.label,
        type: item.type,
        value: item.value,
        confidence: item.confidence,
      })),
    };
  }

  private async sendToDownstream(document: IncomingDocumentDocument, extractedData: ExtractedValue[]) {
    const config = await this.getDownstreamConfig();
    if (!config) return;

    const payload = this.buildDownstreamPayload(document, extractedData);
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

  async validate(id: string, extractedData: ExtractedValue[], deleteAfterDownstream = false, downstreamUrl?: string) {
    const updated = await this.documentModel.findByIdAndUpdate(
      id,
      { extractedData, status: 'validated' },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Document not found');

    const downstreamConfig = await this.getDownstreamConfig(downstreamUrl);
    if (downstreamConfig) {
      try {
        await this.sendToDownstream(updated, extractedData);
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

  async reject(id: string) {
    const updated = await this.documentModel.findByIdAndUpdate(
      id,
      { status: 'rejected' },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Document not found');
    return updated;
  }

  async remove(id: string) {
    const document = await this.documentModel.findById(id);
    if (!document) throw new NotFoundException('Document not found');

    await this.documentModel.deleteOne({ _id: document._id });
    try {
      await unlink(document.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    return { deleted: true };
  }
}
