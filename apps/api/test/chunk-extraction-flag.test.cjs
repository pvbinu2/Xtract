const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const { DocumentsService } = require('../dist/documents/documents.service');
const { IncomingDocumentSchema } = require('../dist/schemas/incoming-document.schema');

test('document JSON retains both extraction strategies without assigning a value to older documents', () => {
  const Model = mongoose.model('ChunkExtractionFlagTest', IncomingDocumentSchema);
  for (const value of [true, false]) {
    const json = new Model({ chunkedExtractionUsed: value }).toObject();
    assert.equal(json.chunkedExtractionUsed, value);
  }
  assert.equal(new Model({}).toObject().chunkedExtractionUsed, undefined);
});

test('reprocessing clears the previous extraction strategy before enqueueing', async () => {
  const document = {
    _id: 'doc', id: 'doc', status: 'extraction_completed', chunkedExtractionUsed: true,
    stageTimings: [], save: async () => {},
  };
  const service = Object.create(DocumentsService.prototype);
  service.documentModel = {
    findById: async () => document,
    updateOne: async () => {},
  };
  service.requireServiceBus = () => {};
  service.encryptionSettings = async () => ({});
  service.extractedDataUpdate = () => ({});
  let published;
  service.publishDocumentChanged = async (_, fields) => { published = fields; };
  service.enqueueProcessing = async () => { assert.equal(document.chunkedExtractionUsed, undefined); };
  service.findById = async () => document;

  const result = await service.reprocess('doc');
  assert.equal(result.chunkedExtractionUsed, undefined);
  assert.ok(published.includes('chunkedExtractionUsed'));
});
