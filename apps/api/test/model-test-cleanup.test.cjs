const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DocumentsService } = require('../dist/documents/documents.service');
const { recordBusinessReviewProcessing } = require('../../../functions/processor/src/documentProcessingCommon');

for (const status of ['extracted', 'failed', 'unsupported_format']) {
  test(`consuming ${status} test removes all artifacts before returning result`, async () => {
    const document = {
      _id: 'test-id', isModelTest: true, status, extractedData: [{ value: 'result' }],
      storageContainer: 'processing', storageBlobName: 'source',
      textArtifactContainer: 'text', textArtifactBlobName: 'text',
      spatialTextArtifactContainer: 'text', spatialTextArtifactBlobName: 'spatial',
      workbookArtifactContainer: 'text', workbookArtifactBlobName: 'workbook',
    };
    const operations = [];
    const service = Object.create(DocumentsService.prototype);
    service.findById = async () => document;
    service.documentModel = {
      findById: async () => document,
      deleteOne: async () => operations.push('database'),
    };
    service.blobStorage = { deleteBlob: async (_, name) => operations.push(name) };
    assert.equal(await service.consumeModelTestResult('test-id'), document);
    assert.deepEqual(operations, ['source', 'text', 'spatial', 'workbook', 'database']);
  });
}

test('processing tests are retained until a result is ready; ordinary documents are protected', async () => {
  const service = Object.create(DocumentsService.prototype);
  service.remove = async () => assert.fail('must not delete');
  service.findById = async () => ({ isModelTest: true, status: 'extracting' });
  assert.equal((await service.consumeModelTestResult('id')).status, 'extracting');
  service.findById = async () => ({ status: 'extracted' });
  await assert.rejects(service.consumeModelTestResult('id'), /not a model test/);
});

test('cleanup failures preserve the database record for retry and do not return a completed result', async () => {
  const document = { isModelTest: true, status: 'extracted', storageContainer: 'processing', storageBlobName: 'source' };
  const service = Object.create(DocumentsService.prototype);
  service.findById = async () => document;
  service.documentModel = { findById: async () => document, deleteOne: async () => assert.fail('must retain record') };
  service.blobStorage = { deleteBlob: async () => { throw new Error('Storage unavailable'); } };
  await assert.rejects(service.consumeModelTestResult('id'), /Storage unavailable/);
});

test('model tests do not create business review history or aggregate metrics', async () => {
  const db = { collection: () => assert.fail('must not persist metrics') };
  await recordBusinessReviewProcessing(db, { isModelTest: true }, {}, {});
});
