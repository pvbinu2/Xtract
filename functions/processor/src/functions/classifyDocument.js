const { app, output } = require('@azure/functions');
const { classifyDocument, normalizeObjectId } = require('../classifier');
const { withAiConcurrency } = require('../aiConcurrency');
const {
  ObjectId,
  getClient,
  hasResolvableDocumentFile,
  markDocumentFailed,
  normalizeDocumentTypeId,
  processingOptionsFor,
  removeTempFile,
  resolveDocumentFile,
  resolveDocumentId,
  resolvePreparedDocumentText,
} = require('../documentProcessingCommon');

const extractionQueueOutput = output.storageQueue({
  queueName: 'document-extraction',
  connection: 'AzureWebJobsStorage',
});

async function classifyQueuedDocument(message, context) {
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

  const configuration = await db.collection('configuration').findOne({});
  const {
    aiOptions,
    forceClassification,
    useOcrForDocumentProcessing,
    textOptions,
  } = processingOptionsFor(document, configuration);
  const documentTypeId = normalizeDocumentTypeId(document);

  if (!hasResolvableDocumentFile(document)) {
    const errorMessage = `Document file not found: ${document.filePath || 'missing filePath'}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
    return;
  }

  try {
    let documentType = !forceClassification && documentTypeId ? await documentTypes.findOne({ _id: documentTypeId }) : null;
    if (!forceClassification && documentTypeId && !documentType) {
      await documents.updateOne(
        { _id: document._id },
        {
          $set: { status: 'failed', error: 'Document type not found', updatedAt: new Date() },
          $unset: { reprocessOptions: '' },
        },
      );
      return;
    }

    let classificationMetrics;
    let embeddingMetrics;
    let classificationUpdate = {};

    if (!documentType) {
      const localFilePath = await resolveDocumentFile(document);
      const preparedText = await resolvePreparedDocumentText(document);
      const localDocument = { ...document, filePath: localFilePath };
      try {
        const allDocumentTypes = await documentTypes.find({ finalized: true }).toArray();
        const classification = await classifyDocument(localDocument, allDocumentTypes, {
          ...aiOptions,
          useOcr: useOcrForDocumentProcessing,
          model: configuration?.classificationModel,
          reasoningEffort: configuration?.classificationReasoningEffort,
          classificationMode: configuration?.classificationMode,
          ragTopK: configuration?.classificationRagTopK,
          documentTextMode: document.textArtifactMode || textOptions.mode,
          markdownServiceUrl: textOptions.markdownServiceUrl,
          preparedText,
        });
        documentType = classification.documentType;
        classificationMetrics = classification.classificationMetrics;
        embeddingMetrics = classification.embeddingMetrics;
        classificationUpdate = {
          category: documentType.category,
          documentTypeId: normalizeObjectId(documentType._id),
          documentTypeName: documentType.name,
          classificationScore: classification.score,
          classificationMethod: classification.method || 'llm',
          classificationModel: classification.model || 'unknown',
          classificationJustification: classification.justification,
          ...(classification.classificationCandidates
            ? { classificationCandidates: classification.classificationCandidates }
            : {}),
        };
        await documents.updateOne(
          { _id: document._id },
          {
            $set: {
              ...classificationUpdate,
              updatedAt: new Date(),
            },
            ...(classification.classificationCandidates
              ? {}
              : { $unset: { classificationCandidates: '' } }),
          },
        );
      } finally {
        if (document.storageContainer && document.storageBlobName) await removeTempFile(localFilePath);
      }
    }

    await documents.updateOne(
      { _id: document._id },
      { $set: { status: 'classified', updatedAt: new Date() } },
    );
    context.extraOutputs.set(extractionQueueOutput, JSON.stringify({
      documentId: String(document._id),
      classificationMetrics,
      embeddingMetrics,
      classificationUpdate,
    }));
  } catch (error) {
    const errorMessage = `Classification failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
  }
}

app.storageQueue('classifyDocument', {
  queueName: 'document-classification',
  connection: 'AzureWebJobsStorage',
  extraOutputs: [extractionQueueOutput],
  handler: withAiConcurrency(classifyQueuedDocument),
});
