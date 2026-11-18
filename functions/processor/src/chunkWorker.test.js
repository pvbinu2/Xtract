const test = require('node:test');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

function stub(moduleName, exports) {
  const filename = require.resolve(moduleName);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

test('routes large prepared text through the separate chunk worker', async () => {
  const registrations = new Map();
  stub('@azure/functions', {
    app: { serviceBusQueue: (name, registration) => registrations.set(name, registration) },
    output: { serviceBusQueue: (options) => options },
  });
  stub('./aiConcurrency', { withExtractionConcurrency: (handler) => handler });
  stub('./documentEvents', { publishDocumentChanged: async () => {} });
  stub('./configurationCache', { getConfiguration: async () => ({
    chunkedExtractionEnabled: true,
    chunkedExtractionThreshold: 1000,
    chunkedExtractionIndex: 'memory',
    chunkedExtractionBatchSize: 1,
  }) });
  stub('./pdfBoundingBox', { attachBoundingBoxes: async (_, values) => values });
  let reextractions = 0;
  stub('./documentText', {
    extractDocumentSpatialItems: async () => [],
    extractDocumentContent: async () => { reextractions += 1; return { text }; },
  });
  let embeddingFails = false;
  stub('./classifier', { embedText: async () => {
    if (embeddingFails) throw new Error('Embedding service unavailable');
    return {
      embedding: [1, 0],
      metrics: { model: 'embedding', inputTokens: 1, totalTokens: 1, estimatedCostUsd: 0.01 },
    };
  } });

  const document = {
    _id: new ObjectId(), filePath: '/test.pdf', fileName: 'test.pdf',
    documentTypeId: new ObjectId(), textArtifactComplete: true, textArtifactMode: 'ocr', status: 'classification_completed',
  };
  const documentType = {
    _id: document.documentTypeId, name: 'Invoice', extractionAiProvider: 'ollama', extractionModel: 'test',
    fields: [{ key: 'invoice_number', label: 'Invoice number', type: 'string', selected: true }],
  };
  let text = `Invoice: A1\n${'x'.repeat(5000)}`;
  let recorded = 0;
  const documents = {
    findOne: async () => document,
    updateOne: async (filter, update) => {
      if (document.status !== filter.status || document.chunkExtractionAttemptId) return { matchedCount: 0 };
      Object.assign(document, update.$set);
      return { matchedCount: 1 };
    },
  };
  stub('./documentProcessingCommon', {
    ObjectId,
    getClient: async () => ({ db: () => ({ collection: (name) => name === 'incomingdocuments' ? documents : { findOne: async () => documentType } }) }),
    hasResolvableDocumentFile: () => true,
    markDocumentFailed: async (_, __, error, guard) => {
      if (guard && (document.status !== guard.status || document.chunkExtractionAttemptId !== guard.chunkExtractionAttemptId)) return false;
      document.status = 'failed'; document.error = error; return true;
    },
    normalizeDocumentTypeId: (doc) => doc.documentTypeId,
    processingOptionsFor: () => ({
      aiOptions: { ollamaBaseUrl: 'http://example.test', embeddingProvider: 'ollama' },
      reprocessOptions: {}, useOcrForDocumentProcessing: true, textOptions: { mode: 'ocr' },
    }),
    extractedDataUpdate: (_, values) => ({ $set: { extractedData: values }, $unset: {} }),
    recordBusinessReviewProcessing: async () => { recorded += 1; },
    removeTempFile: async () => {},
    resolveDocumentFile: async () => document.filePath,
    resolvePreparedDocumentText: async () => document.textArtifactComplete ? text : text.slice(0, 60000),
    resolveMessage: (message) => message,
    transitionDocumentStatus: async (_, __, status, fields = {}, unset = [], timing = {}) => {
      if (timing.guard && (document.status !== timing.guard.status ||
        ('chunkExtractionAttemptId' in timing.guard && document.chunkExtractionAttemptId !== timing.guard.chunkExtractionAttemptId))) return false;
      Object.assign(document, fields, { status });
      unset.forEach((key) => { delete document[key]; });
      return true;
    },
  });

  const previousFetch = global.fetch;
  const verificationLengths = [];
  global.fetch = async (_, options) => {
    const prompt = JSON.parse(options.body).messages[0].content;
    const target = prompt.includes('Target chunk:\n') ? prompt.split('Target chunk:\n').at(-1) : prompt;
    let value = target.includes('Invoice: A1')
      ? { value: 'A1', evidence: 'Invoice: A1', confidence: 0.95 }
      : { value: '', confidence: 0 };
    if (prompt.includes('Return this exact shape:')) {
      value = { fields: [{ key: 'invoice_number', value: 'A1', confidence: 0.95 }] };
    }
    if (prompt.includes('Verify extracted values from')) {
      verificationLengths.push(prompt.length);
      value = { needsCorrection: false, issues: [] };
    }
    return { ok: true, json: async () => ({
      model: 'test', message: { content: JSON.stringify(value) },
      prompt_eval_count: 10, eval_count: 5,
    }) };
  };
  try {
    const { extractChunkField } = require('./functions/extractDocument');
    require('./functions/chunkExtractDocument');
    const outputs = new Map();
    const errors = [];
    const logs = [];
    const context = { extraOutputs: outputs, warn: () => {}, info: (message) => logs.push(message), error: (message) => errors.push(message) };
    await registrations.get('extractDocument').handler({ documentId: String(document._id) }, context);
    assert.equal(outputs.size, 1);
    const [binding, message] = [...outputs.entries()][0];
    assert.equal(binding.queueName, 'document-chunk-extraction');
    assert.equal(JSON.stringify(message).includes(text), false);
    outputs.clear();
    await registrations.get('extractDocument').handler({ documentId: String(document._id) }, context);
    const retriedMessage = [...outputs.values()][0];
    assert.equal(JSON.parse(retriedMessage).chunkExtractionAttemptId, JSON.parse(message).chunkExtractionAttemptId);
    await Promise.all([
      registrations.get('chunkExtractDocument').handler(JSON.parse(message), context),
      registrations.get('chunkExtractDocument').handler(JSON.parse(retriedMessage), context),
    ]);
    assert.equal(document.status, 'extraction_completed');
    assert.equal(document.chunkedExtractionUsed, true);
    assert.equal(document.extractedData[0].value, 'A1');
    assert.equal(document.extractedData[0].sourceEvidence[0].quote, 'Invoice: A1');
    assert.equal(document.processingMetrics.embeddingCostUsd, 0.04);
    assert.equal(recorded, 1);
    assert.ok(logs.some((message) => message.includes('Processing field')));
    assert.ok(logs.some((message) => message.includes('batchSize=1')));
    assert.ok(logs.every((message) => message.startsWith(`[correlationId=${document._id}]`)));
    await registrations.get('chunkExtractDocument').handler(JSON.parse(message), context);
    assert.equal(recorded, 1);

    text = 'Invoice: A1';
    document.status = 'classification_completed';
    outputs.clear();
    await registrations.get('extractDocument').handler({ documentId: String(document._id) }, context);
    assert.equal(outputs.size, 0);
    assert.equal(document.chunkedExtractionUsed, false);
    assert.equal(document.extractedData[0].value, 'A1');
    assert.equal(recorded, 2);

    text = `Invoice: A1\n${'x'.repeat(5000)}`;
    document.status = 'classification_completed';
    outputs.clear();
    await registrations.get('extractDocument').handler({ documentId: String(document._id) }, context);
    embeddingFails = true;
    await registrations.get('chunkExtractDocument').handler(JSON.parse([...outputs.values()][0]), context);
    assert.equal(document.status, 'failed');
    assert.equal(document.chunkedExtractionUsed, false);
    assert.match(document.error, /Embedding service unavailable/);
    assert.equal(recorded, 2);
    assert.equal(errors.length, 1);

    embeddingFails = false;
    document.status = 'classification_completed';
    document.chunkExtractionAttemptId = undefined;
    outputs.clear();
    await registrations.get('extractDocument').handler({ documentId: String(document._id) }, context);
    const staleMessage = JSON.parse([...outputs.values()][0]);
    document.status = 'received';
    document.chunkExtractionAttemptId = undefined;
    await registrations.get('chunkExtractDocument').handler(staleMessage, context);
    assert.equal(document.status, 'received');
    assert.equal(recorded, 2);

    document.status = 'classification_completed';
    document.textArtifactComplete = false;
    documentType.extractionVerification = true;
    text = `${'x'.repeat(65000)}\nInvoice: A1`;
    outputs.clear();
    await registrations.get('extractDocument').handler({ documentId: String(document._id) }, context);
    await registrations.get('chunkExtractDocument').handler(JSON.parse([...outputs.values()][0]), context);
    assert.equal(document.status, 'extraction_completed');
    assert.equal(document.extractedData[0].value, 'A1');
    assert.equal(document.extractedData[0].sourceEvidence[0].start, 65001);
    assert.equal(reextractions, 2);
    assert.ok(verificationLengths.length > 0);
    assert.ok(verificationLengths.every((length) => length < 10000));

    global.fetch = async () => ({ ok: true, json: async () => ({
      model: 'test', message: { content: 'sensitive invalid response' },
    }) });
    await assert.rejects(extractChunkField(
      document, { ...documentType, extractionVerification: false }, documentType.fields[0],
      { text: 'Invoice: A1' }, { aiProvider: 'ollama', ollamaModel: 'test' }, 'OCR',
    ), (error) => /invalid JSON/.test(error.message) && !error.message.includes('sensitive'));
  } finally {
    global.fetch = previousFetch;
  }
});
