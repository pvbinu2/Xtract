import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { ExtractionField } from './schemas/document-type.schema';
import { ExtractedValue } from './schemas/incoming-document.schema';

type SchemaField = Pick<ExtractionField, 'key' | 'label' | 'type' | 'description' | 'selected' | 'columns'>;

let client: OpenAI | undefined;

function getClient() {
  if (!process.env.OPENAI_API_KEY) return undefined;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function modelName() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function pdfInput(filePath: string) {
  const data = readFileSync(filePath).toString('base64');
  return {
    type: 'input_file' as const,
    filename: basename(filePath),
    file_data: `data:application/pdf;base64,${data}`,
  };
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function fieldTypePrompt() {
  return 'Allowed field types are string, number, date, currency, boolean, and table.';
}

function toKey(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function defaultTableColumns(prompt: string): SchemaField['columns'] {
  const lower = prompt.toLowerCase();
  const columns: NonNullable<SchemaField['columns']> = [];

  if (lower.includes('description') || lower.includes('item') || lower.includes('product')) {
    columns.push({ key: 'description', label: 'Description', type: 'string', description: 'Line item description.' });
  }
  if (lower.includes('quantity') || lower.includes('qty')) {
    columns.push({ key: 'quantity', label: 'Quantity', type: 'number', description: 'Line item quantity.' });
  }
  if (lower.includes('unit price') || lower.includes('rate') || lower.includes('price')) {
    columns.push({ key: 'unit_price', label: 'Unit Price', type: 'currency', description: 'Line item unit price or rate.' });
  }
  if (lower.includes('amount') || lower.includes('total')) {
    columns.push({ key: 'amount', label: 'Amount', type: 'currency', description: 'Line item amount.' });
  }

  return columns.length
    ? columns
    : [
        { key: 'description', label: 'Description', type: 'string', description: 'Line item description.' },
        { key: 'quantity', label: 'Quantity', type: 'number', description: 'Line item quantity.' },
        { key: 'amount', label: 'Amount', type: 'currency', description: 'Line item amount.' },
      ];
}

function normalizeSchemaField(field: SchemaField, prompt: string): SchemaField {
  return {
    key: field.key || toKey(field.label),
    label: field.label,
    type: field.type,
    description: field.description || `Extract ${field.label} from the uploaded PDF.`,
    columns: field.type === 'table' ? field.columns?.length ? field.columns : defaultTableColumns(prompt) : [],
    selected: field.selected ?? true,
  };
}

export async function inferTemplateWithOpenAI(filePath: string, prompt: string): Promise<SchemaField[] | undefined> {
  const openai = getClient();
  if (!openai) return undefined;

  const response = await openai.responses.create({
    model: modelName(),
    input: [
      {
        role: 'user',
        content: [
          pdfInput(filePath),
          {
            type: 'input_text',
            text: [
              'Create an extraction schema for this PDF document type.',
              fieldTypePrompt(),
              'Use snake_case keys. Select fields that match the user prompt.',
              'For every field and table column, include a concise description that explains exactly what value should be extracted.',
              'When a field is a table, include its row columns in a columns array.',
              'For invoices, receipts, statements, purchase orders, or bills, identify line-item tables and include columns such as description, quantity, unit price, and amount when present.',
              'Return JSON only in this shape:',
              '{"fields":[{"key":"line_items","label":"Line Items","type":"table","description":"...","selected":true,"columns":[{"key":"description","label":"Description","type":"string","description":"..."}]}]}',
              `User prompt: ${prompt}`,
            ].join('\n'),
          },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
  });

  const parsed = parseJsonObject(response.output_text) as { fields?: SchemaField[] };
  return (parsed.fields || []).map((field) => normalizeSchemaField(field, prompt));
}

export async function extractValuesWithOpenAI(
  filePath: string,
  fields: SchemaField[],
  documentTypeName: string,
): Promise<ExtractedValue[] | undefined> {
  const openai = getClient();
  if (!openai) return undefined;

  const selectedFields = fields.filter((field) => field.selected);
  const response = await openai.responses.create({
    model: modelName(),
    input: [
      {
        role: 'user',
        content: [
          pdfInput(filePath),
          {
            type: 'input_text',
            text: [
              `Extract values from this ${documentTypeName} PDF.`,
              'Return JSON only. Do not include markdown.',
              'If a value is missing, return an empty string and low confidence.',
              'For table fields, return an array of row objects.',
              'Return this exact shape:',
              '{"fields":[{"key":"field_key","value":"extracted value","confidence":0.92}]}',
              `Schema: ${JSON.stringify(
                selectedFields.map((field) => ({
                  key: field.key,
                  label: field.label,
                  type: field.type,
                  description: field.description,
                  columns: field.type === 'table' ? field.columns || [] : undefined,
                })),
              )}`,
            ].join('\n'),
          },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
  });

  const parsed = parseJsonObject(response.output_text) as {
    fields?: Array<{ key: string; value: unknown; confidence?: number }>;
  };
  const byKey = new Map((parsed.fields || []).map((field) => [field.key, field]));

  return selectedFields.map((field) => {
    const extracted = byKey.get(field.key);
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      value: extracted?.value ?? '',
      confidence: typeof extracted?.confidence === 'number' ? extracted.confidence : undefined,
      boundingBoxes: [],
    };
  });
}
