const path = require('path');
const { app, output } = require('@azure/functions');
const { ObjectId, encryptionPolicyFor, extractedDataUpdate, getClient } = require('../documentProcessingCommon');
const { getConfiguration } = require('../configurationCache');
const { resolveDataEncryptionSettings } = require('@xtract/common');
const { publishDocumentChanged } = require('../documentEvents');
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

const IMAGE_MIME_TYPES = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
};

function mimeTypeForFileName(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.pdf' ? 'application/pdf' : IMAGE_MIME_TYPES[extension];
}

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
  const configuration = await getConfiguration();
  const settings = resolveDataEncryptionSettings(configuration);
  const encryptionPolicy = encryptionPolicyFor(configuration);
  const processingBlobName = createBlobName(originalName, String(documentId));
  await moveBlob(TRIGGER_CONTAINER, triggerBlobName, PROCESSING_CONTAINER, processingBlobName, {
    target: settings.storage.enabled ? { key: settings.storage.key, keyVersion: settings.storage.keyVersion } : undefined,
  });

  const now = new Date();
  const newDocument = {
    _id: documentId,
    fileName: processingBlobName,
    originalName,
    mimeType: mimeTypeForFileName(originalName),
    filePath: `azure://${PROCESSING_CONTAINER}/${processingBlobName}`,
    storageContainer: PROCESSING_CONTAINER,
    storageBlobName: processingBlobName,
    triggerContainer: TRIGGER_CONTAINER,
    triggerBlobName,
    category: 'Unclassified',
    documentTypeName: 'Pending classification',
    classificationMethod: 'vector',
    status: 'received',
    stageTimings: [{ status: 'received', startTime: now, endTime: now }],
    revision: 1,
    encryptionPolicy,
    createdAt: now,
    updatedAt: now,
  };
  const initial = extractedDataUpdate(newDocument, [], configuration);
  Object.assign(newDocument, initial.$set);
  const result = await documents.insertOne(newDocument);

  context.info(`Ingested trigger blob ${triggerBlobName} as document ${result.insertedId}.`);
  await publishDocumentChanged(documents, result.insertedId, ['status'], context);
  context.extraOutputs.set(processingQueueOutput, JSON.stringify({ documentId: String(result.insertedId) }));
}

app.storageBlob('ingestTriggeredDocument', {
  path: `${TRIGGER_CONTAINER}/{name}`,
  connection: 'AzureWebJobsStorage',
  extraOutputs: [processingQueueOutput],
  handler: ingestTriggeredDocument,
});
