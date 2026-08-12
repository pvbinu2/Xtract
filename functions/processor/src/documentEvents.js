const { randomUUID } = require('crypto');
const { sendServiceBusMessage } = require('./serviceBus');

function signalREnabled() {
  return process.env.SIGNALR_ENABLED !== 'false' && Boolean(process.env.REALTIME_BROADCAST_URL);
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
    await sendServiceBusMessage('document-events', event, event.eventId);
  } catch (error) {
    context?.warn?.(`Document real-time event could not be queued: ${error?.message || String(error)}`);
  }
}

module.exports = { publishDocumentChanged, signalREnabled };
