const { app } = require('@azure/functions');
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const { attachBoundingBoxes } = require('../pdfBoundingBox');
const { classifyDocument, normalizeObjectId } = require('../classifier');
const { withOpenAIRetry } = require('../openaiRetry');
const { downloadToTemp, removeTempFile } = require('../blobStorage');

let clientPromise;
let openai;

function getClient() {
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/xtract').connect();
  }
  return clientPromise;
}

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return undefined;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function modelName() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
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

async function extractValuesWithOpenAI(document, documentType) {
  const client = getOpenAI();
  if (!client) return undefined;

  const selectedFields = (documentType.fields || []).filter((field) => field.selected);
  const pdf = fs.readFileSync(document.filePath).toString('base64');
  const model = modelName();
  const response = await withOpenAIRetry(() => client.responses.create({
    model,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: path.basename(document.filePath),
            file_data: `data:application/pdf;base64,${pdf}`,
          },
          {
            type: 'input_text',
            text: [
              `Extract values from this ${documentType.name} PDF.`,
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
  }), `Extraction for document ${document._id || document.fileName}`);

  const parsed = parseJsonObject(response.output_text);
  const byKey = new Map((parsed.fields || []).map((field) => [field.key, field]));
  const values = selectedFields.map((field) => {
    const extracted = byKey.get(field.key);
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      value: extracted?.value ?? '',
      confidence: typeof extracted?.confidence === 'number' ? extracted.confidence : undefined,
    };
  });

  return {
    values,
    metrics: processingMetricsFromResponse(response, model),
  };
}

function mockValue(label, type, index) {
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'number') return index + 1;
  if (type === 'currency') return Number((250 + index * 125.5).toFixed(2));
  if (type === 'boolean') return true;
  if (type === 'table') return [{ item: 'Sample line', quantity: 1, amount: 100 }];
  return `Extracted ${label}`;
}

function resolveDocumentId(message) {
  if (typeof message === 'string') {
    try {
      const parsed = JSON.parse(message);
      return parsed.documentId || parsed.id || message;
    } catch {
      return message;
    }
  }
  return message?.documentId || message?.id;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

async function resolveDocumentFile(document) {
  if (document.storageContainer && document.storageBlobName) {
    return downloadToTemp(document.storageContainer, document.storageBlobName);
  }
  return document.filePath;
}

async function markDocumentFailed(documents, documentId, error) {
  await documents.updateOne(
    { _id: documentId },
    { $set: { status: 'failed', error, updatedAt: new Date() } },
  );
}

async function recordBusinessReviewProcessing(db, document, documentType, metrics) {
  const processedAt = metrics?.processedAt || new Date();
  const normalizedMetrics = {
    model: metrics?.model || 'mock',
    inputTokens: Number(metrics?.inputTokens || 0),
    outputTokens: Number(metrics?.outputTokens || 0),
    totalTokens: Number(metrics?.totalTokens || 0),
    estimatedCostUsd: Number(metrics?.estimatedCostUsd || 0),
    processedAt,
  };

  await Promise.all([
    db.collection('business_review_summaries').updateOne(
      { key: 'global' },
      {
        $setOnInsert: { key: 'global', createdAt: new Date() },
        $inc: {
          filesProcessed: 1,
          inputTokens: normalizedMetrics.inputTokens,
          outputTokens: normalizedMetrics.outputTokens,
          totalTokens: normalizedMetrics.totalTokens,
          estimatedCostUsd: normalizedMetrics.estimatedCostUsd,
        },
        $set: { updatedAt: new Date() },
      },
      { upsert: true },
    ),
    db.collection('business_review_history').insertOne({
      documentId: String(document._id),
      fileName: document.originalName,
      documentTypeName: documentType?.name || document.documentTypeName,
      category: documentType?.category || document.category,
      ...normalizedMetrics,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  ]);
}

async function processDocument(message, context) {
  const documentId = resolveDocumentId(message);
  if (!documentId || !ObjectId.isValid(documentId)) {
    context.warn(`Skipping queue message without a valid documentId: ${JSON.stringify(message)}`);
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

  const documentTypeId =
    document.documentTypeId instanceof ObjectId
      ? document.documentTypeId
      : document.documentTypeId && ObjectId.isValid(document.documentTypeId)
        ? new ObjectId(document.documentTypeId)
        : document.documentTypeId;

  if (!(document.storageContainer && document.storageBlobName) && (!document.filePath || !fileExists(document.filePath))) {
    const errorMessage = `Document file not found: ${document.filePath || 'missing filePath'}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
    return;
  }

  try {
    let documentType = documentTypeId ? await documentTypes.findOne({ _id: documentTypeId }) : null;
    if (documentTypeId && !documentType) {
      await documents.updateOne(
        { _id: document._id },
        { $set: { status: 'failed', error: 'Document type not found', updatedAt: new Date() } },
      );
      return;
    }

    const localFilePath = await resolveDocumentFile(document);
    const localDocument = { ...document, filePath: localFilePath };

    try {
      if (!documentType) {
      const allDocumentTypes = await documentTypes.find({ finalized: true }).toArray();
      const classification = await classifyDocument(localDocument, allDocumentTypes);
      documentType = classification.documentType;
      await documents.updateOne(
        { _id: document._id },
        {
          $set: {
            category: documentType.category,
            documentTypeId: normalizeObjectId(documentType._id),
            documentTypeName: documentType.name,
            classificationScore: classification.score,
            classificationMethod: classification.method || 'llm',
            updatedAt: new Date(),
          },
        },
      );
      }

      const extraction = await extractValuesWithOpenAI(localDocument, documentType);
      const extractedData = await attachBoundingBoxes(
        localFilePath,
        extraction?.values ||
        (documentType.fields || [])
          .filter((field) => field.selected)
          .map((field, index) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            value: mockValue(field.label, field.type, index),
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

      await documents.updateOne(
        { _id: document._id },
        {
          $set: {
            status: 'extracted',
            extractedData,
            processingMetrics,
            error: null,
            updatedAt: new Date(),
          },
        },
      );
      await recordBusinessReviewProcessing(db, document, documentType, processingMetrics);
    } finally {
      if (document.storageContainer && document.storageBlobName) await removeTempFile(localFilePath);
    }
  } catch (error) {
    const errorMessage = `Processing failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
  }
}

app.storageQueue('processDocument', {
  queueName: 'document-processing',
  connection: 'AzureWebJobsStorage',
  handler: processDocument,
});
