const { app, output } = require('@azure/functions');
const { withExtractionConcurrency } = require('../aiConcurrency');
const { withFunctionLogging } = require('../functionLogger');
const { publishDocumentChanged } = require('../documentEvents');
const { getConfiguration } = require('../configurationCache');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const OpenAI = require('openai');
const { attachBoundingBoxes } = require('../pdfBoundingBox');
const { isExcelDocument, parseWorkbook } = require('../workbook');
const { extractDocumentContent, extractDocumentSpatialItems, extractDocumentText } = require('../documentText');
const { withOpenAIRetry } = require('../openaiRetry');
const { extractChunkedDocument } = require('../chunkedExtraction');
const { shouldRouteToChunkExtraction } = require('../chunkRouting');
const {
  ObjectId,
  getClient,
  hasResolvableDocumentFile,
  markDocumentFailed,
  normalizeDocumentTypeId,
  processingOptionsFor,
  extractedDataUpdate,
  recordBusinessReviewProcessing,
  removeTempFile,
  resolveDocumentFile,
  resolvePreparedDocumentText,
  resolveMessage,
  transitionDocumentStatus,
} = require('../documentProcessingCommon');

const chunkExtractionOutput = output.serviceBusQueue({
  queueName: 'document-chunk-extraction',
  connection: 'ServiceBusConnection',
});

function getOpenAI(options = {}) {
  if (!options.apiKey) return undefined;
  return new OpenAI({
    apiKey: options.apiKey,
    ...(options.aiProvider === 'custom' && options.llmEndpoint ? { baseURL: options.llmEndpoint } : {}),
  });
}

function modelName() {
  return 'gpt-5-nano';
}

function providerName(options = {}) {
  return options.aiProvider === 'ollama' ? 'ollama' : 'openai';
}

function ollamaModelName(options = {}) {
  return options.ollamaModel || 'llama3.2';
}

function ollamaBaseUrl(options = {}) {
  return (options.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

function supportsReasoningEffort(model) {
  return /^(gpt-5|o\d|o\d-)/.test(model);
}

function openAIRequestConfig(options = {}) {
  const model = providerName(options) === 'ollama' ? ollamaModelName(options) : options.model || modelName();
  return {
    model,
    ...(options.reasoningEffort && supportsReasoningEffort(model)
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
  };
}

async function createJsonResponse(content, options = {}, label = 'AI request') {
  if (providerName(options) === 'ollama') {
    const model = ollamaModelName(options);
    const response = await fetch(`${ollamaBaseUrl(options)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [{
          role: 'user',
          content: content.map((item) => typeof item.text === 'string' ? item.text : '').filter(Boolean).join('\n'),
        }],
      }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${message || response.statusText}`);
    }
    const payload = await response.json();
    return {
      outputText: payload?.message?.content || payload?.response || '',
      raw: payload,
      model: payload?.model || model,
    };
  }

  const client = getOpenAI(options);
  if (!client) return undefined;
  const requestConfig = openAIRequestConfig(options);
  const response = await withOpenAIRetry(() => client.responses.create({
    ...requestConfig,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_object' } },
  }), label);
  return {
    outputText: response.output_text,
    raw: response,
    model: requestConfig.model,
  };
}

const modelPricingUsdPerMillion = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-6-astra': { input: 10.00, output: 50.00 },
  'gpt-6.1-sol': { input: 2.00, output: 10.00 },
  'gpt-6.1-terra': { input: 1.00, output: 5.00 },
  'gpt-6-sol': { input: 2.00, output: 10.00 },
  'gpt-6-luna': { input: 0.10, output: 0.50 },
  'gpt-5.6-sol': { input: 4.00, output: 20.00 },
  'gpt-5.6-terra': { input: 2.00, output: 12.00 },
  'gpt-5.6-luna': { input: 0.20, output: 1.20 },
  'gpt-5.5': { input: 5.00, output: 30.00 },
  'gpt-5.4': { input: 2.50, output: 15.00 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25 },
  'gpt-5.2': { input: 1.75, output: 14.00 },
  'gpt-5.1': { input: 1.25, output: 10.00 },
  'o3': { input: 2.00, output: 8.00 },
  'gpt-5': { input: 1.25, output: 10.00 },
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'gpt-5-nano': { input: 0.05, output: 0.40 },
};

function pricingForModel(model) {
  const configuredInput = Number(process.env.OPENAI_INPUT_COST_PER_1M_TOKENS);
  const configuredOutput = Number(process.env.OPENAI_OUTPUT_COST_PER_1M_TOKENS);
  if (Number.isFinite(configuredInput) && Number.isFinite(configuredOutput)) {
    return { input: configuredInput, output: configuredOutput };
  }

  return modelPricingUsdPerMillion[model] || { input: 0, output: 0 };
}

function tokenUsageFromResponse(response) {
  const usage = response?.usage || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? response?.prompt_eval_count ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? response?.eval_count ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

function processingMetricsFromResponse(response, model) {
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

function parseJsonObject(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('The model returned invalid JSON.', { cause: error });
  }
}

function normalizedName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function coerceTableRowsToSchema(value, columns = []) {
  if (!columns.length) return Array.isArray(value) ? value : [];

  const rows = Array.isArray(value) ? value : [];
  return rows.map((row) => {
    const rowObject = row && typeof row === 'object' && !Array.isArray(row)
      ? row
      : { [columns[0].key]: row };
    const aliases = new Map();

    Object.entries(rowObject).forEach(([key, rowValue]) => {
      aliases.set(key, rowValue);
      aliases.set(normalizedName(key), rowValue);
    });

    if (typeof rowObject.key === 'string' && Object.prototype.hasOwnProperty.call(rowObject, 'value')) {
      aliases.set(rowObject.key, rowObject.value);
      aliases.set(normalizedName(rowObject.key), rowObject.value);
    }

    return Object.fromEntries(columns.map((column) => [
      column.key,
      aliases.get(column.key) ??
      aliases.get(normalizedName(column.key)) ??
      aliases.get(normalizedName(column.label)) ??
      '',
    ]));
  });
}

function schemaForFields(fields) {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    description: field.description,
    columns: field.type === 'table' ? field.columns || [] : undefined,
  }));
}

function valuesFromParsedFields(fields, selectedFields) {
  const byKey = new Map((fields || []).map((field) => [field.key, field]));
  return selectedFields.map((field) => {
    const extracted = byKey.get(field.key);
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      value: field.type === 'table'
        ? coerceTableRowsToSchema(extracted?.value, field.columns || [])
        : extracted?.value ?? '',
      confidence: typeof extracted?.confidence === 'number' ? extracted.confidence : undefined,
    };
  });
}

function combineMetrics(primary, additional) {
  if (!additional) return primary;
  return {
    ...primary,
    inputTokens: Number(primary.inputTokens || 0) + Number(additional.inputTokens || 0),
    outputTokens: Number(primary.outputTokens || 0) + Number(additional.outputTokens || 0),
    totalTokens: Number(primary.totalTokens || 0) + Number(additional.totalTokens || 0),
    estimatedCostUsd: Number((Number(primary.estimatedCostUsd || 0) + Number(additional.estimatedCostUsd || 0)).toFixed(8)),
    processedAt: new Date(),
  };
}

function pdfInput(filePath) {
  const data = fs.readFileSync(filePath).toString('base64');
  return {
    type: 'input_file',
    filename: path.basename(filePath),
    file_data: `data:application/pdf;base64,${data}`,
  };
}

async function verifyExtractionWithOpenAI({
  aiOptions,
  document,
  documentType,
  selectedFields,
  values,
  useOcr,
  documentText,
  textSourceLabel,
}) {
  const useDocumentText = useOcr || providerName(aiOptions) === 'ollama';
  const content = [
    ...(useDocumentText || providerName(aiOptions) === 'ollama' ? [] : [pdfInput(document.filePath)]),
    {
      type: 'input_text',
      text: [
        useDocumentText
          ? `Verify extracted values from this ${documentType.name} document using the ${textSourceLabel} below.`
          : `Verify extracted values from this ${documentType.name} PDF.`,
        'Compare the extracted data against the document content and schema.',
        'Return JSON only. Do not include markdown.',
        'Set needsCorrection to true only when a value is missing, incorrect, assigned to the wrong field, or a table row/column is inconsistent with the document.',
        'Return this exact shape:',
        '{"needsCorrection":true,"issues":[{"key":"field_key","problem":"brief issue"}]}',
        `Schema: ${JSON.stringify(schemaForFields(selectedFields))}`,
        `Extracted data: ${JSON.stringify(values)}`,
        useDocumentText ? `Document text:\n${documentText}` : '',
      ].join('\n'),
    },
  ];
  const response = await createJsonResponse(content, aiOptions, `Extraction verification for document ${document._id || document.fileName}`);

  const parsed = parseJsonObject(response.outputText);
  return {
    needsCorrection: Boolean(parsed.needsCorrection),
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    metrics: processingMetricsFromResponse(response.raw, response.model),
  };
}

async function correctExtractionWithOpenAI({
  aiOptions,
  document,
  documentType,
  selectedFields,
  values,
  issues,
  useOcr,
  documentText,
  textSourceLabel,
}) {
  const useDocumentText = useOcr || providerName(aiOptions) === 'ollama';
  const content = [
    ...(useDocumentText || providerName(aiOptions) === 'ollama' ? [] : [pdfInput(document.filePath)]),
    {
      type: 'input_text',
      text: [
        useDocumentText
          ? `Correct extracted values from this ${documentType.name} document using the ${textSourceLabel} below.`
          : `Correct extracted values from this ${documentType.name} PDF.`,
        'The verification pass found issues in the extracted data.',
        'Return one corrected full extraction result for every schema field.',
        'Return JSON only. Do not include markdown.',
        'If a value is missing, return an empty string and low confidence.',
        'For table fields, return an array of row objects. Each row object must contain only the column keys defined for that table in the schema.',
        'Return this exact shape:',
        '{"fields":[{"key":"field_key","value":"corrected value","confidence":0.92}]}',
        `Schema: ${JSON.stringify(schemaForFields(selectedFields))}`,
        `Verification issues: ${JSON.stringify(issues)}`,
        `Original extracted data: ${JSON.stringify(values)}`,
        useDocumentText ? `Document text:\n${documentText}` : '',
      ].join('\n'),
    },
  ];
  const response = await createJsonResponse(content, aiOptions, `Extraction correction for document ${document._id || document.fileName}`);

  const parsed = parseJsonObject(response.outputText);
  return {
    values: valuesFromParsedFields(parsed.fields || [], selectedFields),
    metrics: processingMetricsFromResponse(response.raw, response.model),
  };
}

async function extractValuesWithOpenAI(document, documentType, useOcr = false, textOptions = {}, aiOptions = {}) {
  if (providerName(aiOptions) !== 'ollama' && !getOpenAI(aiOptions)) return undefined;

  const selectedFields = (documentType.fields || []).filter((field) => field.selected);
  const textMode = textOptions.mode === 'markdown' ? 'markdown' : 'ocr';
  const useDocumentText = typeof textOptions.preparedText === 'string' || useOcr || providerName(aiOptions) === 'ollama';
  const documentContent = typeof textOptions.preparedText === 'string'
    ? { text: textOptions.preparedText, spatialItems: [] }
    : useDocumentText
      ? await extractDocumentContent(document.filePath, undefined, {
        mode: textMode,
        markdownServiceUrl: textOptions.markdownServiceUrl,
        documentId: String(document._id),
        fileName: document.originalName || document.fileName,
      })
      : { text: '', spatialItems: [] };
  const documentText = documentContent.text;
  const textSourceLabel = textMode === 'markdown' ? 'Docling markdown' : 'locally extracted OCR/text';
  const requestConfig = openAIRequestConfig({
    model: documentType.extractionModel,
    reasoningEffort: documentType.extractionReasoningEffort,
    aiProvider: aiOptions.aiProvider,
    ollamaBaseUrl: aiOptions.ollamaBaseUrl,
    ollamaModel: aiOptions.ollamaModel,
  });
  const content = [
    ...(useDocumentText || providerName(aiOptions) === 'ollama' ? [] : [pdfInput(document.filePath)]),
    {
      type: 'input_text',
      text: [
        useDocumentText
          ? `Extract values from this ${documentType.name} document using the ${textSourceLabel} below.`
          : `Extract values from this ${documentType.name} PDF.`,
        'Return JSON only. Do not include markdown.',
        'If a value is missing, return an empty string and low confidence.',
        'For table fields, return an array of row objects. Each row object must contain only the column keys defined for that table in the schema.',
        'Return this exact shape:',
        '{"fields":[{"key":"field_key","value":"extracted value","confidence":0.92}]}',
        `Schema: ${JSON.stringify(schemaForFields(selectedFields))}`,
        useDocumentText ? `Document text:\n${documentText}` : '',
      ].join('\n'),
    },
  ];
  const response = await createJsonResponse(content, { ...aiOptions, model: requestConfig.model }, `Extraction for document ${document._id || document.fileName}`);

  const parsed = parseJsonObject(response.outputText);
  let values = valuesFromParsedFields(parsed.fields || [], selectedFields);
  let metrics = processingMetricsFromResponse(response.raw, response.model);

  if (documentType.extractionVerification) {
    const verification = await verifyExtractionWithOpenAI({
      aiOptions: { ...aiOptions, model: requestConfig.model },
      document,
      documentType,
      selectedFields,
      values,
      useOcr: useDocumentText,
      documentText,
      textSourceLabel,
    });
    metrics = combineMetrics(metrics, verification.metrics);

    if (verification.needsCorrection) {
      const correction = await correctExtractionWithOpenAI({
        aiOptions: { ...aiOptions, model: requestConfig.model },
        document,
        documentType,
        selectedFields,
        values,
        issues: verification.issues,
        useOcr: useDocumentText,
        documentText,
        textSourceLabel,
      });
      values = correction.values;
      metrics = combineMetrics(metrics, correction.metrics);
    }
  }

  // Prefer OCR positions in markdown mode and retain Docling positions as a fallback.
  const ocrSpatialItems = !isExcelDocument(document) && (textMode === 'markdown' || !documentContent.spatialItems.length)
    ? await extractDocumentSpatialItems(document.filePath)
    : [];
  return {
    values,
    metrics,
    spatialItems: [...ocrSpatialItems, ...documentContent.spatialItems],
  };
}

async function extractChunkField(document, documentType, field, chunk, aiOptions, textSourceLabel) {
  const schema = JSON.stringify(schemaForFields([field]));
  if (schema.length > 12000) throw new Error(`Schema for ${field.key} exceeds the chunk extraction limit.`);
  const shape = field.type === 'table'
    ? '{"value":[{"value":{"column_key":"value"},"evidence":"exact source text for this row"}],"confidence":0.9}'
    : '{"value":"extracted value","evidence":"exact source text supporting the value","confidence":0.9}';
  const prompt = [
    `Extract ${field.label} from this part of a ${documentType.name} document.`,
    'Return JSON only. Extract only values found in the target chunk; surrounding context is for interpretation only.',
    'Evidence must be an exact, contiguous quote from the target chunk, not a paraphrase.',
    field.type === 'table'
      ? 'Return every table data row in this chunk in document order, excluding headers and separator lines. Use only the column keys in the schema. Return an empty array if no rows are present.'
      : 'Return an empty string if the value is absent. Do not infer missing values.',
    ...(field.type === 'table' && chunk.tableHeader
      ? [`Previous table header for context only; do not extract it as a row:\n${chunk.tableHeader}`]
      : []),
    ...(field.type !== 'table' && chunk.contextBefore
      ? [`Context before the target chunk:\n${chunk.contextBefore}`] : []),
    ...(field.type !== 'table' && chunk.contextAfter
      ? [`Context after the target chunk:\n${chunk.contextAfter}`] : []),
    `Return this shape: ${shape}`,
    `Schema: ${schema}`,
    `Target chunk:\n${chunk.text}`,
  ].join('\n');

  async function request(issues, previous) {
    const correction = issues ? `\nVerification issues: ${JSON.stringify(issues)}\nPrevious extraction: ${JSON.stringify(previous)}\nCorrect the result using only the chunk and provide exact evidence.` : '';
    if (prompt.length + correction.length > 24000) throw new Error(`Chunk extraction prompt for ${field.key} exceeds the request budget.`);
    const response = await createJsonResponse(
      [{ type: 'input_text', text: prompt + correction }],
      aiOptions,
      `Chunk extraction for document ${document._id || document.fileName}`,
    );
    if (!response) throw new Error('An AI provider must be configured for chunked extraction.');
    const parsed = parseJsonObject(response.outputText);
    if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) throw new Error(`Missing value in chunk response for ${field.key}.`);
    if (field.type === 'table') {
      if (!Array.isArray(parsed.value)) throw new Error(`Invalid table response for ${field.key}.`);
      parsed.value = parsed.value.map((row) => {
        if (!row || typeof row.value !== 'object' || row.value === null || Array.isArray(row.value)) {
          throw new Error(`Invalid table row in chunk response for ${field.key}.`);
        }
        return { value: coerceTableRowsToSchema([row.value], field.columns || [])[0], evidence: row.evidence };
      });
    } else if (parsed.value !== null && typeof parsed.value === 'object') {
      throw new Error(`Invalid scalar response for ${field.key}.`);
    }
    return { parsed, metrics: processingMetricsFromResponse(response.raw, response.model) };
  }

  let result = await request();
  let metrics = result.metrics;
  if (documentType.extractionVerification) {
    if (schema.length + chunk.text.length + JSON.stringify(result.parsed.value).length > 20000) {
      throw new Error(`Chunk verification input for ${field.key} exceeds the request budget.`);
    }
    const verification = await verifyExtractionWithOpenAI({
      aiOptions,
      document,
      documentType,
      selectedFields: [field],
      values: [{
        key: field.key,
        label: field.label,
        type: field.type,
        value: field.type === 'table' ? result.parsed.value.map((row) => row.value) : result.parsed.value,
        confidence: result.parsed.confidence,
      }],
      useOcr: true,
      documentText: chunk.text,
      textSourceLabel,
    });
    metrics = combineMetrics(metrics, verification.metrics);
    if (verification.needsCorrection) {
      const correction = await request(verification.issues, result.parsed);
      metrics = combineMetrics(metrics, correction.metrics);
      result = correction;
    }
  }
  return {
    value: result.parsed.value,
    evidence: result.parsed.evidence,
    confidence: typeof result.parsed.confidence === 'number' && result.parsed.confidence >= 0 && result.parsed.confidence <= 1
      ? result.parsed.confidence : undefined,
    metrics,
  };
}

async function extractChunkScalars(document, documentType, fields, chunk, aiOptions, textSourceLabel) {
  const schema = JSON.stringify(schemaForFields(fields));
  if (schema.length > 12000) throw new Error('Combined scalar schema exceeds the chunk extraction limit.');
  async function request(requestedFields, issues, previous) {
    const correction = issues
      ? `\nVerification issues: ${JSON.stringify(issues)}\nPrevious extraction: ${JSON.stringify(previous)}\nCorrect the result using only the chunk and provide exact evidence.`
      : '';
    const prompt = [
      `Extract the scalar fields from this part of a ${documentType.name} document.`,
      'Return JSON only. Extract only values found in the target chunk; surrounding context is for interpretation only.',
      'Return every field in the schema exactly once. Use an empty string and empty evidence when a value is absent. Do not infer missing values.',
      'Evidence for a non-empty value must be an exact, contiguous quote from the target chunk, not a paraphrase.',
      ...(chunk.contextBefore ? [`Context before the target chunk:\n${chunk.contextBefore}`] : []),
      ...(chunk.contextAfter ? [`Context after the target chunk:\n${chunk.contextAfter}`] : []),
      'Return this shape: {"fields":[{"key":"field_key","value":"extracted value","evidence":"exact source quote or empty string","confidence":0.9}]}',
      `Schema: ${JSON.stringify(schemaForFields(requestedFields))}`,
      `Target chunk:\n${chunk.text}`,
    ].join('\n');
    if (prompt.length + correction.length > 24000) throw new Error('Combined scalar chunk extraction prompt exceeds the request budget.');
    const response = await createJsonResponse(
      [{ type: 'input_text', text: prompt + correction }],
      aiOptions,
      `Chunk extraction for document ${document._id || document.fileName}`,
    );
    if (!response) throw new Error('An AI provider must be configured for chunked extraction.');
    const parsed = parseJsonObject(response.outputText);
    if (!Array.isArray(parsed.fields)) throw new Error('Missing fields in scalar chunk response.');
    const requestedByKey = new Map(requestedFields.map((field) => [field.key, field]));
    const extractedByKey = new Map();
    for (const extracted of parsed.fields) {
      if (!extracted || !requestedByKey.has(extracted.key) || extractedByKey.has(extracted.key) ||
        !Object.prototype.hasOwnProperty.call(extracted, 'value') ||
        (extracted.value !== null && typeof extracted.value === 'object')) {
        throw new Error('Invalid scalar field in chunk response.');
      }
      extractedByKey.set(extracted.key, extracted);
    }
    if (extractedByKey.size !== requestedFields.length) throw new Error('Scalar chunk response omitted one or more requested fields.');
    return {
      values: requestedFields.map((field) => {
        const extracted = extractedByKey.get(field.key);
        return {
          key: field.key,
          value: extracted.value ?? '',
          evidence: extracted.evidence,
          confidence: typeof extracted.confidence === 'number' && extracted.confidence >= 0 && extracted.confidence <= 1
            ? extracted.confidence : undefined,
        };
      }),
      metrics: processingMetricsFromResponse(response.raw, response.model),
    };
  }

  let result = await request(fields);
  let metrics = result.metrics;
  if (documentType.extractionVerification) {
    for (const field of fields) {
      const fieldValue = result.values.find((item) => item.key === field.key);
      if (JSON.stringify(schemaForFields([field])).length + chunk.text.length + JSON.stringify(fieldValue.value).length > 20000) {
        throw new Error(`Chunk verification input for ${field.key} exceeds the request budget.`);
      }
      const verification = await verifyExtractionWithOpenAI({
        aiOptions,
        document,
        documentType,
        selectedFields: [field],
        values: [{
          key: field.key,
          label: field.label,
          type: field.type,
          value: fieldValue.value,
          confidence: fieldValue.confidence,
        }],
        useOcr: true,
        documentText: chunk.text,
        textSourceLabel,
      });
      metrics = combineMetrics(metrics, verification.metrics);
      if (verification.needsCorrection) {
        const correction = await request([field], verification.issues, [fieldValue]);
        metrics = combineMetrics(metrics, correction.metrics);
        result.values = result.values.map((item) => item.key === field.key ? correction.values[0] : item);
      }
    }
  }
  return { values: result.values, metrics };
}

async function extractChunkedValues(document, documentType, documentText, textMode, aiOptions, index, batchSize, context) {
  if (providerName(aiOptions) !== 'ollama' && !getOpenAI(aiOptions)) {
    throw new Error('An AI provider must be configured for chunked extraction.');
  }
  const requestOptions = {
    ...aiOptions,
    model: documentType.extractionModel,
    reasoningEffort: documentType.extractionReasoningEffort,
  };
  const result = await extractChunkedDocument({
    text: documentText,
    fields: (documentType.fields || []).filter((field) => field.selected),
    batchSize,
    log: (message) => context.info(message),
    indexOptions: {
      index,
      documentId: String(document._id),
      embeddingOptions: { ...aiOptions, aiProvider: 'openai', apiKey: aiOptions.openAiApiKey },
    },
    extractChunk: (operation, chunk) => operation.type === 'table'
      ? extractChunkField(
        document, documentType, operation.field, chunk, requestOptions,
        textMode === 'markdown' ? 'Docling markdown' : 'locally extracted OCR/text',
      )
      : extractChunkScalars(
        document, documentType, operation.fields, chunk, requestOptions,
        textMode === 'markdown' ? 'Docling markdown' : 'locally extracted OCR/text',
      ),
  });
  return { ...result, spatialItems: await extractDocumentSpatialItems(document.filePath) };
}

function mockValue(label, type, index) {
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'number') return index + 1;
  if (type === 'currency') return Number((250 + index * 125.5).toFixed(2));
  if (type === 'boolean') return true;
  return `Extracted ${label}`;
}

async function extractQueuedDocument(message, context, chunked = false) {
  const payload = resolveMessage(message);
  const documentId = payload.documentId || payload.id;
  if (!documentId || !ObjectId.isValid(documentId)) {
    context.warn('Skipping extraction message without a valid documentId.');
    return;
  }

  const client = await getClient();
  const db = client.db();
  const documents = db.collection('incomingdocuments');
  const documentTypes = db.collection('documenttypes');
  const document = await documents.findOne({ _id: new ObjectId(documentId) });
  if (!document) {
    context.error(`Document ${documentId} not found`);
    return;
  }
  const configuration = await getConfiguration();
  const chunkGuard = chunked ? {
    status: 'extraction_started',
    chunkExtractionAttemptId: payload.chunkExtractionAttemptId,
  } : undefined;
  if (chunked && (!payload.chunkExtractionAttemptId || document.status !== chunkGuard.status ||
    document.chunkExtractionAttemptId !== chunkGuard.chunkExtractionAttemptId)) {
    context.info(`Skipping stale chunk extraction for document ${documentId}.`);
    return;
  }
  if (!chunked && configuration?.chunkedExtractionEnabled === true &&
    ['extraction_completed', 'validated', 'rejected'].includes(document.status)) {
    context.info(`Skipping completed extraction for document ${documentId}.`);
    return;
  }
  if (!chunked) {
    const started = await transitionDocumentStatus(
      documents, document._id, 'extraction_started', {}, [],
      configuration?.chunkedExtractionEnabled === true
        ? { guard: { status: document.status, revision: document.revision } }
        : {},
    );
    if (!started) return;
    await publishDocumentChanged(documents, document._id, ['status'], context);
  }
  const {
    aiOptions,
    reprocessOptions,
    useOcrForDocumentProcessing,
    documentTextMode,
    textOptions,
  } = processingOptionsFor(document, configuration);

  const documentTypeId = normalizeDocumentTypeId(document);
  const documentType = documentTypeId ? await documentTypes.findOne({ _id: documentTypeId }) : null;
  if (!documentType) {
    const failed = await transitionDocumentStatus(
      documents,
      document._id,
      'failed',
      { error: 'Document type not found for extraction' },
      ['reprocessOptions'],
      { completed: true, guard: chunkGuard },
    );
    if (failed) await publishDocumentChanged(documents, document._id, ['status', 'error'], context);
    return;
  }

  if (!hasResolvableDocumentFile(document)) {
    const errorMessage = `Document file not found: ${document.filePath || 'missing filePath'}`;
    context.error(errorMessage);
    const failed = await markDocumentFailed(documents, document._id, errorMessage, chunkGuard);
    if (failed) await publishDocumentChanged(documents, document._id, ['status', 'error'], context);
    return;
  }

  let localFilePath;
  try {
    localFilePath = await resolveDocumentFile(document, configuration);
    let preparedText = await resolvePreparedDocumentText(document, configuration);
    const preparedTextMode = document.textArtifactMode === 'markdown' ? 'markdown' : 'ocr';
    const effectiveDocumentType = {
      ...documentType,
      extractionModel: reprocessOptions.extractionModel || documentType.extractionModel,
      extractionReasoningEffort: reprocessOptions.extractionReasoningEffort || documentType.extractionReasoningEffort,
    };
    const extractionProvider = ['openai', 'custom', 'ollama'].includes(documentType.extractionAiProvider)
      ? documentType.extractionAiProvider
      : 'openai';
    const extractionAiOptions = {
      ...aiOptions,
      aiProvider: extractionProvider,
      apiKey: extractionProvider === 'custom' ? aiOptions.customApiKey : aiOptions.openAiApiKey,
      ...(extractionProvider === 'ollama' ? { ollamaModel: effectiveDocumentType.extractionModel } : {}),
    };
    const usesPreparedText = Boolean(document.workbookArtifactBlobName) || useOcrForDocumentProcessing || providerName(extractionAiOptions) === 'ollama';
    const effectiveProcessingMode = document.workbookArtifactBlobName ? 'spreadsheet' : usesPreparedText ? preparedTextMode : 'pdf';
    const localDocument = { ...document, ...payload.classificationUpdate, filePath: localFilePath };
    const chunkingEligible = configuration?.chunkedExtractionEnabled === true && usesPreparedText
      && !document.workbookArtifactBlobName && !isExcelDocument(document);
    context.info(`Extraction configured (chunked=${chunked}, mode=${effectiveProcessingMode}, provider=${extractionProvider}, textLength=${preparedText.length}).`);
    if (chunked && (!usesPreparedText || document.workbookArtifactBlobName || isExcelDocument(document))) {
      throw new Error('Chunk extraction requires an OCR or Markdown document.');
    }
    if ((chunked || chunkingEligible) && !document.textArtifactComplete) {
      preparedText = (await extractDocumentContent(localFilePath, Infinity, {
        ...textOptions,
        documentId: String(document._id),
        mode: preparedTextMode,
        fileName: document.convertedToPdf
          ? path.posix.basename(document.storageBlobName || document.fileName)
          : document.originalName || document.fileName,
      })).text;
    }
    if (!chunked && shouldRouteToChunkExtraction({
      enabled: configuration?.chunkedExtractionEnabled === true,
      usesPreparedText,
      spreadsheet: Boolean(document.workbookArtifactBlobName) || isExcelDocument(document),
      textLength: preparedText.length,
      threshold: configuration?.chunkedExtractionThreshold ?? 24000,
    })) {
      let attemptId = document.chunkExtractionAttemptId;
      if (!attemptId) {
        attemptId = randomUUID();
        const claimed = await documents.updateOne(
          { _id: document._id, status: 'extraction_started', chunkExtractionAttemptId: null },
          { $set: { chunkExtractionAttemptId: attemptId } },
        );
        if (!claimed.matchedCount) {
          const current = await documents.findOne({ _id: document._id });
          if (current?.status !== 'extraction_started' || !current.chunkExtractionAttemptId) return;
          attemptId = current.chunkExtractionAttemptId;
        }
      }
      context.extraOutputs.set(chunkExtractionOutput, JSON.stringify({
        ...payload,
        documentId: String(document._id),
        chunkExtractionAttemptId: attemptId,
        chunkedExtractionIndex: configuration.chunkedExtractionIndex || 'memory',
      }));
      context.info(`Chunk extraction output staged (textLength=${preparedText.length}, index=${configuration.chunkedExtractionIndex || 'memory'}).`);
      return;
    }
    const extraction = chunked
      ? await extractChunkedValues(localDocument, effectiveDocumentType, preparedText, preparedTextMode, extractionAiOptions, payload.chunkedExtractionIndex, configuration?.chunkedExtractionBatchSize ?? 2, context)
      : await extractValuesWithOpenAI(
        localDocument,
        effectiveDocumentType,
        useOcrForDocumentProcessing,
        {
          ...textOptions,
          mode: preparedTextMode,
          preparedText: usesPreparedText
            ? document.textArtifactComplete ? preparedText.slice(0, Number(process.env.DOCUMENT_TEXT_LIMIT || 60000)) : preparedText
            : undefined,
        },
        extractionAiOptions,
      );
    const extractedValues = extraction?.values ||
      (documentType.fields || [])
        .filter((field) => field.selected)
        .map((field, index) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          value: field.type === 'table'
            ? [(field.columns || []).reduce((row, column) => {
              row[column.key] = mockValue(column.label, column.type, index);
              return row;
            }, {})]
            : mockValue(field.label, field.type, index),
          confidence: Number((0.82 + Math.min(index, 8) * 0.015).toFixed(2)),
        }));
    const excelDocument = isExcelDocument(document);
    let extractedData = excelDocument
      ? extractedValues
      : await attachBoundingBoxes(localFilePath, extractedValues, extraction?.spatialItems || []);
    if (excelDocument) {
      const workbook = parseWorkbook(await require('fs/promises').readFile(localFilePath)).artifact;
      extractedData = extractedData.map((item) => {
        if (item.type === 'table' || item.value === undefined || item.value === null) return item;
        const expected = String(item.value).trim().toLowerCase();
        const match = workbook.sheets.flatMap((sheet) => sheet.cells.map((cell) => ({ sheet, cell })))
          .find(({ cell }) => String(cell.value).trim().toLowerCase() === expected);
        return match ? { ...item, cellReferences: [{ sheetIndex: match.sheet.index, sheetName: match.sheet.name, startCell: match.cell.address, endCell: match.cell.address }] } : item;
      });
    }

    const processingMetrics = extraction?.metrics || {
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      processedAt: new Date(),
    };
    processingMetrics.reasoningEffort = effectiveDocumentType.extractionReasoningEffort;
    const classificationMetrics = payload.classificationMetrics || {
      model: localDocument.classificationModel || 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
    const classificationEmbeddingMetrics = payload.embeddingMetrics || {
      model: 'none',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
    const embeddingMetrics = extraction?.embeddingMetrics
      ? combineMetrics(classificationEmbeddingMetrics, extraction.embeddingMetrics)
      : classificationEmbeddingMetrics;
    processingMetrics.extractionCostUsd = Number(processingMetrics.estimatedCostUsd || 0);
    processingMetrics.classificationCostUsd = Number(classificationMetrics.estimatedCostUsd || 0);
    processingMetrics.embeddingCostUsd = Number(embeddingMetrics.estimatedCostUsd || 0);
    processingMetrics.inputTokens =
      Number(processingMetrics.inputTokens || 0) +
      Number(classificationMetrics.inputTokens || 0) +
      Number(embeddingMetrics.inputTokens || 0);
    processingMetrics.outputTokens =
      Number(processingMetrics.outputTokens || 0) +
      Number(classificationMetrics.outputTokens || 0);
    processingMetrics.totalTokens =
      Number(processingMetrics.totalTokens || 0) +
      Number(classificationMetrics.totalTokens || 0) +
      Number(embeddingMetrics.totalTokens || 0);
    processingMetrics.estimatedCostUsd = Number((
      processingMetrics.extractionCostUsd +
      processingMetrics.classificationCostUsd +
      processingMetrics.embeddingCostUsd
    ).toFixed(8));

    const protectedExtractedData = extractedDataUpdate(document, extractedData, configuration);
    const completed = await transitionDocumentStatus(
      documents,
      document._id,
      'extraction_completed',
      {
        ...(payload.classificationUpdate || {}),
        ...protectedExtractedData.$set,
        processingMetrics,
        classificationModel: localDocument.classificationModel,
        processingMode: effectiveProcessingMode,
        chunkedExtractionUsed: chunked,
        error: null,
      },
      ['reprocessOptions', ...(chunked ? ['chunkExtractionAttemptId'] : []), ...Object.keys(protectedExtractedData.$unset || {})],
      { completed: true, guard: chunkGuard },
    );
    if (!completed) return;
    context.info(`Extraction completed (chunked=${chunked}, fieldCount=${extractedData.length}).`);
    await publishDocumentChanged(
      documents,
      document._id,
      ['status', 'extractedData', 'processingMetrics', 'processingMode', 'chunkedExtractionUsed'],
      context,
    );
    await recordBusinessReviewProcessing(db, localDocument, documentType, processingMetrics);
  } catch (error) {
    const errorMessage = `Extraction failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    const failed = await markDocumentFailed(documents, document._id, errorMessage, chunkGuard);
    if (failed) await publishDocumentChanged(documents, document._id, ['status', 'error'], context);
  } finally {
    if (localFilePath && document.storageContainer && document.storageBlobName) await removeTempFile(localFilePath);
  }
}

app.serviceBusQueue('extractDocument', {
  queueName: 'document-extraction',
  connection: 'ServiceBusConnection',
  extraOutputs: [chunkExtractionOutput],
  handler: withFunctionLogging('extractDocument', 'document-extraction', withExtractionConcurrency(extractQueuedDocument), { documentMessage: true }),
});

module.exports = { extractQueuedDocument, extractChunkField };
