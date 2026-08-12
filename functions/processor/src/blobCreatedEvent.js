const { TRIGGER_CONTAINER } = require('./blobStorage');

function parseMessage(message) {
  if (Buffer.isBuffer(message)) return parseMessage(message.toString('utf8'));
  if (typeof message === 'string') {
    try { return parseMessage(JSON.parse(message)); } catch { return undefined; }
  }
  if (Array.isArray(message)) return parseMessage(message[0]);
  return message && typeof message === 'object' ? message : undefined;
}

function blobEventDetails(message) {
  const event = parseMessage(message);
  if (!event || event.eventType !== 'Microsoft.Storage.BlobCreated' || !event.id) {
    throw new Error('Expected a Microsoft.Storage.BlobCreated Event Grid message with an event ID.');
  }
  const api = event.data?.api;
  if (api && !['PutBlob', 'PutBlockList', 'FlushWithClose'].includes(api)) {
    throw new Error(`Unsupported blob creation operation: ${api}`);
  }
  const subjectMatch = String(event.subject || '').match(/\/containers\/([^/]+)\/blobs\/(.+)$/);
  if (!subjectMatch) throw new Error('BlobCreated event subject does not contain a container and blob name.');
  const container = decodeURIComponent(subjectMatch[1]);
  const blobName = decodeURIComponent(subjectMatch[2]);
  if (container !== TRIGGER_CONTAINER) throw new Error(`BlobCreated event targets unsupported container: ${container}`);
  return {
    event,
    container,
    blobName,
    etag: event.data?.eTag || event.data?.etag || '',
    sequencer: event.data?.sequencer || '',
  };
}

module.exports = { blobEventDetails, parseMessage };
