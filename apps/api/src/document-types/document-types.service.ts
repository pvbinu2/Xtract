import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { join } from 'path';
import { inferTemplateWithOpenAI } from '../openai-document-ai';
import { DocumentType, DocumentTypeDocument, ExtractionField, TableColumn } from '../schemas/document-type.schema';

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
  constructor(@InjectModel(DocumentType.name) private readonly model: Model<DocumentTypeDocument>) {}

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
    return { deleted: true };
  }

  async addSample(id: string, fileName: string) {
    const updated = await this.model.findByIdAndUpdate(id, { $push: { sampleFiles: fileName } }, { new: true });
    if (!updated) throw new NotFoundException('Document type not found');
    return updated;
  }

  async generateTemplate(id: string, prompt: string) {
    const docType = await this.model.findById(id);
    if (!docType) throw new NotFoundException('Document type not found');

    const latestSample = docType.sampleFiles.at(-1);
    if (latestSample && process.env.OPENAI_API_KEY) {
      const samplePath = join(__dirname, '..', '..', 'uploads', latestSample);
      const openAiFields = await inferTemplateWithOpenAI(samplePath, prompt);
      if (openAiFields?.length) {
        docType.prompt = prompt;
        docType.fields = openAiFields;
        docType.finalized = false;
        return docType.save();
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
}
