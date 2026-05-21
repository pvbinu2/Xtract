import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { QueueServiceClient } from '@azure/storage-queue';
import { InjectModel } from '@nestjs/mongoose';
import { unlink } from 'fs/promises';
import { Model } from 'mongoose';
import { join } from 'path';
import { inferTemplateWithOpenAI } from '../openai-document-ai';
import { DocumentType, DocumentTypeDocument, ExtractionField, TableColumn } from '../schemas/document-type.schema';
import { BlobStorageService, TRAIN_CONTAINER } from '../storage/blob-storage.service';

function toKey(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function inferType(label: string) {
  const lower = label.toLowerCase();
  if (
    lower.includes('line item') ||
    lower.includes('line items') ||
    lower.includes('table') ||
    lower.includes('rows')
  ) {
    return 'table';
  }
  if (lower.includes('date')) return 'date';
  if (lower.includes('amount') || lower.includes('total') || lower.includes('price')) return 'currency';
  if (lower.includes('quantity') || lower.includes('count') || lower.includes('number')) return 'number';
  return 'string';
}

function defaultTableColumns(prompt: string): TableColumn[] {
  const lower = prompt.toLowerCase();
  const columns: TableColumn[] = [];

  if (lower.includes('description') || lower.includes('item') || lower.includes('product')) {
    columns.push({
      key: 'description',
      label: 'Description',
      type: 'string',
      description: 'Line item description.',
    });
  }
  if (lower.includes('quantity') || lower.includes('qty')) {
    columns.push({
      key: 'quantity',
      label: 'Quantity',
      type: 'number',
      description: 'Line item quantity.',
    });
  }
  if (lower.includes('unit price') || lower.includes('rate') || lower.includes('price')) {
    columns.push({
      key: 'unit_price',
      label: 'Unit Price',
      type: 'currency',
      description: 'Line item unit price or rate.',
    });
  }
  if (lower.includes('amount') || lower.includes('total')) {
    columns.push({
      key: 'amount',
      label: 'Amount',
      type: 'currency',
      description: 'Line item amount.',
    });
  }

  return columns.length
    ? columns
    : [
        { key: 'description', label: 'Description', type: 'string', description: 'Line item description.' },
        { key: 'quantity', label: 'Quantity', type: 'number', description: 'Line item quantity.' },
        { key: 'amount', label: 'Amount', type: 'currency', description: 'Line item amount.' },
      ];
}

function normalizeField(field: ExtractionField, prompt: string): ExtractionField {
  return {
    ...field,
    key: field.key || toKey(field.label),
    columns: field.type === 'table' ? field.columns?.length ? field.columns : defaultTableColumns(prompt) : [],
  };
}

@Injectable()
export class DocumentTypesService {
  constructor(
    @InjectModel(DocumentType.name) private readonly model: Model<DocumentTypeDocument>,
    private readonly blobStorage: BlobStorageService,
  ) {}

  async list() {
    return this.model.find().sort({ category: 1, name: 1 }).lean();
  }

  async create(payload: { category: string; name: string; prompt?: string }) {
    return this.model.create({
      category: payload.category,
      name: payload.name,
      prompt: payload.prompt ?? '',
      fields: [],
      finalized: false,
    });
  }

  async remove(id: string) {
    const result = await this.model.findByIdAndDelete(id);
    if (!result) throw new NotFoundException('Document type not found');
    await Promise.all((result.sampleFiles || []).map((sampleFile) => this.deleteSampleFile(sampleFile)));
    return { deleted: true };
  }

  async addSample(id: string, file: Express.Multer.File) {
    const docType = await this.model.findById(id);
    if (!docType) throw new NotFoundException('Document type not found');

    const fileName = this.blobStorage.createBlobName(file.originalname, docType.name);
    await this.blobStorage.uploadBuffer(TRAIN_CONTAINER, fileName, file.buffer, file.mimetype);

    const canQueueTraining = this.hasQueueConnection();
    const updated = await this.model.findByIdAndUpdate(
      id,
      {
        $push: { sampleFiles: fileName },
        $set: {
          classifierTrainingStatus: canQueueTraining ? 'training' : 'untrained',
          classifierTrainingError: canQueueTraining ? undefined : 'Classifier training queue is not configured.',
        },
      },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Document type not found');
    if (canQueueTraining) await this.enqueueClassifierTraining(updated.id, fileName);
    return updated;
  }

  async trainClassifier(id: string) {
    if (!this.hasQueueConnection()) {
      throw new BadRequestException('Classifier training requires Azure queue storage and the function worker.');
    }

    const docType = await this.model.findById(id);
    if (!docType) throw new NotFoundException('Document type not found');

    const sampleFileName = docType.sampleFiles.at(-1);
    if (!sampleFileName) {
      throw new BadRequestException('Upload at least one sample document before training the classifier.');
    }

    docType.classifierTrainingStatus = 'training';
    docType.classifierTrainingError = undefined;
    await docType.save();
    await this.enqueueClassifierTraining(docType.id, sampleFileName);
    return docType;
  }

  private hasQueueConnection() {
    return Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage);
  }

  private async enqueueClassifierTraining(documentTypeId: string, sampleFileName: string) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
    if (!connectionString) return;
    const queue = QueueServiceClient.fromConnectionString(connectionString).getQueueClient('classifier-training');
    await queue.createIfNotExists();
    await queue.sendMessage(Buffer.from(JSON.stringify({ documentTypeId, sampleFileName })).toString('base64'));
  }

  async generateTemplate(id: string, prompt: string) {
    const docType = await this.model.findById(id);
    if (!docType) throw new NotFoundException('Document type not found');

    const latestSample = docType.sampleFiles.at(-1);
    if (latestSample && process.env.OPENAI_API_KEY) {
      const samplePath = await this.resolveSamplePath(latestSample);
      try {
        const openAiFields = await inferTemplateWithOpenAI(samplePath, prompt);
        if (openAiFields?.length) {
          docType.prompt = prompt;
          docType.fields = openAiFields;
          docType.finalized = false;
          return docType.save();
        }
      } finally {
        if (this.blobStorage.isConfigured()) await this.blobStorage.removeTempFile(samplePath);
      }
    }

    const fromPrompt = prompt
      .split(/[\n,.;]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.replace(/^(extract|capture|find|get)\s+/i, ''));

    const fallback = ['Document Number', 'Document Date', 'Vendor Name', 'Total Amount'];
    const labels = Array.from(new Set(fromPrompt.length ? fromPrompt : fallback));
    const fields: ExtractionField[] = labels.map((label) => normalizeField({
      key: toKey(label),
      label,
      type: inferType(label),
      description: `Extract ${label} from the uploaded PDF.`,
      columns: [],
      selected: true,
    }, prompt));

    const hasTable = fields.some((field) => field.type === 'table');
    const promptLooksTabular = /line\s*items?|items?|table|rows?|particulars|products?|services?/i.test(prompt);
    if (!hasTable && promptLooksTabular) {
      fields.push({
        key: 'line_items',
        label: 'Line Items',
        type: 'table',
        description: 'Extract each row from the document line item table.',
        columns: defaultTableColumns(prompt),
        selected: true,
      });
    }

    docType.prompt = prompt;
    docType.fields = fields;
    docType.finalized = false;
    return docType.save();
  }

  async finalize(id: string, fields: ExtractionField[]) {
    const updated = await this.model.findByIdAndUpdate(id, { fields, finalized: true }, { new: true });
    if (!updated) throw new NotFoundException('Document type not found');
    return updated;
  }

  async findById(id: string) {
    const docType = await this.model.findById(id);
    if (!docType) throw new NotFoundException('Document type not found');
    return docType;
  }

  private async resolveSamplePath(fileName: string) {
    if (this.blobStorage.isConfigured()) return this.blobStorage.downloadToTemp(TRAIN_CONTAINER, fileName);
    return join(__dirname, '..', '..', 'uploads', fileName);
  }

  private async deleteSampleFile(fileName: string) {
    if (this.blobStorage.isConfigured()) {
      await this.blobStorage.deleteBlob(TRAIN_CONTAINER, fileName);
      return;
    }

    try {
      await unlink(join(__dirname, '..', '..', 'uploads', fileName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
