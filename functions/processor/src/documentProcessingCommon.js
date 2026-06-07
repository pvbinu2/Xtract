const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');
const { downloadToTemp, removeTempFile } = require('./blobStorage');

let clientPromise;

function getClient() {
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/xtract').connect();
  }
  return clientPromise;
}

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
  resolveMessage,
};
