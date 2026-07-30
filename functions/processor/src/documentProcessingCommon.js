const fs = require('fs');
const { decryptSecret, MongoDatabase, ObjectId } = require('@xtract/common');
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

  const openAiApiKey = decryptSecret(
    configuration?.encryptedOpenAiApiKey
      || (configuration?.aiProvider === 'openai' ? configuration?.encryptedApiKey : ''),
  );
  const customApiKey = decryptSecret(
    configuration?.encryptedCustomApiKey
      || (configuration?.aiProvider === 'custom' ? configuration?.encryptedApiKey : ''),
  );
  const aiProvider = ['openai', 'custom', 'ollama'].includes(configuration?.aiProvider)
    ? configuration.aiProvider
    : 'openai';

  return {
    reprocessOptions,
    forceClassification: reprocessOptions.forceClassification === true,
    useOcrForDocumentProcessing,
    documentTextMode,
    aiOptions: {
      aiProvider,
      apiKey: aiProvider === 'custom' ? customApiKey : openAiApiKey,
      openAiApiKey,
      customApiKey,
      llmEndpoint: configuration?.llmEndpoint || '',
      ollamaBaseUrl: configuration?.ollamaBaseUrl || 'http://127.0.0.1:11434',
      ollamaModel: configuration?.ollamaModel || 'llama3.2',
      embeddingProvider: configuration?.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
      embeddingModel: configuration?.embeddingModel || 'text-embedding-3-small',
      ollamaEmbeddingModel: configuration?.ollamaEmbeddingModel || 'qwen3-embedding:4b',
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
  await transitionDocumentStatus(
    documents,
    documentId,
    'failed',
    { error },
    ['reprocessOptions'],
    { completed: true },
  );
}

async function beginDocumentStage(documents, documentId, status) {
  const now = new Date();
  await documents.updateOne(
    { _id: documentId },
    [
      {
        $set: {
          stageTimings: {
            $concatArrays: [
              {
                $map: {
                  input: { $ifNull: ['$stageTimings', []] },
                  as: 'stage',
                  in: {
                    $cond: [
                      { $eq: [{ $ifNull: ['$$stage.endTime', null] }, null] },
                      { $mergeObjects: ['$$stage', { endTime: now }] },
                      '$$stage',
                    ],
                  },
                },
              },
              [{ status, startTime: now }],
            ],
          },
        },
      },
    ],
  );
}

async function completeDocumentStage(
  documents,
  documentId,
  status,
  setFields = {},
  unsetFields = [],
) {
  const now = new Date();
  await documents.updateOne(
    { _id: documentId },
    [
      {
        $set: {
          ...setFields,
          status,
          updatedAt: now,
          revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
          stageTimings: {
            $map: {
              input: { $ifNull: ['$stageTimings', []] },
              as: 'stage',
              in: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$$stage.status', status] },
                      { $eq: [{ $ifNull: ['$$stage.endTime', null] }, null] },
                    ],
                  },
                  { $mergeObjects: ['$$stage', { endTime: now }] },
                  '$$stage',
                ],
              },
            },
          },
        },
      },
    ],
  );
  if (unsetFields.length) {
    await documents.updateOne(
      { _id: documentId },
      { $unset: Object.fromEntries(unsetFields.map((field) => [field, ''])) },
    );
  }
}

async function transitionDocumentStatus(
  documents,
  documentId,
  status,
  setFields = {},
  unsetFields = [],
  timing = {},
) {
  const now = new Date();
  const startTime = timing.startTime || now;
  const newStageTiming = {
    status,
    startTime,
    ...(timing.completed ? { endTime: now } : {}),
  };
  await documents.updateOne(
    { _id: documentId },
    [
      {
        $set: {
          ...setFields,
          status,
          updatedAt: now,
          revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] },
          stageTimings: {
            $concatArrays: [
              {
                $map: {
                  input: { $ifNull: ['$stageTimings', []] },
                  as: 'stage',
                  in: {
                    $cond: [
                      { $eq: [{ $ifNull: ['$$stage.endTime', null] }, null] },
                      { $mergeObjects: ['$$stage', { endTime: now }] },
                      '$$stage',
                    ],
                  },
                },
              },
              [newStageTiming],
            ],
          },
        },
      },
    ],
  );
  if (unsetFields.length) {
    await documents.updateOne(
      { _id: documentId },
      { $unset: Object.fromEntries(unsetFields.map((field) => [field, ''])) },
    );
  }
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
  beginDocumentStage,
  completeDocumentStage,
  transitionDocumentStatus,
  normalizeDocumentTypeId,
  processingOptionsFor,
  recordBusinessReviewProcessing,
  removeTempFile,
  resolveDocumentFile,
  resolveDocumentId,
  resolvePreparedDocumentText,
  resolveMessage,
};
