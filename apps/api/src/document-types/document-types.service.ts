import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { QueueServiceClient } from '@azure/storage-queue';
import { InjectModel } from '@nestjs/mongoose';
import { unlink } from 'fs/promises';
import { Model } from 'mongoose';
import { join } from 'path';
import { inferTemplateWithOpenAI } from '../openai-document-ai';
import { DocumentType, DocumentTypeDocument, ExtractionField, ReasoningEffort, TableColumn } from '../schemas/document-type.schema';
import { BlobStorageService, TRAIN_CONTAINER } from '../storage/blob-storage.service';
import { ConfigurationService } from '../configuration/configuration.service';

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
    private readonly configurationService: ConfigurationService,
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
      extractionModel: 'gpt-5-nano',
      extractionAiProvider: 'openai',
      extractionReasoningEffort: 'low',
      extractionVerification: false,
      includeInClassification: false,
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

    const updated = await this.model.findByIdAndUpdate(
      id,
      {
        $push: { sampleFiles: fileName },
        $set: {
          classifierTrainingStatus: 'untrained',
          classifierTrainingError: undefined,
        },
      },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Document type not found');
    return updated;
  }

  async removeSample(id: string, fileName: string) {
    const docType = await this.model.findById(id);
    if (!docType) throw new NotFoundException('Document type not found');
    if (!docType.sampleFiles.includes(fileName)) throw new NotFoundException('Sample file not found');

    await this.deleteSampleFile(fileName);
    docType.sampleFiles = docType.sampleFiles.filter((sampleFile) => sampleFile !== fileName);
    docType.classifierTrainingStatus = 'untrained';
    docType.classifierTrainingError = undefined;
    return docType.save();
  }

  async trainClassifier(trainedBy: string) {
    if (!this.hasQueueConnection()) {
      throw new BadRequestException('Classifier training requires Azure queue storage and the function worker.');
    }

    const includedTypes = await this.model.find({
      includeInClassification: true,
      finalized: true,
      'sampleFiles.0': { $exists: true },
    });
    if (!includedTypes.length) {
      throw new BadRequestException('Include at least one finalized document type with sample files before training the classifier.');
    }

    await this.model.updateMany(
      { _id: { $in: includedTypes.map((type) => type._id) } },
      { $set: { classifierTrainingStatus: 'training', classifierTrainingError: undefined } },
    );
    await this.model.updateMany(
      {
        includeInClassification: true,
        _id: { $nin: includedTypes.map((type) => type._id) },
      },
      { $set: { classifierTrainingStatus: 'untrained' } },
    );
    await this.enqueueClassifierTraining(trainedBy);
    return this.list();
  }

  async resetClassifierTrainingStatus() {
    await this.model.updateMany(
      {},
      {
        $set: { classifierTrainingStatus: 'untrained' },
        $unset: {
          classifierTrainingError: '',
          classifierTrainedAt: '',
          classifierTrainedBy: '',
        },
      },
    );
    return this.list();
  }

  async updateClassificationInclusion(id: string, includeInClassification: boolean) {
    const updated = await this.model.findByIdAndUpdate(
      id,
      {
        includeInClassification,
        classifierTrainingStatus: 'untrained',
        classifierTrainingError: undefined,
      },
      { new: true },
    );
    if (!updated) throw new NotFoundException('Document type not found');
    return updated;
  }

  async updateExtractionModel(
    id: string,
    payload: {
      extractionModel?: string;
      extractionAiProvider?: 'openai' | 'custom' | 'ollama';
      extractionReasoningEffort?: ReasoningEffort;
      extractionVerification?: boolean;
    },
  ) {
    const updates: {
      extractionModel: string;
      extractionAiProvider: 'openai' | 'custom' | 'ollama';
      extractionReasoningEffort: ReasoningEffort;
      extractionVerification?: boolean;
    } = {
      extractionModel: payload.extractionModel || 'gpt-5-nano',
      extractionAiProvider: ['openai', 'custom', 'ollama'].includes(payload.extractionAiProvider || '')
        ? payload.extractionAiProvider!
        : 'openai',
      extractionReasoningEffort: payload.extractionReasoningEffort || 'low',
    };
    if (typeof payload.extractionVerification === 'boolean') {
      updates.extractionVerification = payload.extractionVerification;
    }

    const updated = await this.model.findByIdAndUpdate(id, { $set: updates }, { new: true });
    if (!updated) throw new NotFoundException('Document type not found');
    return updated;
  }

  private hasQueueConnection() {
    return Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage);
  }

  private async enqueueClassifierTraining(trainedBy: string) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
    if (!connectionString) return;
    const queue = QueueServiceClient.fromConnectionString(connectionString).getQueueClient('classifier-training');
    await queue.createIfNotExists();
    await queue.sendMessage(Buffer.from(JSON.stringify({ trainAll: true, trainedBy })).toString('base64'));
  }

  async generateTemplate(id: string, prompt: string) {
    const docType = await this.model.findById(id);
    if (!docType) throw new NotFoundException('Document type not found');

    const latestSample = docType.sampleFiles.at(-1);
    const configuration = await this.configurationService.get();
    const extractionProvider = docType.extractionAiProvider || 'openai';
    const extractionApiKey = extractionProvider === 'custom'
      ? (configuration as any).customApiKey
      : (configuration as any).openAiApiKey;
    if (latestSample && (extractionProvider === 'ollama' || extractionApiKey)) {
      const samplePath = await this.resolveSamplePath(latestSample);
      try {
        const openAiFields = await inferTemplateWithOpenAI(
          samplePath,
          prompt,
          Boolean(configuration.useOcrForDocumentProcessing),
          {
            aiProvider: extractionProvider,
            model: docType.extractionModel,
            reasoningEffort: docType.extractionReasoningEffort,
            documentTextMode: configuration.documentTextMode,
            markdownServiceUrl: configuration.markdownServiceUrl,
            ollamaBaseUrl: configuration.ollamaBaseUrl,
            ollamaModel: extractionProvider === 'ollama' ? docType.extractionModel : configuration.ollamaModel,
            apiKey: extractionApiKey,
            llmEndpoint: (configuration as any).llmEndpoint,
          },
        );
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
