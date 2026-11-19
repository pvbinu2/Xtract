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
      ? { values: [{ key: field.key, value: 'A12', evidence: 'Invoice number: A12', confidence: 0.9 }], metrics }
      : { values: [{ key: field.key, value: '', evidence: '', confidence: 0 }], metrics },
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
      ? { values: [{ key: field.key, value: 'A1', evidence: 'A1' }], metrics }
      : { values: [{ key: field.key, value: 'B2', evidence: 'B2' }], metrics },
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

test('uses table description and column names to retrieve chunks with adjacent context', async () => {
  const searchQueries = [];
  const processedChunks = [];
  const result = await extractChunkedDocument({
    text: 'a'.repeat(16000),
    fields: [{
      key: 'line_items',
      label: 'Line items',
      description: 'Purchased goods and services',
      type: 'table',
      columns: [
        { key: 'sku', label: 'Product code', description: 'Item identifier' },
        { key: 'amount', label: 'Line total', description: 'Extended price' },
      ],
    }],
    createIndex: async (chunks) => ({
      metrics: {},
      search: async (query) => {
        searchQueries.push(query);
        return [chunks[2]];
      },
      close: async () => {},
    }),
    extractChunk: async (_, chunk) => {
      processedChunks.push(chunk.index);
      return { value: [{ value: { source: chunk.index }, evidence: 'a' }], metrics };
    },
  });
  assert.equal(searchQueries.length, 1);
  for (const term of ['Purchased goods and services', 'Product code', 'sku', 'Item identifier', 'Line total', 'amount', 'Extended price']) {
    assert.ok(searchQueries[0].includes(term));
  }
  assert.deepEqual(processedChunks, [1, 2, 3]);
  assert.deepEqual(result.values[0].value.map((row) => row.source), [1, 2, 3]);
});

test('groups scalar fields and extracts each table field in a separate retrieved-chunk pass', async () => {
  const fields = [
    { key: 'items_a', label: 'Items A', type: 'table' },
    { key: 'invoice_number', label: 'Invoice number', type: 'string' },
    { key: 'items_b', label: 'Items B', type: 'table' },
    { key: 'vendor', label: 'Vendor', type: 'string' },
  ];
  const calls = [];
  const text = `${'A B\n'.repeat(2500)}`;
  const result = await extractChunkedDocument({
    text, fields, createIndex: fakeIndex([0]).create,
    extractChunk: async (operation, chunk) => {
      calls.push({ type: operation.type, fieldKeys: operation.fields?.map((item) => item.key), fieldKey: operation.field?.key, chunk: chunk.index });
      if (operation.type === 'scalar') {
        return {
          values: [
            { key: 'invoice_number', value: 'A', evidence: 'A', confidence: 0.9 },
            { key: 'vendor', value: 'B', evidence: 'B', confidence: 0.8 },
          ],
          metrics,
        };
      }
      return { value: [], metrics };
    },
  });
  const scalarCalls = calls.filter((call) => call.type === 'scalar');
  const tableACalls = calls.filter((call) => call.fieldKey === 'items_a');
  const tableBCalls = calls.filter((call) => call.fieldKey === 'items_b');
  assert.ok(scalarCalls.length > 0);
  assert.ok(scalarCalls.every((call) => call.fieldKeys.join(',') === 'invoice_number,vendor'));
  assert.equal(scalarCalls.length, new Set(scalarCalls.map((call) => call.chunk)).size);
  assert.equal(tableACalls.length, 2);
  assert.equal(tableBCalls.length, 2);
  assert.deepEqual(result.values.map((value) => value.key), fields.map((item) => item.key));
  assert.equal(result.values[1].value, 'A');
  assert.equal(result.values[3].value, 'B');
});

test('rejects fabricated evidence and closes the index', async () => {
  const index = fakeIndex([0]);
  await assert.rejects(extractChunkedDocument({
    text: 'Invoice A1', fields: [field], createIndex: index.create,
    extractChunk: async () => ({ values: [{ key: field.key, value: 'B2', evidence: 'B2' }], metrics }),
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

test('limits concurrent chunk requests and preserves table row order despite out-of-order completion', async () => {
  const text = `${'a'.repeat(4000)}${'b'.repeat(4000)}${'c'.repeat(4000)}${'d'.repeat(4000)}`;
  let active = 0;
  let peak = 0;
  const completed = [];
  const result = await extractChunkedDocument({
    text,
    fields: [{ key: 'items', label: 'Items', type: 'table' }],
    batchSize: 2,
    createIndex: fakeIndex([0, 2]).create,
    extractChunk: async (_, chunk) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, chunk.index % 2 === 0 ? 20 : 2));
      active -= 1;
      completed.push(chunk.index);
      return { value: [{ value: { index: chunk.index }, evidence: chunk.text[0] }], metrics };
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(completed, [1, 0, 3, 2]);
  assert.deepEqual(result.values[0].value.map((row) => row.index), [0, 1, 2, 3]);
  assert.equal(result.metrics.inputTokens, 4);
});

test('waits for all in-flight requests before closing the index after a failure', async () => {
  let release;
  let closed = false;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const operation = extractChunkedDocument({
    text: 'a'.repeat(12000),
    fields: [{ key: 'items', label: 'Items', type: 'table' }],
    batchSize: 2,
    createIndex: async (chunks) => ({
      search: async () => [chunks[0]],
      close: async () => { closed = true; },
    }),
    extractChunk: (_, chunk) => {
      if (chunk.index === 0) throw new Error('request failed');
      started();
      return pending.then(() => ({ value: [], metrics }));
    },
  });
  await startedPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await assert.rejects(operation, /request failed/);
  assert.equal(closed, true);
});

test('rejects invalid batch sizes before creating an index', async () => {
  for (const batchSize of [0, 17, 1.5]) {
    await assert.rejects(extractChunkedDocument({
      text: 'text', fields: [field], batchSize,
      createIndex: async () => { throw new Error('must not create index'); },
      extractChunk: async () => ({}),
    }), /batch size must be an integer between 1 and 16/);
  }
});
