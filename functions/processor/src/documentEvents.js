const { randomUUID } = require('crypto');
const { QueueServiceClient } = require('@azure/storage-queue');

let queueClient;

function signalREnabled() {
  return process.env.SIGNALR_ENABLED !== 'false' && Boolean(process.env.REALTIME_BROADCAST_URL);
}

async function documentEventsQueue() {
  if (!queueClient) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
    if (!connectionString) throw new Error('Azure storage connection string is required for document events.');
    queueClient = QueueServiceClient.fromConnectionString(connectionString).getQueueClient('document-events');
    await queueClient.createIfNotExists();
  }
  return queueClient;
}

async function publishDocumentChanged(documents, documentId, changedFields, context) {
  if (!signalREnabled()) return;
  try {
    const document = await documents.findOne(
      { _id: documentId },
      { projection: { status: 1, revision: 1, updatedAt: 1 } },
    );
    if (!document) return;
    const event = {
      eventId: randomUUID(),
      documentId: String(document._id),
      revision: Number(document.revision || 0),
      status: document.status,
      changedFields,
      updatedAt: (document.updatedAt || new Date()).toISOString(),
    };
    const queue = await documentEventsQueue();
    await queue.sendMessage(Buffer.from(JSON.stringify(event)).toString('base64'));
  } catch (error) {
    context?.warn?.(`Document real-time event could not be queued: ${error?.message || String(error)}`);
  }
}

module.exports = { publishDocumentChanged, signalREnabled };
