const fs = require('fs');
const { MongoDatabase, ObjectId } = require('@xtract/common');
const { downloadBuffer, downloadToTemp, removeTempFile } = require('./blobStorage');

const database = new MongoDatabase();
const getClient = () => database.connect();

function resolveMessage(message) {
  if (typeof message === 'string') {
    try {
      return JSON.parse(message);
    } catch {
      return { documentId: message };
    }
  }
  return message || {};
}

function resolveDocumentId(message) {
  const parsed = resolveMessage(message);
  return parsed.documentId || parsed.id;
}

function normalizeDocumentTypeId(document) {
  if (document.documentTypeId instanceof ObjectId) return document.documentTypeId;
  return document.documentTypeId && ObjectId.isValid(document.documentTypeId)
    ? new ObjectId(document.documentTypeId)
    : document.documentTypeId;
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

async function resolvePreparedDocumentText(document) {
  if (!document.textArtifactContainer || !document.textArtifactBlobName) {
    throw new Error('Prepared OCR/markdown artifact is missing. Run document text preparation before classification.');
  }
  return (await downloadBuffer(document.textArtifactContainer, document.textArtifactBlobName)).toString('utf8');
}

function processingOptionsFor(document, configuration = {}) {
  const reprocessOptions = document.reprocessOptions || {};
  const useOcrForDocumentProcessing =
    typeof reprocessOptions.useOcrForDocumentProcessing === 'boolean'
      ? reprocessOptions.useOcrForDocumentProcessing
      : Boolean(configuration?.useOcrForDocumentProcessing);
  const documentTextMode = reprocessOptions.documentTextMode === 'markdown'
    ? 'markdown'
    : reprocessOptions.documentTextMode === 'ocr'
      ? 'ocr'
      : configuration?.documentTextMode === 'markdown'
        ? 'markdown'
        : 'ocr';

  return {
    reprocessOptions,
    forceClassification: reprocessOptions.forceClassification === true,
    useOcrForDocumentProcessing,
    documentTextMode,
    aiOptions: {
      aiProvider: configuration?.aiProvider === 'ollama' ? 'ollama' : 'openai',
      ollamaBaseUrl: configuration?.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
      ollamaModel: configuration?.ollamaModel || process.env.OLLAMA_MODEL || 'llama3.2',
      embeddingProvider: configuration?.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
      embeddingModel: configuration?.embeddingModel || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
      ollamaEmbeddingModel: configuration?.ollamaEmbeddingModel || process.env.OLLAMA_EMBEDDING_MODEL || 'qwen3-embedding:4b',
    },
    textOptions: {
      mode: documentTextMode,
      markdownServiceUrl: configuration?.markdownServiceUrl,
    },
  };
}

function hasResolvableDocumentFile(document) {
  return Boolean(
    (document.storageContainer && document.storageBlobName) ||
    (document.filePath && fileExists(document.filePath)),
  );
}

async function markDocumentFailed(documents, documentId, error) {
  await documents.updateOne(
    { _id: documentId },
    {
      $set: { status: 'failed', error, updatedAt: new Date() },
      $inc: { revision: 1 },
      $unset: { reprocessOptions: '' },
    },
  );
}

async function recordBusinessReviewProcessing(db, document, documentType, metrics) {
  const processedAt = metrics?.processedAt || new Date();
  const extractionCostUsd = Number(metrics?.extractionCostUsd ?? metrics?.estimatedCostUsd ?? 0);
  const classificationCostUsd = Number(metrics?.classificationCostUsd || 0);
  const embeddingCostUsd = Number(metrics?.embeddingCostUsd || 0);
  const estimatedCostUsd = Number((extractionCostUsd + classificationCostUsd + embeddingCostUsd).toFixed(8));
  const normalizedMetrics = {
    model: metrics?.model || 'mock',
    inputTokens: Number(metrics?.inputTokens || 0),
    outputTokens: Number(metrics?.outputTokens || 0),
    totalTokens: Number(metrics?.totalTokens || 0),
    estimatedCostUsd,
    extractionCostUsd,
    classificationCostUsd,
    embeddingCostUsd,
    processedAt,
  };

  await db.collection('business_review_summaries').updateOne(
    { key: 'global' },
    {
      $setOnInsert: { key: 'global', createdAt: new Date() },
      $inc: {
        filesProcessed: 1,
        inputTokens: normalizedMetrics.inputTokens,
        outputTokens: normalizedMetrics.outputTokens,
        totalTokens: normalizedMetrics.totalTokens,
        estimatedCostUsd: normalizedMetrics.estimatedCostUsd,
        extractionCostUsd: normalizedMetrics.extractionCostUsd,
        classificationCostUsd: normalizedMetrics.classificationCostUsd,
        embeddingCostUsd: normalizedMetrics.embeddingCostUsd,
      },
      $set: { updatedAt: new Date() },
    },
    { upsert: true },
  );

  await db.collection('business_review_history').insertOne({
    documentId: String(document._id),
    fileName: document.originalName,
    documentTypeName: documentType?.name || document.documentTypeName,
    category: documentType?.category || document.category,
    status: 'extracted',
    classificationModel: document.classificationModel,
    extractionModel: normalizedMetrics.model,
    ...normalizedMetrics,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const staleHistory = await db.collection('business_review_history')
    .find({}, { projection: { _id: 1 } })
    .sort({ processedAt: -1, _id: -1 })
    .skip(5)
    .toArray();

  if (staleHistory.length) {
    await db.collection('business_review_history').deleteMany({ _id: { $in: staleHistory.map((entry) => entry._id) } });
  }
}

module.exports = {
  ObjectId,
  getClient,
  hasResolvableDocumentFile,
  markDocumentFailed,
  normalizeDocumentTypeId,
  processingOptionsFor,
  recordBusinessReviewProcessing,
  removeTempFile,
  resolveDocumentFile,
  resolveDocumentId,
  resolvePreparedDocumentText,
  resolveMessage,
};
