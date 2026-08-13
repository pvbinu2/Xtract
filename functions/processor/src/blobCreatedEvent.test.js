const test = require('node:test');
const assert = require('node:assert/strict');
const { blobEventDetails } = require('./blobCreatedEvent');

function event(overrides = {}) {
  return {
    id: 'event-1',
    eventType: 'Microsoft.Storage.BlobCreated',
    subject: '/blobServices/default/containers/trigger/blobs/folder%2Finvoice.pdf',
    data: { api: 'PutBlockList', eTag: 'etag-1', sequencer: '0001' },
    ...overrides,
  };
}

test('parses an Event Grid BlobCreated message', () => {
  assert.deepEqual(blobEventDetails(event()), {
    event: event(),
    container: 'trigger',
    blobName: 'folder/invoice.pdf',
    etag: 'etag-1',
    sequencer: '0001',
  });
});

test('accepts serialized and batched Event Grid messages', () => {
  assert.equal(blobEventDetails(JSON.stringify([event()])).blobName, 'folder/invoice.pdf');
});

test('rejects unsupported event types, operations, and containers', () => {
  assert.throws(() => blobEventDetails(event({ eventType: 'Microsoft.Storage.BlobDeleted' })), /BlobCreated/);
  assert.throws(() => blobEventDetails(event({ data: { api: 'CopyBlob' } })), /Unsupported/);
  assert.throws(() => blobEventDetails(event({ subject: '/blobServices/default/containers/other/blobs/a.pdf' })), /unsupported container/);
});
