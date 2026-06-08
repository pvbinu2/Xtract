const { app } = require('@azure/functions');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { attachBoundingBoxes } = require('../pdfBoundingBox');
const { extractDocumentText } = require('../documentText');
const { withOpenAIRetry } = require('../openaiRetry');
const {
  ObjectId,
  getClient,
  hasResolvableDocumentFile,
  markDocumentFailed,
  normalizeDocumentTypeId,
  processingOptionsFor,
  recordBusinessReviewProcessing,
  removeTempFile,
  resolveDocumentFile,
  resolveMessage,
} = require('../documentProcessingCommon');

let openai;

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return undefined;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function modelName() {
  return process.env.OPENAI_MODEL || 'gpt-5-nano';
}

function supportsReasoningEffort(model) {
  return /^(gpt-5|o\d|o\d-)/.test(model);
}

function openAIRequestConfig(options = {}) {
  const model = options.model || modelName();
  return {
    model,
    ...(options.reasoningEffort && supportsReasoningEffort(model)
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
  };
}

const modelPricingUsdPerMillion = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
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
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
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
  return JSON.parse(fenced ? fenced[1] : trimmed);
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
  client,
  requestConfig,
  model,
  document,
  documentType,
  selectedFields,
  values,
  useOcr,
  documentText,
  textSourceLabel,
}) {
  const response = await withOpenAIRetry(() => client.responses.create({
    ...requestConfig,
    input: [
      {
        role: 'user',
        content: [
          ...(useOcr ? [] : [pdfInput(document.filePath)]),
          {
            type: 'input_text',
            text: [
              useOcr
                ? `Verify extracted values from this ${documentType.name} document using the ${textSourceLabel} below.`
                : `Verify extracted values from this ${documentType.name} PDF.`,
              'Compare the extracted data against the document content and schema.',
              'Return JSON only. Do not include markdown.',
              'Set needsCorrection to true only when a value is missing, incorrect, assigned to the wrong field, or a table row/column is inconsistent with the document.',
              'Return this exact shape:',
              '{"needsCorrection":true,"issues":[{"key":"field_key","problem":"brief issue"}]}',
              `Schema: ${JSON.stringify(schemaForFields(selectedFields))}`,
              `Extracted data: ${JSON.stringify(values)}`,
              useOcr ? `Document text:\n${documentText}` : '',
            ].join('\n'),
          },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
  }), `Extraction verification for document ${document._id || document.fileName}`);

  const parsed = parseJsonObject(response.output_text);
  return {
    needsCorrection: Boolean(parsed.needsCorrection),
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    metrics: processingMetricsFromResponse(response, model),
  };
}

async function correctExtractionWithOpenAI({
  client,
  requestConfig,
  model,
  document,
  documentType,
  selectedFields,
  values,
  issues,
  useOcr,
  documentText,
  textSourceLabel,
}) {
  const response = await withOpenAIRetry(() => client.responses.create({
    ...requestConfig,
    input: [
      {
        role: 'user',
        content: [
          ...(useOcr ? [] : [pdfInput(document.filePath)]),
          {
            type: 'input_text',
            text: [
              useOcr
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
              useOcr ? `Document text:\n${documentText}` : '',
            ].join('\n'),
          },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
  }), `Extraction correction for document ${document._id || document.fileName}`);

  const parsed = parseJsonObject(response.output_text);
  return {
    values: valuesFromParsedFields(parsed.fields || [], selectedFields),
    metrics: processingMetricsFromResponse(response, model),
  };
}

async function extractValuesWithOpenAI(document, documentType, useOcr = false, textOptions = {}) {
  const client = getOpenAI();
  if (!client) return undefined;

  const selectedFields = (documentType.fields || []).filter((field) => field.selected);
  const textMode = textOptions.mode === 'markdown' ? 'markdown' : 'ocr';
  const documentText = useOcr ? await extractDocumentText(document.filePath, undefined, {
    mode: textMode,
    markdownServiceUrl: textOptions.markdownServiceUrl,
    fileName: document.originalName || document.fileName,
  }) : '';
  const textSourceLabel = textMode === 'markdown' ? 'Docling markdown' : 'locally extracted OCR/text';
  const requestConfig = openAIRequestConfig({
    model: documentType.extractionModel,
    reasoningEffort: documentType.extractionReasoningEffort,
  });
  const model = requestConfig.model;
  const response = await withOpenAIRetry(() => client.responses.create({
    ...requestConfig,
    input: [
      {
        role: 'user',
        content: [
          ...(useOcr ? [] : [pdfInput(document.filePath)]),
          {
            type: 'input_text',
            text: [
              useOcr
                ? `Extract values from this ${documentType.name} document using the ${textSourceLabel} below.`
                : `Extract values from this ${documentType.name} PDF.`,
              'Return JSON only. Do not include markdown.',
              'If a value is missing, return an empty string and low confidence.',
              'For table fields, return an array of row objects. Each row object must contain only the column keys defined for that table in the schema.',
              'Return this exact shape:',
              '{"fields":[{"key":"field_key","value":"extracted value","confidence":0.92}]}',
              `Schema: ${JSON.stringify(schemaForFields(selectedFields))}`,
              useOcr ? `Document text:\n${documentText}` : '',
            ].join('\n'),
          },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
  }), `Extraction for document ${document._id || document.fileName}`);

  const parsed = parseJsonObject(response.output_text);
  let values = valuesFromParsedFields(parsed.fields || [], selectedFields);
  let metrics = processingMetricsFromResponse(response, model);

  if (documentType.extractionVerification) {
    const verification = await verifyExtractionWithOpenAI({
      client,
      requestConfig,
      model,
      document,
      documentType,
      selectedFields,
      values,
      useOcr,
      documentText,
      textSourceLabel,
    });
    metrics = combineMetrics(metrics, verification.metrics);

    if (verification.needsCorrection) {
      const correction = await correctExtractionWithOpenAI({
        client,
        requestConfig,
        model,
        document,
        documentType,
        selectedFields,
        values,
        issues: verification.issues,
        useOcr,
        documentText,
        textSourceLabel,
      });
      values = correction.values;
      metrics = combineMetrics(metrics, correction.metrics);
    }
  }

  return {
    values,
    metrics,
  };
}

function mockValue(label, type, index) {
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'number') return index + 1;
  if (type === 'currency') return Number((250 + index * 125.5).toFixed(2));
  if (type === 'boolean') return true;
  return `Extracted ${label}`;
}

async function extractQueuedDocument(message, context) {
  const payload = resolveMessage(message);
  const documentId = payload.documentId || payload.id;
  if (!documentId || !ObjectId.isValid(documentId)) {
    context.warn(`Skipping extraction queue message without a valid documentId: ${JSON.stringify(message)}`);
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

  const configuration = await db.collection('configuration').findOne({});
  const {
    reprocessOptions,
    useOcrForDocumentProcessing,
    documentTextMode,
    textOptions,
  } = processingOptionsFor(document, configuration);

  const documentTypeId = normalizeDocumentTypeId(document);
  const documentType = documentTypeId ? await documentTypes.findOne({ _id: documentTypeId }) : null;
  if (!documentType) {
    await documents.updateOne(
      { _id: document._id },
      {
        $set: { status: 'failed', error: 'Document type not found for extraction', updatedAt: new Date() },
        $unset: { reprocessOptions: '' },
      },
    );
    return;
  }

  if (!hasResolvableDocumentFile(document)) {
    const errorMessage = `Document file not found: ${document.filePath || 'missing filePath'}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
    return;
  }

  let localFilePath;
  try {
    localFilePath = await resolveDocumentFile(document);
    const localDocument = { ...document, ...payload.classificationUpdate, filePath: localFilePath };
    const effectiveDocumentType = {
      ...documentType,
      extractionModel: reprocessOptions.extractionModel || documentType.extractionModel,
    };
    const extraction = await extractValuesWithOpenAI(localDocument, effectiveDocumentType, useOcrForDocumentProcessing, textOptions);
    const extractedData = await attachBoundingBoxes(
      localFilePath,
      extraction?.values ||
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
        })),
    );

    const processingMetrics = extraction?.metrics || {
      model: 'mock',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      processedAt: new Date(),
    };
    const classificationMetrics = payload.classificationMetrics || {
      model: localDocument.classificationModel || 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
    const embeddingMetrics = payload.embeddingMetrics || {
      model: 'none',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
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

    await documents.updateOne(
      { _id: document._id },
      {
        $set: {
          status: 'extracted',
          ...(payload.classificationUpdate || {}),
          extractedData,
          processingMetrics,
          classificationModel: localDocument.classificationModel,
          processingMode: useOcrForDocumentProcessing && documentTextMode === 'markdown' ? 'markdown' : useOcrForDocumentProcessing ? 'ocr' : 'pdf',
          error: null,
          updatedAt: new Date(),
        },
        $unset: { reprocessOptions: '' },
      },
    );
    await recordBusinessReviewProcessing(db, localDocument, documentType, processingMetrics);
  } catch (error) {
    const errorMessage = `Extraction failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
  } finally {
    if (localFilePath && document.storageContainer && document.storageBlobName) await removeTempFile(localFilePath);
  }
}

app.storageQueue('extractDocument', {
  queueName: 'document-extraction',
  connection: 'AzureWebJobsStorage',
  handler: extractQueuedDocument,
});
