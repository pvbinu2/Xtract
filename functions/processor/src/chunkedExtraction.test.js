const test = require('node:test');
const assert = require('node:assert/strict');
const { extractChunkedDocument } = require('./chunkedExtraction');

const field = { key: 'invoice_number', label: 'Invoice number', type: 'string' };
const metrics = { model: 'test', inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 };

function fakeIndex(chosen) {
  let closed = false;
  return {
    create: async (chunks) => ({
      metrics: { inputTokens: 2, outputTokens: 0, totalTokens: 2, estimatedCostUsd: 0 },
      search: async () => chosen.map((index) => chunks[index]),
      close: async () => { closed = true; },
    }),
    wasClosed: () => closed,
  };
}

test('finds a missing scalar in a non-retrieved chunk', async () => {
  const index = fakeIndex([0]);
  const text = `${'a'.repeat(8000)}Invoice number: A12`;
  const logs = [];
  const result = await extractChunkedDocument({
    text, fields: [field], createIndex: index.create,
    log: (message) => logs.push(message),
    extractChunk: async (_, chunk) => chunk.index === 2
      ? { value: 'A12', evidence: 'Invoice number: A12', confidence: 0.9, metrics }
      : { value: '', metrics },
  });
  assert.equal(result.values[0].value, 'A12');
  assert.equal(result.values[0].sourceEvidence[0].start, 8000);
  assert.equal(result.metrics.inputTokens, 3);
  assert.equal(index.wasClosed(), true);
  assert.ok(logs.some((message) => message.includes('scanning remaining chunks')));
  assert.ok(logs.some((message) => message.includes('Chunk index closed')));
  assert.ok(logs.every((message) => !message.includes('Invoice')));
});

test('flags conflicting values with evidence instead of selecting one', async () => {
  const index = fakeIndex([0, 1]);
  const result = await extractChunkedDocument({
    text: `${'A1 '.repeat(1333)}A1 B2`, fields: [field], createIndex: index.create,
    extractChunk: async (_, chunk) => chunk.index === 0
      ? { value: 'A1', evidence: 'A1', metrics }
      : { value: 'B2', evidence: 'B2', metrics },
  });
  assert.equal(result.values[0].needsReview, true);
  assert.equal(result.values[0].value, '');
  assert.equal(result.values[0].reviewCandidates.length, 2);
});

test('processes every table chunk and retains repeated rows from different source positions', async () => {
  const index = fakeIndex([0]);
  const text = `${'row\n'.repeat(1000)}row\n`;
  const result = await extractChunkedDocument({
    text, fields: [{ key: 'items', label: 'Items', type: 'table' }], createIndex: index.create,
    extractChunk: async () => ({ value: [{ value: { description: 'row' }, evidence: 'row' }], metrics }),
  });
  assert.equal(result.values[0].value.length, 2);
  assert.notEqual(result.values[0].sourceEvidence[0].start, result.values[0].sourceEvidence[1].start);
});

test('rejects fabricated evidence and closes the index', async () => {
  const index = fakeIndex([0]);
  await assert.rejects(extractChunkedDocument({
    text: 'Invoice A1', fields: [field], createIndex: index.create,
    extractChunk: async () => ({ value: 'B2', evidence: 'B2', metrics }),
  }), /not found/);
  assert.equal(index.wasClosed(), true);
});

test('reports both extraction and index cleanup failures', async () => {
  await assert.rejects(extractChunkedDocument({
    text: 'Invoice A1',
    fields: [field],
    createIndex: async (chunks) => ({
      search: async () => chunks,
      close: async () => { throw new Error('cleanup failed'); },
    }),
    extractChunk: async () => { throw new Error('extraction failed'); },
  }), (error) => error instanceof AggregateError && error.errors.length === 2);
});

test('supplies a Markdown table header to continuation chunks', async () => {
  const index = fakeIndex([0]);
  const text = `| Description | Amount |\n| --- | --- |\n${'| item | 10 |\n'.repeat(500)}`;
  const continuations = [];
  await extractChunkedDocument({
    text, fields: [{ key: 'items', label: 'Items', type: 'table' }], createIndex: index.create,
    extractChunk: async (_, chunk) => {
      if (chunk.index > 0) continuations.push(chunk.tableHeader);
      return { value: [], metrics };
    },
  });
  assert.ok(continuations.length > 0);
  assert.ok(continuations.every((header) => header === '| Description | Amount |\n| --- | --- |'));
});

test('fails visibly rather than splitting an oversized Markdown table row', async () => {
  await assert.rejects(extractChunkedDocument({
    text: `| ${'a'.repeat(4000)} |`, fields: [{ key: 'items', label: 'Items', type: 'table' }],
    createIndex: fakeIndex([0]).create, extractChunk: async () => ({ value: [], metrics }),
  }), /table row exceeds/);
});
