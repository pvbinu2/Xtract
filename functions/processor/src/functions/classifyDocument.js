const { app, output } = require('@azure/functions');
const { classifyDocument, normalizeObjectId } = require('../classifier');
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
      const localDocument = { ...document, filePath: localFilePath };
      try {
        const allDocumentTypes = await documentTypes.find({ finalized: true }).toArray();
        const classification = await classifyDocument(localDocument, allDocumentTypes, {
          ...aiOptions,
          useOcr: useOcrForDocumentProcessing,
          model: configuration?.classificationModel,
          reasoningEffort: configuration?.classificationReasoningEffort,
          documentTextMode: textOptions.mode,
          markdownServiceUrl: textOptions.markdownServiceUrl,
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
        };
        await documents.updateOne(
          { _id: document._id },
          {
            $set: {
              ...classificationUpdate,
              updatedAt: new Date(),
            },
          },
        );
      } finally {
        if (document.storageContainer && document.storageBlobName) await removeTempFile(localFilePath);
      }
    }

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
  queueName: 'document-processing',
  connection: 'AzureWebJobsStorage',
  extraOutputs: [extractionQueueOutput],
  handler: classifyQueuedDocument,
});
