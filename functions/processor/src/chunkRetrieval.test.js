const test = require('node:test');
const assert = require('node:assert/strict');
const { createChunkIndex } = require('./chunkRetrieval');
const { QdrantVectorDatabase } = require('@xtract/common');

const chunks = [
  { index: 0, text: 'Invoice number A1' },
  { index: 1, text: 'Total amount 500' },
];
const metrics = { model: 'test', inputTokens: 1, totalTokens: 1, estimatedCostUsd: 0.01 };
const embed = async (text) => ({ embedding: text.includes('amount') ? [0, 1] : [1, 0], metrics });

test('uses semantic and keyword matches and accounts for embeddings', async () => {
  const index = await createChunkIndex(chunks, { index: 'memory' }, { embed });
  assert.equal((await index.search('total amount', 1))[0].index, 1);
  assert.equal(index.metrics.inputTokens, 3);
  await index.close();
});

test('isolates Qdrant entries and removes the temporary collection', async () => {
  const calls = [];
  let indexedPoints;
  const database = {
    collectionName: 'temporary',
    request: async (path, options = {}) => {
      calls.push({ path, ...options });
      if (path === '/collections') return { result: { collections: [] } };
      if (path.endsWith('/points/search')) return { result: [{ score: 1, payload: indexedPoints[1].payload }] };
      return {};
    },
    ensureCollection: async (size) => assert.equal(size, 2),
    upsert: async (points) => {
      indexedPoints = points;
      assert.equal(points.length, 2);
      assert.equal(points[0].payload.documentId, 'document-1');
      assert.equal('text' in points[0].payload, false);
    },
  };
  const index = await createChunkIndex(chunks, {
    index: 'qdrant', documentId: 'document-1', embeddingOptions: {},
  }, { embed, database });
  assert.equal((await index.search('total amount', 1))[0].index, 1);
  const search = calls.find((call) => call.path.endsWith('/points/search'));
  assert.equal(JSON.parse(search.body).filter.must[0].match.value, 'document-1');
  await index.close();
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('rejects unscoped Qdrant results instead of silently falling back to keywords', async () => {
  const database = {
    collectionName: 'temporary',
    request: async (path) => path === '/collections'
      ? { result: { collections: [] } }
      : { result: [{ score: 1, payload: { chunkIndex: 0, documentId: 'other', attemptId: 'other' } }] },
    ensureCollection: async () => {},
    upsert: async () => {},
  };
  const index = await createChunkIndex(chunks, {
    index: 'qdrant', documentId: 'document-1', embeddingOptions: {},
  }, { embed, database });
  await assert.rejects(index.search('invoice', 1), /unscoped/);
  await index.close();
});

test('cleans abandoned temporary collections and cleans up after an index failure', async () => {
  const deleted = [];
  const stale = `xtract_chunks_${Date.now() - 25 * 60 * 60 * 1000}_${'a'.repeat(32)}`;
  const database = {
    collectionName: 'temporary',
    request: async (path, options = {}) => {
      if (path === '/collections') return { result: { collections: [{ name: stale }, { name: 'classifier' }] } };
      if (options.method === 'DELETE') deleted.push(path);
      return {};
    },
    ensureCollection: async () => {},
    upsert: async () => { throw new Error('upsert failed'); },
  };
  await assert.rejects(createChunkIndex(chunks, {
    index: 'qdrant', documentId: 'document-1', embeddingOptions: {},
  }, { embed, database }), /upsert failed/);
  assert.deepEqual(deleted, [`/collections/${stale}`, '/collections/temporary']);
});

test('uses the Qdrant client to index, search and delete document vectors', async () => {
  let points;
  const operations = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    operations.push(`${options.method || 'GET'} ${path}`);
    const respond = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => '' });
    if (path === '/collections') return respond(200, { result: { collections: [] } });
    if (path.endsWith('/points/search')) {
      return respond(200, { result: [{ score: 1, payload: points[0].payload }] });
    }
    if (path.endsWith('/points')) {
      points = JSON.parse(options.body).points;
      return respond(200, { result: true });
    }
    if (!options.method) return respond(404, {});
    return respond(200, { result: true });
  };
  const database = new QdrantVectorDatabase({ baseUrl: 'http://qdrant.test', collectionName: 'temporary', fetch });
  const index = await createChunkIndex(chunks, {
    index: 'qdrant', documentId: 'document-1', embeddingOptions: {},
  }, { embed, database });
  assert.equal((await index.search('invoice', 1))[0].index, 0);
  await index.close();
  assert.ok(operations.includes('PUT /collections/temporary/points'));
  assert.ok(operations.includes('POST /collections/temporary/points/search'));
  assert.ok(operations.includes('DELETE /collections/temporary'));
});
