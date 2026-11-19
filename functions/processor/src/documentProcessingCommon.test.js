const test = require('node:test');
const assert = require('node:assert/strict');
const { recordDocumentProcessingError, transitionDocumentStatus } = require('./documentProcessingCommon');

test('guarded transition atomically updates status and unsets fields', async () => {
  const calls = [];
  const documents = { updateOne: async (filter, update) => {
    calls.push({ filter, update });
    return { matchedCount: 1 };
  } };
  const result = await transitionDocumentStatus(
    documents, 'document', 'extraction_completed', { extractedData: [{ value: '$10' }] },
    ['chunkExtractionAttemptId', 'reprocessOptions'],
    { completed: true, guard: { status: 'extraction_started', chunkExtractionAttemptId: 'attempt' } },
  );
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filter.chunkExtractionAttemptId, 'attempt');
  assert.deepEqual(calls[0].update[0].$set.extractedData, { $literal: [{ value: '$10' }] });
  assert.deepEqual(calls[0].update[1], { $unset: ['chunkExtractionAttemptId', 'reprocessOptions'] });
});

test('a stale guarded transition does not unset fields', async () => {
  let calls = 0;
  const documents = { updateOne: async () => { calls += 1; return { matchedCount: 0 }; } };
  const result = await transitionDocumentStatus(
    documents, 'document', 'extraction_completed', {}, ['reprocessOptions'],
    { guard: { status: 'extraction_started', chunkExtractionAttemptId: 'stale' } },
  );
  assert.equal(result, false);
  assert.equal(calls, 1);
});

test('does not apply an uncaught chunk error to a different extraction attempt', async () => {
  let updates = 0;
  const documents = {
    findOne: async () => ({
      status: 'extraction_started',
      revision: 3,
      chunkExtractionAttemptId: 'current-attempt',
    }),
    updateOne: async () => {
      updates += 1;
      return { matchedCount: 1 };
    },
  };
  const recorded = await recordDocumentProcessingError(
    documents,
    { documentId: '0123456789abcdef01234567', chunkExtractionAttemptId: 'stale-attempt' },
    'chunkExtractDocument',
    new Error('stale request failed'),
  );
  assert.equal(recorded, false);
  assert.equal(updates, 0);
});
