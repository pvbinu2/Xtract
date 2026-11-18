const { app, output } = require('@azure/functions');
const { classifyDocument, normalizeObjectId } = require('../classifier');
const { withClassificationConcurrency } = require('../aiConcurrency');
const { withFunctionLogging } = require('../functionLogger');
const { publishDocumentChanged } = require('../documentEvents');
const { getConfiguration } = require('../configurationCache');
const { extractDocumentContent } = require('../documentText');
const { isExcelDocument } = require('../workbook');
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
  transitionDocumentStatus,
} = require('../documentProcessingCommon');

const extractionQueueOutput = output.serviceBusQueue({
  queueName: 'document-extraction',
  connection: 'ServiceBusConnection',
});

async function classifyQueuedDocument(message, context) {
  const documentId = resolveDocumentId(message);
  if (!documentId || !ObjectId.isValid(documentId)) {
    context.warn('Skipping classification message without a valid documentId.');
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
  await transitionDocumentStatus(documents, document._id, 'classification_started');
  await publishDocumentChanged(documents, document._id, ['status'], context);

  const configuration = await getConfiguration();
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
    await publishDocumentChanged(documents, document._id, ['status', 'error'], context);
    return;
  }

  try {
    let documentType = !forceClassification && documentTypeId ? await documentTypes.findOne({ _id: documentTypeId }) : null;
    if (!forceClassification && documentTypeId && !documentType) {
      await transitionDocumentStatus(
        documents,
        document._id,
        'failed',
        { error: 'Document type not found' },
        ['reprocessOptions'],
        { completed: true },
      );
      await publishDocumentChanged(documents, document._id, ['status', 'error'], context);
      return;
    }

    let classificationMetrics;
    let embeddingMetrics;
    let classificationUpdate = {};

    if (!documentType) {
      context.info(`Classifying document (mode=${configuration?.classificationMode || 'default'}).`);
      const localFilePath = await resolveDocumentFile(document, configuration);
      const localDocument = { ...document, filePath: localFilePath };
      try {
        const preparedText = document.textArtifactComplete || isExcelDocument(document)
          ? await resolvePreparedDocumentText(document, configuration)
          : (await extractDocumentContent(localFilePath, Infinity, {
            ...textOptions,
            mode: document.textArtifactMode || textOptions.mode,
            documentId: String(document._id),
            fileName: document.originalName || document.fileName,
          })).text;
        const allDocumentTypes = await documentTypes.find({ finalized: true }).toArray();
        const classification = await classifyDocument(localDocument, allDocumentTypes, {
          ...aiOptions,
          useOcr: useOcrForDocumentProcessing,
          model: configuration?.classificationModel,
          reasoningEffort: configuration?.classificationReasoningEffort,
          classificationMode: configuration?.classificationMode,
          ragTopK: configuration?.classificationRagTopK,
          lowConfidenceFallbackEnabled: configuration?.classificationLowConfidenceFallbackEnabled,
          lowConfidenceThreshold: configuration?.classificationLowConfidenceThreshold,
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
          classificationReasoningEffort: configuration?.classificationReasoningEffort,
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

    await transitionDocumentStatus(documents, document._id, 'classification_completed', {}, [], { completed: true });
    await publishDocumentChanged(
      documents,
      document._id,
      ['status', 'category', 'documentTypeId', 'documentTypeName', 'classificationScore', 'classificationMethod'],
      context,
    );
    context.extraOutputs.set(extractionQueueOutput, JSON.stringify({
      documentId: String(document._id),
      classificationMetrics,
      embeddingMetrics,
      classificationUpdate,
    }));
    context.info('Classification returned; extraction output staged.');
  } catch (error) {
    const errorMessage = `Classification failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
    await publishDocumentChanged(documents, document._id, ['status', 'error'], context);
  }
}

app.serviceBusQueue('classifyDocument', {
  queueName: 'document-classification',
  connection: 'ServiceBusConnection',
  extraOutputs: [extractionQueueOutput],
  handler: withFunctionLogging('classifyDocument', 'document-classification', withClassificationConcurrency(classifyQueuedDocument), { documentMessage: true }),
});
