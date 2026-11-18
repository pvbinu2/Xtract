const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

function stub(moduleName, exports) {
  const filename = require.resolve(moduleName);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

test('classification regenerates incomplete legacy text and preserves complete prepared text', async () => {
  const id = new ObjectId();
  const fullText = `${'a'.repeat(65000)}late evidence`;
  const receivedTexts = [];
  let document = { _id: id, fileName: 'file.pdf', textArtifactMode: 'ocr', textArtifactComplete: false };
  let extractionCount = 0;
  const documentType = { _id: new ObjectId(), name: 'type', category: 'category' };
  let handler;
  stub('@azure/functions', {
    app: { serviceBusQueue: (_, registration) => { handler = registration.handler; } },
    output: { serviceBusQueue: (options) => options },
  });
  stub('./aiConcurrency', { withClassificationConcurrency: (fn) => fn });
  stub('./classifier', {
    normalizeObjectId: (value) => value,
    classifyDocument: async (_, __, options) => {
      receivedTexts.push(options.preparedText);
      return { documentType, score: 1, method: 'rag' };
    },
  });
  stub('./documentText', {
    extractDocumentContent: async (_, limit) => {
      assert.equal(limit, Infinity);
      extractionCount += 1;
      return { text: fullText };
    },
  });
  stub('./configurationCache', { getConfiguration: async () => ({}) });
  stub('./documentEvents', { publishDocumentChanged: async () => {} });
  stub('./documentProcessingCommon', {
    ObjectId,
    getClient: async () => ({ db: () => ({ collection: (name) => name === 'incomingdocuments'
      ? { findOne: async () => document, updateOne: async () => {} }
      : { find: () => ({ toArray: async () => [documentType] }) } }) }),
    hasResolvableDocumentFile: () => true,
    markDocumentFailed: async () => { throw new Error('unexpected failure'); },
    normalizeDocumentTypeId: () => undefined,
    processingOptionsFor: () => ({ aiOptions: {}, textOptions: { mode: 'ocr' } }),
    removeTempFile: async () => {},
    resolveDocumentFile: async () => '/test.pdf',
    resolveDocumentId: (message) => message.documentId,
    resolvePreparedDocumentText: async () => fullText,
    transitionDocumentStatus: async () => {},
  });
  require('./functions/classifyDocument');
  const context = { info: () => {}, warn: () => {}, error: () => {}, extraOutputs: { set: () => {} } };
  await handler({ documentId: String(id) }, context);
  document = { ...document, textArtifactComplete: true };
  await handler({ documentId: String(id) }, context);
  assert.deepEqual(receivedTexts, [fullText, fullText]);
  assert.equal(extractionCount, 1);
});
