const test = require('node:test');
const assert = require('node:assert/strict');

const commonPath = require.resolve('@xtract/common');
const blobPath = require.resolve('./blobStorage');
const configurationPath = require.resolve('./configurationCache');
const concurrencyPath = require.resolve('./aiConcurrency');
const common = require('@xtract/common');
const originalCommon = require.cache[commonPath];
const originalBlob = require.cache[blobPath];
const originalConfiguration = require.cache[configurationPath];
const originalConcurrency = require.cache[concurrencyPath];

test('searches every embedding-window chunk and lets the LLM choose from all retrieved types', async () => {
  const firstId = '0123456789abcdef01234567';
  const lastId = 'abcdef0123456789abcdef01';
  const types = [
    { _id: firstId, name: 'First', category: 'A', finalized: true, includeInClassification: true, sampleFiles: ['a.pdf'] },
    { _id: lastId, name: 'Last', category: 'B', finalized: true, includeInClassification: true, sampleFiles: ['b.pdf'] },
  ];
  const searched = [];
  class Database {
    async ensureCollection() {}
    async search(vector) {
      searched.push(vector[0]);
      return [{ id: vector[0], score: 0.9, payload: { documentTypeId: vector[0] === 2 ? lastId : firstId } }];
    }
  }
  require.cache[commonPath] = { id: commonPath, filename: commonPath, loaded: true, exports: { ...common, QdrantVectorDatabase: Database } };
  require.cache[blobPath] = { id: blobPath, filename: blobPath, loaded: true, exports: { isConfigured: () => true } };
  require.cache[configurationPath] = { id: configurationPath, filename: configurationPath, loaded: true, exports: { getConfiguration: async () => ({}) } };
  delete require.cache[concurrencyPath];
  delete require.cache[require.resolve('./classifier')];
  const { classifyDocument } = require('./classifier');
  const previousFetch = global.fetch;
  const sections = [];
  let finalPrompt;
  let activeChat = 0;
  let maxActiveChat = 0;
  const embeddingRequests = [];
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/api/embed')) {
      embeddingRequests.push(body);
      if (body.input.length > 10000) {
        return { ok: false, status: 400, text: async () => 'input length exceeds maximum context length' };
      }
      return { ok: true, json: async () => ({
        embeddings: [[body.input.includes('LATE_SIGNATURE') ? 2 : 1]], prompt_eval_count: 7,
      }) };
    }
    if (url.endsWith('/api/show')) {
      return { ok: true, json: async () => ({ model_info: { 'general.architecture': 'test', 'test.context_length': 8192 } }) };
    }
    activeChat += 1;
    maxActiveChat = Math.max(maxActiveChat, activeChat);
    await new Promise((resolve) => setImmediate(resolve));
    activeChat -= 1;
    const prompt = body.messages[0].content;
    if (prompt.startsWith('Summarize this document section')) {
      sections.push(prompt.split('\n\n')[1]);
      return { ok: true, json: async () => ({
        message: { content: JSON.stringify({ summary: prompt.includes('LATE_SIGNATURE') ? 'LATE_SIGNATURE' : 'ordinary content' }) },
        prompt_eval_count: 3, eval_count: 2,
      }) };
    }
    finalPrompt = prompt;
    return { ok: true, json: async () => ({
      message: { content: JSON.stringify({ documentTypeId: lastId, score: 0.9, justification: 'Late evidence.' }) },
      prompt_eval_count: 5, eval_count: 3,
    }) };
  };
  const text = `${'a'.repeat(64999)}😀LATE_SIGNATURE`;
  try {
    const result = await classifyDocument({ _id: firstId, fileName: 'file.pdf' }, types, {
      aiProvider: 'ollama', embeddingProvider: 'ollama', classificationMode: 'rag', ragTopK: 1,
      preparedText: text, ollamaBaseUrl: 'http://example.test', ollamaModel: 'test',
    });

    assert.equal(result.documentType._id, lastId);
    assert.equal(result.method, 'rag');
    assert.deepEqual(result.classificationCandidates.map((candidate) => candidate.documentTypeId).sort(), [firstId, lastId].sort());
    assert.ok(searched.length > 3);
    assert.ok(searched.includes(2));
    assert.equal(sections.slice(0, Math.ceil(text.length / 3000)).join(''), text);
    assert.match(finalPrompt, /LATE_SIGNATURE/);
    assert.ok(finalPrompt.includes(firstId) && finalPrompt.includes(lastId));
    assert.equal(result.embeddingMetrics.inputTokens, searched.length * 7);
    assert.ok(result.classificationMetrics.inputTokens > 5);
    assert.ok(embeddingRequests.every((request) => request.truncate === false));
    assert.equal(embeddingRequests.filter((request) => request.input.length <= 10000).map((request) => request.input).join(''), text);

    const vectorOptions = {
      aiProvider: 'ollama', embeddingProvider: 'ollama', classificationMode: 'vector',
      preparedText: text, ollamaBaseUrl: 'http://example.test', ollamaModel: 'test',
    };
    maxActiveChat = 0;
    const vectors = await Promise.all([
      classifyDocument({ _id: firstId, fileName: 'file.pdf' }, types, vectorOptions),
      classifyDocument({ _id: firstId, fileName: 'file.pdf' }, types, vectorOptions),
    ]);
    assert.ok(vectors.every((vector) => vector.method === 'rag' && vector.documentType._id === lastId));
    assert.equal(maxActiveChat, 1);

    sections.length = 0;
    embeddingRequests.length = 0;
    const llm = await classifyDocument({ _id: firstId, fileName: 'file.pdf' }, types, {
      ...vectorOptions, classificationMode: 'llm',
    });
    assert.equal(llm.documentType._id, lastId);
    assert.equal(llm.method, 'llm');
    assert.equal(embeddingRequests.length, 0);
    assert.equal(sections.slice(0, Math.ceil(Buffer.byteLength(text) / 3000)).join(''), text);

    sections.length = 0;
    searched.length = 0;
    embeddingRequests.length = 0;
    finalPrompt = undefined;
    const small = await classifyDocument({ _id: firstId, fileName: 'file.pdf' }, types, {
      aiProvider: 'ollama', embeddingProvider: 'ollama', classificationMode: 'vector',
      preparedText: 'small document', ollamaBaseUrl: 'http://example.test',
    });
    assert.equal(small.method, 'vector');
    assert.equal(small.documentType._id, firstId);
    assert.equal(finalPrompt, undefined);
    assert.equal(embeddingRequests[0].truncate, false);

    global.fetch = async () => ({ ok: false, status: 503, text: async () => 'service unavailable' });
    await assert.rejects(classifyDocument({ _id: firstId, fileName: 'file.pdf' }, types, {
      aiProvider: 'ollama', embeddingProvider: 'ollama', classificationMode: 'vector',
      preparedText: 'document', ollamaBaseUrl: 'http://example.test',
    }), /Vector classification failed: Ollama embedding request failed \(503\)/);
  } finally {
    global.fetch = previousFetch;
    if (originalCommon) require.cache[commonPath] = originalCommon;
    else delete require.cache[commonPath];
    if (originalBlob) require.cache[blobPath] = originalBlob;
    else delete require.cache[blobPath];
    if (originalConfiguration) require.cache[configurationPath] = originalConfiguration;
    else delete require.cache[configurationPath];
    if (originalConcurrency) require.cache[concurrencyPath] = originalConcurrency;
    else delete require.cache[concurrencyPath];
    delete require.cache[require.resolve('./classifier')];
  }
});

test('splits OpenAI input rejected for exceeding the embedding context', async () => {
  const openAiPath = require.resolve('openai');
  const originalOpenAi = require.cache[openAiPath];
  const id = '0123456789abcdef01234567';
  const embedded = [];
  class Database {
    async ensureCollection() {}
    async search() {
      return [{ id: 1, score: 0.9, payload: { documentTypeId: id } }];
    }
  }
  class MockOpenAI {
    constructor() {
      this.embeddings = { create: async ({ input }) => {
        if (input.length > 2000) throw Object.assign(new Error('context exceeded'), { status: 400, code: 'context_length_exceeded' });
        embedded.push(input);
        return { data: [{ embedding: [1] }], usage: { total_tokens: 1 } };
      } };
      this.responses = { create: async ({ input }) => {
        const prompt = input[0].content[0].text;
        const result = prompt.startsWith('Summarize')
          ? { summary: 'document evidence' }
          : { documentTypeId: id, score: 1, justification: 'Document evidence.' };
        return { output_text: JSON.stringify(result), usage: { input_tokens: 1, output_tokens: 1 } };
      } };
    }
  }
  require.cache[commonPath] = { id: commonPath, filename: commonPath, loaded: true, exports: { ...common, QdrantVectorDatabase: Database } };
  require.cache[blobPath] = { id: blobPath, filename: blobPath, loaded: true, exports: { isConfigured: () => true } };
  require.cache[configurationPath] = { id: configurationPath, filename: configurationPath, loaded: true, exports: { getConfiguration: async () => ({}) } };
  require.cache[openAiPath] = { id: openAiPath, filename: openAiPath, loaded: true, exports: MockOpenAI };
  delete require.cache[concurrencyPath];
  delete require.cache[require.resolve('./classifier')];
  try {
    const { classifyDocument } = require('./classifier');
    const text = `${'a'.repeat(5000)}last`;
    const result = await classifyDocument({ _id: id, fileName: 'file.pdf' }, [
      { _id: id, name: 'type', category: 'category', finalized: true, includeInClassification: true, sampleFiles: ['a.pdf'] },
    ], { apiKey: 'test', aiProvider: 'openai', embeddingProvider: 'openai', classificationMode: 'vector', preparedText: text });
    assert.equal(result.method, 'rag');
    assert.equal(embedded.join(''), text);
  } finally {
    if (originalOpenAi) require.cache[openAiPath] = originalOpenAi;
    else delete require.cache[openAiPath];
    if (originalCommon) require.cache[commonPath] = originalCommon;
    else delete require.cache[commonPath];
    if (originalBlob) require.cache[blobPath] = originalBlob;
    else delete require.cache[blobPath];
    if (originalConfiguration) require.cache[configurationPath] = originalConfiguration;
    else delete require.cache[configurationPath];
    if (originalConcurrency) require.cache[concurrencyPath] = originalConcurrency;
    else delete require.cache[concurrencyPath];
    delete require.cache[require.resolve('./classifier')];
  }
});
