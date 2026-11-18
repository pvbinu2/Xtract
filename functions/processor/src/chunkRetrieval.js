const { randomUUID } = require('crypto');
const { QdrantVectorDatabase } = require('@xtract/common');
const { cosineSimilarity, rankSearchResults } = require('./extractionChunks');
const { embedText } = require('./classifier');

const COLLECTION_PREFIX = 'xtract_chunks_';
const STALE_COLLECTION_AGE_MS = 24 * 60 * 60 * 1000;

function addEmbeddingMetrics(total, next) {
  total.inputTokens += Number(next.inputTokens || 0);
  total.totalTokens += Number(next.totalTokens || 0);
  total.estimatedCostUsd += Number(next.estimatedCostUsd || 0);
  total.model = next.model || total.model;
}

async function createChunkIndex(chunks, options = {}, dependencies = {}) {
  if (!chunks.length) throw new Error('Cannot index an empty document.');
  if (!['memory', 'qdrant'].includes(options.index)) throw new Error('Invalid chunk vector index.');
  const embed = dependencies.embed || embedText;
  const metrics = { model: 'none', inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
  const vectors = [];
  for (const chunk of chunks) {
    const result = await embed(chunk.text, options.embeddingOptions);
    addEmbeddingMetrics(metrics, result.metrics);
    if (vectors.length) cosineSimilarity(vectors[0], result.embedding);
    else cosineSimilarity(result.embedding, result.embedding);
    vectors.push(result.embedding);
  }

  let database;
  const attemptId = randomUUID();
  if (options.index === 'qdrant') {
    const collectionName = `${COLLECTION_PREFIX}${Date.now()}_${attemptId.replace(/-/g, '')}`;
    database = dependencies.database || new QdrantVectorDatabase({
      baseUrl: options.embeddingOptions.vectorDatabaseEndpoint,
      apiKey: options.embeddingOptions.vectorDatabaseApiKey,
      collectionName,
    });
    const collections = await database.request('/collections');
    if (!Array.isArray(collections?.result?.collections)) throw new Error('Qdrant returned an invalid collection list.');
    for (const collection of collections.result.collections) {
      const match = new RegExp(`^${COLLECTION_PREFIX}(\\d+)_([a-f0-9]{32})$`).exec(collection.name);
      if (match && Date.now() - Number(match[1]) > STALE_COLLECTION_AGE_MS) {
        await database.request(`/collections/${collection.name}`, { method: 'DELETE' });
      }
    }
    await database.ensureCollection(vectors[0].length);
    try {
      await database.upsert(chunks.map((chunk, index) => ({
        id: index,
        vector: vectors[index],
        payload: { chunkIndex: chunk.index, documentId: options.documentId, attemptId },
      })));
    } catch (error) {
      try {
        await database.request(`/collections/${database.collectionName}`, { method: 'DELETE' });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Chunk indexing and vector cleanup both failed.');
      }
      throw error;
    }
  }

  return {
    metrics,
    async search(query, limit = 5) {
      const result = await embed(query, options.embeddingOptions);
      addEmbeddingMetrics(metrics, result.metrics);
      cosineSimilarity(result.embedding, vectors[0]);
      const scores = new Map();
      if (database) {
        const response = await database.request(`/collections/${database.collectionName}/points/search`, {
          method: 'POST',
          body: JSON.stringify({
            vector: result.embedding,
            limit: Math.min(chunks.length, Math.max(limit, 20)),
            with_payload: true,
            filter: { must: [
              { key: 'documentId', match: { value: options.documentId } },
              { key: 'attemptId', match: { value: attemptId } },
            ] },
          }),
        });
        if (!Array.isArray(response.result) || !response.result.length) {
          throw new Error('Chunk vector search returned no results for the indexed document.');
        }
        for (const point of response.result) {
          if (point.payload?.documentId !== options.documentId || point.payload?.attemptId !== attemptId ||
            !Number.isInteger(point.payload?.chunkIndex) || !chunks.some((chunk) => chunk.index === point.payload.chunkIndex) ||
            !Number.isFinite(point.score)) {
            throw new Error('Chunk vector search returned an invalid or unscoped result.');
          }
          scores.set(point.payload.chunkIndex, point.score);
        }
      } else {
        chunks.forEach((chunk, index) => scores.set(chunk.index, cosineSimilarity(result.embedding, vectors[index])));
      }
      return rankSearchResults(chunks, query, scores).slice(0, limit).map((result) => result.chunk);
    },
    async close() {
      if (database) await database.request(`/collections/${database.collectionName}`, { method: 'DELETE' });
    },
  };
}

module.exports = { createChunkIndex };
