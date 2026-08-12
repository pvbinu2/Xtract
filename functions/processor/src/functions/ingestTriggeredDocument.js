const path = require('path');
const { createHash } = require('crypto');
const { app, output } = require('@azure/functions');
const { ObjectId, encryptionPolicyFor, extractedDataUpdate, getClient } = require('../documentProcessingCommon');
const { getConfiguration } = require('../configurationCache');
const { resolveDataEncryptionSettings } = require('@xtract/common');
const { publishDocumentChanged } = require('../documentEvents');
const { blobEventDetails } = require('../blobCreatedEvent');
const {
  PROCESSING_CONTAINER,
  TRIGGER_CONTAINER,
  createBlobName,
  moveBlob,
} = require('../blobStorage');

const processingQueueOutput = output.serviceBusQueue({
  queueName: 'document-processing',
  connection: 'ServiceBusConnection',
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
let triggerEventIndexReady;

function ensureTriggerEventIndex(documents) {
  if (!triggerEventIndexReady) {
    triggerEventIndexReady = documents.createIndex(
      { triggerEventId: 1 },
      { unique: true, sparse: true, name: 'triggerEventId_1' },
    );
  }
  return triggerEventIndexReady;
}

function mimeTypeForFileName(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.pdf' ? 'application/pdf' : IMAGE_MIME_TYPES[extension];
}

function documentIdForEvent(eventId) {
  return new ObjectId(createHash('sha256').update(String(eventId)).digest('hex').slice(0, 24));
}

async function ingestTriggeredDocument(message, context) {
  const configuration = await getConfiguration();
  if (configuration.documentIngestionTrigger === 'blob') {
    context.info('Ignoring Event Grid ingestion because Blob trigger mode is active.');
    return;
  }
  const details = blobEventDetails(message);
  return ingestBlob(details, context, configuration);
}

async function ingestBlob(details, context, configuration) {
  const triggerBlobName = details.blobName;

  const client = await getClient();
  const db = client.db();
  const documents = db.collection('incomingdocuments');
  await ensureTriggerEventIndex(documents);

  const existingDocument = await documents.findOne({ triggerEventId: details.event.id });
  if (existingDocument) {
    context.info(`Trigger blob ${triggerBlobName} was already ingested as document ${existingDocument._id}.`);
    if (['received', 'preprocessed', 'classified', 'uploaded', 'processing'].includes(existingDocument.status)) {
      context.extraOutputs.set(processingQueueOutput, JSON.stringify({ documentId: String(existingDocument._id) }));
    }
    return;
  }

  const originalName = path.basename(triggerBlobName);
  const documentId = documentIdForEvent(details.event.id);
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
    triggerEventId: details.event.id,
    triggerEventEtag: details.etag,
    triggerEventSequencer: details.sequencer,
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

async function ingestTriggeredBlob(blob, context) {
  const configuration = await getConfiguration();
  if (configuration.documentIngestionTrigger !== 'blob') {
    context.info('Ignoring Blob trigger invocation because Event Grid mode is active.');
    return;
  }
  const metadata = context.triggerMetadata || {};
  const blobName = String(metadata.name || metadata.blobName || '').replace(/^trigger\//, '');
  if (!blobName) throw new Error('Blob trigger metadata does not contain the blob name.');
  const etag = String(metadata.eTag || metadata.etag || '');
  const identity = `${TRIGGER_CONTAINER}/${blobName}/${etag || Buffer.byteLength(blob || '')}`;
  const eventId = `blob-trigger:${createHash('sha256').update(identity).digest('hex')}`;
  return ingestBlob({
    blobName,
    etag,
    sequencer: '',
    event: { id: eventId },
  }, context, configuration);
}

app.serviceBusQueue('ingestTriggeredDocument', {
  queueName: 'blob-ingestion',
  connection: 'ServiceBusConnection',
  extraOutputs: [processingQueueOutput],
  handler: ingestTriggeredDocument,
});

app.storageBlob('ingestTriggeredBlob', {
  path: `${TRIGGER_CONTAINER}/{name}`,
  connection: 'AzureWebJobsStorage',
  source: 'LogsAndContainerScan',
  extraOutputs: [processingQueueOutput],
  handler: ingestTriggeredBlob,
});

module.exports = { documentIdForEvent, ingestBlob, ingestTriggeredBlob, ingestTriggeredDocument, mimeTypeForFileName };
