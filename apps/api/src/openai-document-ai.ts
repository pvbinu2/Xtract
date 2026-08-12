import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { ExtractionField } from './schemas/document-type.schema';
import { ExtractedValue } from './schemas/incoming-document.schema';
import { DocumentTextMode, extractDocumentText } from './document-text';

type SchemaField = Pick<ExtractionField, 'key' | 'label' | 'type' | 'description' | 'selected' | 'columns'>;
type ProcessingMetrics = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  extractionCostUsd?: number;
  classificationCostUsd?: number;
  embeddingCostUsd?: number;
  processedAt: Date;
};
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
type AiProvider = 'openai' | 'custom' | 'ollama';
type OpenAIRequestOptions = {
  aiProvider?: AiProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  documentTextMode?: DocumentTextMode;
  markdownServiceUrl?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  apiKey?: string;
  llmEndpoint?: string;
};
type OpenAIRequestConfig = {
  model: string;
  reasoning?: { effort: string };
};
type AiJsonResponse = {
  outputText: string;
  raw: unknown;
  model: string;
};

function getClient(options?: OpenAIRequestOptions) {
  if (!options?.apiKey) return undefined;
  return new OpenAI({
    apiKey: options.apiKey,
    ...(options.aiProvider === 'custom' && options.llmEndpoint ? { baseURL: options.llmEndpoint } : {}),
  });
}

function modelName() {
  return 'gpt-5-nano';
}

function providerName(options?: OpenAIRequestOptions): AiProvider {
  return options?.aiProvider === 'ollama' ? 'ollama' : 'openai';
}

function ollamaModelName(options?: OpenAIRequestOptions) {
  return options?.ollamaModel || 'llama3.2';
}

function ollamaBaseUrl(options?: OpenAIRequestOptions) {
  return (options?.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

function supportsReasoningEffort(model: string) {
  return /^(gpt-5|o\d|o\d-)/.test(model);
}

function openAIRequestConfig(options?: OpenAIRequestOptions): OpenAIRequestConfig {
  const model = providerName(options) === 'ollama' ? ollamaModelName(options) : options?.model || modelName();
  return {
    model,
    ...(options?.reasoningEffort && supportsReasoningEffort(model)
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
  };
}

function isConfigured(options?: OpenAIRequestOptions) {
  return providerName(options) === 'ollama' || Boolean(options?.apiKey);
}

const modelPricingUsdPerMillion: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-5.6-sol': { input: 5.00, output: 30.00 },
  'gpt-5.6-terra': { input: 2.00, output: 12.00 },
  'gpt-5.6-luna': { input: 0.20, output: 1.20 },
  'gpt-5': { input: 1.25, output: 10.00 },
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'gpt-5-nano': { input: 0.05, output: 0.40 },
};

function pricingForModel(model: string) {
  const configuredInput = Number(process.env.OPENAI_INPUT_COST_PER_1M_TOKENS);
  const configuredOutput = Number(process.env.OPENAI_OUTPUT_COST_PER_1M_TOKENS);
  if (Number.isFinite(configuredInput) && Number.isFinite(configuredOutput)) {
    return { input: configuredInput, output: configuredOutput };
  }

  return modelPricingUsdPerMillion[model] || { input: 0, output: 0 };
}

function tokenUsageFromResponse(response: unknown) {
  const usage = (response as { usage?: Record<string, unknown> })?.usage || {};
  const ollamaUsage = response as { prompt_eval_count?: unknown; eval_count?: unknown };
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? ollamaUsage.prompt_eval_count ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? ollamaUsage.eval_count ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

function processingMetricsFromResponse(response: unknown, model: string): ProcessingMetrics {
  const tokens = tokenUsageFromResponse(response);
  const pricing = pricingForModel(model);
  const estimatedCostUsd =
    (tokens.inputTokens / 1_000_000) * pricing.input +
    (tokens.outputTokens / 1_000_000) * pricing.output;

  return {
    model,
    ...tokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
    processedAt: new Date(),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerValue(error: unknown, key: string) {
  const headers = (error as { headers?: Headers | Record<string, string> })?.headers;
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(key) ?? undefined;
  return (headers as Record<string, string>)[key];
}

function retryDelayFromError(error: unknown, attempt: number) {
  const retryAfterMs = headerValue(error, 'retry-after-ms');
  if (retryAfterMs && Number.isFinite(Number(retryAfterMs))) return Number(retryAfterMs);

  const retryAfter = headerValue(error, 'retry-after');
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Number(retryAfter) * 1000;

  const message = (error as Error)?.message || String(error);
  const msMatch = message.match(/try again in\s+(\d+)ms/i);
  if (msMatch) return Number(msMatch[1]);

  const secondMatch = message.match(/try again in\s+([\d.]+)s/i);
  if (secondMatch) return Number(secondMatch[1]) * 1000;

  return Math.min(30000, 1000 * 2 ** attempt);
}

function isRetryableOpenAIError(error: unknown) {
  const status = (error as { status?: number; code?: number })?.status || (error as { status?: number; code?: number })?.code;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function withOpenAIRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = Number(process.env.OPENAI_MAX_RETRIES || 8);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableOpenAIError(error) || attempt === maxAttempts - 1) throw error;
      const jitter = Math.floor(Math.random() * 250);
      await sleep(retryDelayFromError(error, attempt) + jitter);
    }
  }

  throw lastError;
}

async function withAIRetry<T>(operation: () => Promise<T>, options?: OpenAIRequestOptions): Promise<T> {
  if (providerName(options) === 'openai') return withOpenAIRetry(operation);
  return operation();
}

function textContent(parts: Array<string | undefined>) {
  return parts.filter(Boolean).join('\n');
}

async function createJsonResponse(
  content: Array<Record<string, unknown>>,
  options?: OpenAIRequestOptions,
): Promise<AiJsonResponse> {
  if (providerName(options) === 'ollama') {
    const model = ollamaModelName(options);
    const response = await fetch(`${ollamaBaseUrl(options)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'user',
            content: content
              .map((item) => typeof item.text === 'string' ? item.text : '')
              .filter(Boolean)
              .join('\n'),
          },
        ],
      }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${message || response.statusText}`);
    }
    const payload = await response.json() as { message?: { content?: string }; response?: string; model?: string };
    return {
      outputText: payload.message?.content || payload.response || '',
      raw: payload,
      model: payload.model || model,
    };
  }

  const openai = getClient(options);
  if (!openai) throw new Error('An API key is required for the selected AI provider.');
  const requestConfig = openAIRequestConfig(options);
  const response = await withOpenAIRetry(() => openai.responses.create({
    ...requestConfig,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_object' } },
  } as any));
  return {
    outputText: response.output_text,
    raw: response,
    model: requestConfig.model,
  };
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function pdfInput(filePath: string) {
  const data = readFileSync(filePath).toString('base64');
  return {
    type: 'input_file' as const,
    filename: basename(filePath),
    file_data: `data:application/pdf;base64,${data}`,
  };
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

function normalizedName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function coerceTableRowsToSchema(value: unknown, columns: SchemaField['columns']) {
  const schemaColumns = columns || [];
  if (!schemaColumns.length) return Array.isArray(value) ? value : [];

  const rows = Array.isArray(value) ? value : [];
  return rows.map((row) => {
    const rowObject = row && typeof row === 'object' && !Array.isArray(row)
      ? row as Record<string, unknown>
      : { [schemaColumns[0].key]: row };
    const aliases = new Map<string, unknown>();

    Object.entries(rowObject).forEach(([key, rowValue]) => {
      aliases.set(key, rowValue);
      aliases.set(normalizedName(key), rowValue);
    });

    if (typeof rowObject.key === 'string' && Object.prototype.hasOwnProperty.call(rowObject, 'value')) {
      aliases.set(rowObject.key, rowObject.value);
      aliases.set(normalizedName(rowObject.key), rowObject.value);
    }

    return Object.fromEntries(schemaColumns.map((column) => [
      column.key,
      aliases.get(column.key) ??
      aliases.get(normalizedName(column.key)) ??
      aliases.get(normalizedName(column.label)) ??
      '',
    ]));
  });
}

export async function inferTemplateWithOpenAI(
  filePath: string,
  prompt: string,
  useOcr = false,
  options?: OpenAIRequestOptions,
): Promise<SchemaField[] | undefined> {
  if (!isConfigured(options)) return undefined;
  const textMode = options?.documentTextMode === 'markdown' ? 'markdown' : 'ocr';
  const useDocumentText = useOcr || providerName(options) === 'ollama';
  const documentText = useDocumentText ? await extractDocumentText(filePath, undefined, {
    mode: textMode,
    markdownServiceUrl: options?.markdownServiceUrl,
  }) : '';
  const textSourceLabel = textMode === 'markdown' ? 'Docling markdown' : 'locally extracted OCR/text';

  const content = [
    ...(useDocumentText && providerName(options) === 'openai' ? [] : providerName(options) === 'openai' ? [pdfInput(filePath)] : []),
    {
      type: 'input_text',
      text: textContent([
        useDocumentText
          ? `Create an extraction schema for this document type using the ${textSourceLabel} below.`
          : 'Create an extraction schema for this PDF document type.',
        fieldTypePrompt(),
        'Use snake_case keys. Select fields that match the user prompt.',
        'For every field and table column, include a concise description that explains exactly what value should be extracted.',
        'When a field is a table, include its row columns in a columns array.',
        'For invoices, receipts, statements, purchase orders, or bills, identify line-item tables and include columns such as description, quantity, unit price, and amount when present.',
        'Return JSON only in this shape:',
        '{"fields":[{"key":"line_items","label":"Line Items","type":"table","description":"...","selected":true,"columns":[{"key":"description","label":"Description","type":"string","description":"..."}]}]}',
        `User prompt: ${prompt}`,
        useDocumentText ? `Document text:\n${documentText}` : '',
      ]),
    },
  ];
  const response = await withAIRetry(() => createJsonResponse(content, options), options);

  const parsed = parseJsonObject(response.outputText) as { fields?: SchemaField[] };
  return (parsed.fields || []).map((field) => normalizeSchemaField(field, prompt));
}

export async function extractValuesWithOpenAI(
  filePath: string,
  fields: SchemaField[],
  documentTypeName: string,
  useOcr = false,
  options?: OpenAIRequestOptions,
): Promise<{ values: ExtractedValue[]; metrics: ProcessingMetrics } | undefined> {
  if (!isConfigured(options)) return undefined;

  const selectedFields = fields.filter((field) => field.selected);
  const textMode = options?.documentTextMode === 'markdown' ? 'markdown' : 'ocr';
  const useDocumentText = useOcr || providerName(options) === 'ollama';
  const documentText = useDocumentText ? await extractDocumentText(filePath, undefined, {
    mode: textMode,
    markdownServiceUrl: options?.markdownServiceUrl,
  }) : '';
  const textSourceLabel = textMode === 'markdown' ? 'Docling markdown' : 'locally extracted OCR/text';
  const content = [
    ...(useDocumentText && providerName(options) === 'openai' ? [] : providerName(options) === 'openai' ? [pdfInput(filePath)] : []),
    {
      type: 'input_text',
      text: textContent([
        useDocumentText
          ? `Extract values from this ${documentTypeName} document using the ${textSourceLabel} below.`
          : `Extract values from this ${documentTypeName} PDF.`,
        'Return JSON only. Do not include markdown.',
        'If a value is missing, return an empty string and low confidence.',
        'For table fields, return an array of row objects. Each row object must contain only the column keys defined for that table in the schema.',
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
        useDocumentText ? `Document text:\n${documentText}` : '',
      ]),
    },
  ];

  const response = await withAIRetry(() => createJsonResponse(content, options), options);

  const parsed = parseJsonObject(response.outputText) as {
    fields?: Array<{ key: string; value: unknown; confidence?: number }>;
  };
  const byKey = new Map((parsed.fields || []).map((field) => [field.key, field]));

  const values = selectedFields.map((field) => {
    const extracted = byKey.get(field.key);
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      value: field.type === 'table'
        ? coerceTableRowsToSchema(extracted?.value, field.columns)
        : extracted?.value ?? '',
      confidence: typeof extracted?.confidence === 'number' ? extracted.confidence : undefined,
      boundingBoxes: [],
    };
  });

  return {
    values,
    metrics: processingMetricsFromResponse(response.raw, response.model),
  };
}
