const path = require('path');
const { app, output } = require('@azure/functions');
const { ObjectId, getClient } = require('../documentProcessingCommon');
const {
  PROCESSING_CONTAINER,
  TRIGGER_CONTAINER,
  createBlobName,
  moveBlob,
} = require('../blobStorage');

const processingQueueOutput = output.storageQueue({
  queueName: 'document-processing',
  connection: 'AzureWebJobsStorage',
});

function resolveBlobName(context) {
  const metadata = context.triggerMetadata || {};
  const name = metadata.name || metadata.Name;
  if (name) return String(name);

  const blobTrigger = metadata.blobTrigger || metadata.BlobTrigger;
  if (blobTrigger) {
    const value = String(blobTrigger);
    return value.startsWith(`${TRIGGER_CONTAINER}/`) ? value.slice(TRIGGER_CONTAINER.length + 1) : value;
  }

  return '';
}

async function ingestTriggeredDocument(_blob, context) {
  const triggerBlobName = resolveBlobName(context);
  if (!triggerBlobName) {
    context.warn('Skipping trigger blob ingestion because the blob name could not be resolved.');
    return;
  }

  const client = await getClient();
  const db = client.db();
  const documents = db.collection('incomingdocuments');

  const existingDocument = await documents.findOne({
    triggerContainer: TRIGGER_CONTAINER,
    triggerBlobName,
  });
  if (existingDocument) {
    context.info(`Trigger blob ${triggerBlobName} was already ingested as document ${existingDocument._id}.`);
    if (['received', 'preprocessed', 'classified', 'uploaded', 'processing'].includes(existingDocument.status)) {
      context.extraOutputs.set(processingQueueOutput, JSON.stringify({ documentId: String(existingDocument._id) }));
    }
    return;
  }

  const originalName = path.basename(triggerBlobName);
  const documentId = new ObjectId();
  const processingBlobName = createBlobName(originalName, String(documentId));
  await moveBlob(TRIGGER_CONTAINER, triggerBlobName, PROCESSING_CONTAINER, processingBlobName);

  const now = new Date();
  const result = await documents.insertOne({
    _id: documentId,
    fileName: processingBlobName,
    originalName,
    filePath: `azure://${PROCESSING_CONTAINER}/${processingBlobName}`,
    storageContainer: PROCESSING_CONTAINER,
    storageBlobName: processingBlobName,
    triggerContainer: TRIGGER_CONTAINER,
    triggerBlobName,
    category: 'Unclassified',
    documentTypeName: 'Pending classification',
    classificationMethod: 'vector',
    status: 'received',
    extractedData: [],
    createdAt: now,
    updatedAt: now,
  });

  context.info(`Ingested trigger blob ${triggerBlobName} as document ${result.insertedId}.`);
  context.extraOutputs.set(processingQueueOutput, JSON.stringify({ documentId: String(result.insertedId) }));
}

app.storageBlob('ingestTriggeredDocument', {
  path: `${TRIGGER_CONTAINER}/{name}`,
  connection: 'AzureWebJobsStorage',
  extraOutputs: [processingQueueOutput],
  handler: ingestTriggeredDocument,
});
