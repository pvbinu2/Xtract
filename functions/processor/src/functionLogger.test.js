const test = require('node:test');
const assert = require('node:assert/strict');
const { InvocationContext } = require('@azure/functions');
const { getFunctionLogger, withFunctionLogging } = require('./functionLogger');
const documentProcessingCommon = require('./documentProcessingCommon');
const documentEvents = require('./documentEvents');

test('correlates concurrent invocation and retry logs without mixing document IDs', async () => {
  const entries = [];
  const handler = withFunctionLogging('extract', 'queue', async (_, context) => {
    await new Promise((resolve) => setImmediate(resolve));
    context.info('inside handler');
    getFunctionLogger().write('warn', 'retrying');
    return 'result';
  }, { documentMessage: true });
  const ids = ['0123456789abcdef01234567', 'abcdef0123456789abcdef01'];
  const results = await Promise.all(ids.map((id) => handler(JSON.stringify({ documentId: id }), new InvocationContext({
    invocationId: id,
    logHandler: (level, ...args) => entries.push({ id, level, message: args.join(' ') }),
  }))));
  assert.deepEqual(results, ['result', 'result']);
  assert.equal(entries.length, 8);
  for (const entry of entries) assert.match(entry.message, new RegExp(`^\\[correlationId=${entry.id}\\]`));
  assert.equal(getFunctionLogger(), undefined);
});

test('uses an invocation fallback and preserves thrown errors', async () => {
  const entries = [];
  const error = new Error('test failure');
  const handler = withFunctionLogging('extract', 'queue', async (_, context) => {
    context.warn('invalid message');
    throw error;
  }, { documentMessage: true });
  const context = new InvocationContext({
    invocationId: 'invocation-1',
    logHandler: (_, ...args) => entries.push(args.join(' ')),
  });
  await assert.rejects(handler({ documentId: 'invalid\nsecret' }, context), (actual) => actual === error);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.includes('[correlationId=invocation:invocation-1]')));
  assert.ok(entries.every((entry) => !entry.includes('secret')));
});

test('switches to the document ID once ingestion has resolved it', async () => {
  const entries = [];
  const handler = withFunctionLogging('ingest', 'blob', async (_, context) => {
    context.functionLogger.setDocumentId('0123456789abcdef01234567');
    context.info('document resolved');
  });
  await handler(null, new InvocationContext({
    invocationId: 'ingest-1',
    logHandler: (_, ...args) => entries.push(args.join(' ')),
  }));
  assert.match(entries[0], /correlationId=invocation:ingest-1/);
  assert.ok(entries.slice(1).every((entry) => entry.includes('correlationId=0123456789abcdef01234567')));
});

test('persists uncaught processing errors on the document instance', async () => {
  const documentId = '0123456789abcdef01234567';
  const originalGetClient = documentProcessingCommon.getClient;
  const originalPublishDocumentChanged = documentEvents.publishDocumentChanged;
  const document = { status: 'classification_started', revision: 7 };
  let update;
  let publishedFields;
  const documents = {
    findOne: async () => document,
    updateOne: async (filter, operation) => {
      update = { filter, operation };
      return { matchedCount: 1 };
    },
  };
  documentProcessingCommon.getClient = async () => ({
    db: () => ({ collection: () => documents }),
  });
  documentEvents.publishDocumentChanged = async (_, __, changedFields) => {
    publishedFields = changedFields;
  };

  const error = new Error('configuration lookup failed');
  const handler = withFunctionLogging('classifyDocument', 'document-classification', async () => {
    throw error;
  }, { documentMessage: true });

  try {
    await assert.rejects(
      handler({ documentId }, new InvocationContext({
        invocationId: 'capture-error',
        logHandler: () => {},
      })),
      (actual) => actual === error,
    );
    assert.equal(update.filter.status, 'classification_started');
    assert.equal(update.filter.revision, 7);
    assert.equal(update.operation[0].$set.status, 'failed');
    assert.match(update.operation[0].$set.error.$literal, /Unhandled classifyDocument processing error/);
    assert.ok(update.operation[0].$set.error.$literal.includes(error.stack));
    assert.deepEqual(publishedFields, ['status', 'error']);
  } finally {
    documentProcessingCommon.getClient = originalGetClient;
    documentEvents.publishDocumentChanged = originalPublishDocumentChanged;
  }
});
