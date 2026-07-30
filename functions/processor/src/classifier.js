const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const OpenAI = require('openai');
const { withOpenAIRetry } = require('./openaiRetry');
const { QdrantVectorDatabase } = require('@xtract/common');
const { TRAIN_CONTAINER, downloadToTemp, isConfigured: isBlobStorageConfigured, removeTempFile } = require('./blobStorage');

const vectorDatabase = new QdrantVectorDatabase();
const { extractDocumentText } = require('./documentText');

function getOpenAI(options = {}) {
  if (!options.apiKey) return undefined;
  return new OpenAI({
    apiKey: options.apiKey,
    ...(options.aiProvider === 'custom' && options.llmEndpoint ? { baseURL: options.llmEndpoint } : {}),
  });
}

function modelName() {
  return 'gpt-5-nano';
}

function providerName(options = {}) {
  return options.aiProvider === 'ollama' ? 'ollama' : 'openai';
}

function ollamaModelName(options = {}) {
  return options.ollamaModel || 'llama3.2';
}

function ollamaBaseUrl(options = {}) {
  return (options.ollamaBaseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

function supportsReasoningEffort(model) {
  return /^(gpt-5|o\d|o\d-)/.test(model);
}

function openAIRequestConfig(options = {}) {
  const model = providerName(options) === 'ollama' ? ollamaModelName(options) : options.model || modelName();
  return {
    model,
    ...(options.reasoningEffort && supportsReasoningEffort(model)
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
  };
}

async function createJsonResponse(content, options = {}, label = 'AI request') {
  if (providerName(options) === 'ollama') {
    const model = ollamaModelName(options);
    const response = await fetch(`${ollamaBaseUrl(options)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [{
          role: 'user',
          content: content.map((item) => typeof item.text === 'string' ? item.text : '').filter(Boolean).join('\n'),
        }],
      }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${message || response.statusText}`);
    }
    const payload = await response.json();
    return {
      outputText: payload?.message?.content || payload?.response || '',
      raw: payload,
      model: payload?.model || model,
    };
  }

  const client = getOpenAI(options);
  if (!client) return undefined;
  const requestConfig = openAIRequestConfig(options);
  const response = await withOpenAIRetry(() => client.responses.create({
    ...requestConfig,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_object' } },
  }), label);
  return {
    outputText: response.output_text,
    raw: response,
    model: requestConfig.model,
  };
}

function embeddingProviderName(options = {}) {
  return options.embeddingProvider === 'ollama' ? 'ollama' : 'openai';
}

function embeddingModelName(options = {}) {
  return embeddingProviderName(options) === 'ollama'
    ? options.ollamaEmbeddingModel || 'qwen3-embedding:4b'
    : options.embeddingModel || 'text-embedding-3-small';
}

const modelPricingUsdPerMillion = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-5.6-sol': { input: 5.00, output: 30.00 },
  'gpt-5.6-terra': { input: 2.50, output: 15.00 },
  'gpt-5.6-luna': { input: 1.00, output: 6.00 },
  'gpt-5': { input: 1.25, output: 10.00 },
  'gpt-5-mini': { input: 0.25, output: 2.00 },
  'gpt-5-nano': { input: 0.05, output: 0.40 },
};

const embeddingPricingUsdPerMillion = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-ada-002': 0.10,
};

function pricingForModel(model) {
  return modelPricingUsdPerMillion[model] || { input: 0, output: 0 };
}

function pricingForEmbeddingModel(model) {
  const configured = Number(process.env.OPENAI_EMBEDDING_COST_PER_1M_TOKENS);
  if (Number.isFinite(configured)) return configured;
  return embeddingPricingUsdPerMillion[model] || 0;
}

function tokenUsageFromResponse(response) {
  const usage = response?.usage || {};
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? response?.prompt_eval_count ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? response?.eval_count ?? 0);
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  };
}

function metricsFromResponse(response, model) {
  const tokens = tokenUsageFromResponse(response);
  const pricing = pricingForModel(model);
  const estimatedCostUsd =
    (tokens.inputTokens / 1_000_000) * pricing.input +
    (tokens.outputTokens / 1_000_000) * pricing.output;

  return {
    model,
    ...tokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
  };
}

function embeddingMetricsFromResponse(response, model) {
  const tokens = tokenUsageFromResponse(response);
  const estimatedCostUsd = (tokens.totalTokens / 1_000_000) * pricingForEmbeddingModel(model);
  return {
    model,
    inputTokens: tokens.totalTokens,
    outputTokens: 0,
    totalTokens: tokens.totalTokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
  };
}

function emptyMetrics(model = 'none') {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  };
}

function addMetrics(left = emptyMetrics(), right = emptyMetrics()) {
  return {
    model: left.model || right.model,
    inputTokens: Number(left.inputTokens || 0) + Number(right.inputTokens || 0),
    outputTokens: Number(left.outputTokens || 0) + Number(right.outputTokens || 0),
    totalTokens: Number(left.totalTokens || 0) + Number(right.totalTokens || 0),
    estimatedCostUsd: Number((Number(left.estimatedCostUsd || 0) + Number(right.estimatedCostUsd || 0)).toFixed(8)),
  };
}

function vectorSize() {
  return Number(process.env.VECTOR_SIZE || 1536);
}

function pdfInput(filePath) {
  const data = fs.readFileSync(filePath).toString('base64');
  return {
    type: 'input_file',
    filename: path.basename(filePath),
    file_data: `data:application/pdf;base64,${data}`,
  };
}

function embeddingTextLimit() {
  return Number(process.env.CLASSIFIER_EMBED_TEXT_LIMIT || 6000);
}

function maxTrainChunksPerDocument() {
  return Number(process.env.CLASSIFIER_TRAIN_CHUNKS_PER_DOCUMENT || 6);
}

function maxQueryChunksPerDocument() {
  return Number(process.env.CLASSIFIER_QUERY_CHUNKS_PER_DOCUMENT || 3);
}

function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'apps', 'api', 'uploads');
}

function samplePath(fileName) {
  return path.join(uploadRoot(), fileName);
}

async function resolveSamplePath(fileName) {
  if (isBlobStorageConfigured()) return downloadToTemp(TRAIN_CONTAINER, fileName);
  return samplePath(fileName);
}

function parseJsonObject(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function clampScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 0;
  return Math.max(0, Math.min(score, 1));
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function latestExistingSample(documentType) {
  if (isBlobStorageConfigured()) return [...(documentType.sampleFiles || [])].reverse()[0];
  return [...(documentType.sampleFiles || [])].reverse().find((fileName) => fileExists(samplePath(fileName)));
}

function existingSamples(documentType) {
  if (isBlobStorageConfigured()) return documentType.sampleFiles || [];
  return (documentType.sampleFiles || []).filter((fileName) => fileExists(samplePath(fileName)));
}

function fallbackProfile(documentType, sampleFileName) {
  return [
    `Document type: ${documentType.name}`,
    `Category: ${documentType.category}`,
    documentType.prompt ? `Extraction prompt: ${documentType.prompt}` : '',
    sampleFileName ? `Training sample file: ${sampleFileName}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function fallbackClassify(fileName, candidates, options = {}) {
  const normalized = fileName.toLowerCase();
  const scored = candidates.map((candidate) => {
    const name = candidate.name.toLowerCase();
    const category = candidate.category.toLowerCase();
    const nameHit = normalized.includes(name) ? 0.9 : 0;
    const categoryHit = normalized.includes(category) ? 0.75 : 0;
    const keywordHit = name
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .some((part) => normalized.includes(part))
      ? 0.65
      : 0;
    return { candidate, score: Math.max(nameHit, categoryHit, keywordHit, 0.5) };
  });
  scored.sort((a, b) => b.score - a.score);
  return {
    documentType: scored[0].candidate,
    score: Number(scored[0].score.toFixed(2)),
    method: options.classificationMode === 'rag' ? 'rag' : 'llm',
    model: 'mock',
    justification: `Selected from the uploaded file name because it most closely matched the document type or category: ${scored[0].candidate.name}.`,
    classificationMetrics: emptyMetrics('mock'),
    embeddingMetrics: emptyMetrics(embeddingModelName(options)),
  };
}

function pointId(documentTypeId, sampleFileName, chunkIndex) {
  const input = `${documentTypeId}:${sampleFileName}:${chunkIndex}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function chunkText(text, maxChars = embeddingTextLimit(), maxChunks = maxTrainChunksPerDocument()) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return ['empty document'];

  const chunks = [];
  for (let index = 0; index < normalized.length && chunks.length < maxChunks; index += maxChars) {
    chunks.push(normalized.slice(index, index + maxChars));
  }
  return chunks;
}

async function ensureVectorCollection(size = vectorSize()) {
  return vectorDatabase.ensureCollection(size);
}

async function resetClassifierVectors() {
  return vectorDatabase.resetCollection();
}

async function embedText(text, options = {}) {
  const model = embeddingModelName(options);
  if (embeddingProviderName(options) === 'ollama') {
    const response = await fetch(`${ollamaBaseUrl(options)}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: text || 'empty document',
      }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Ollama embedding request failed (${response.status}): ${message || response.statusText}`);
    }
    const payload = await response.json();
    const embedding = Array.isArray(payload?.embeddings?.[0]) ? payload.embeddings[0] : payload?.embedding;
    if (!Array.isArray(embedding)) throw new Error(`Ollama embedding response did not include an embedding for ${model}.`);
    return {
      embedding,
      metrics: embeddingMetricsFromResponse(payload, payload?.model || model),
    };
  }

  const client = getOpenAI(options);
  if (!client) throw new Error('An API key is required to create classifier embeddings.');
  const response = await withOpenAIRetry(() => client.embeddings.create({
    model,
    input: text || 'empty document',
  }), 'Classifier embedding');
  return {
    embedding: response.data[0].embedding,
    metrics: embeddingMetricsFromResponse(response, model),
  };
}

async function deleteDocumentTypeVectors(documentTypeId) {
  await vectorDatabase.deleteByFilter({
    must: [{ key: 'documentTypeId', match: { value: String(documentTypeId) } }],
  });
}

async function upsertDocumentTypeVectors(documentType, samples, options = {}) {
  const points = [];
  let ensuredVectorSize = 0;

  for (const sampleFileName of samples) {
    const filePath = await resolveSamplePath(sampleFileName);
    try {
      const text = [
        `Document type: ${documentType.name}`,
        `Category: ${documentType.category}`,
        documentType.prompt ? `Prompt: ${documentType.prompt}` : '',
        await extractDocumentText(filePath, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000)),
      ]
        .filter(Boolean)
        .join('\n');

      const chunks = chunkText(text);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const embedded = await embedText(chunks[chunkIndex], options);
        if (!ensuredVectorSize) {
          ensuredVectorSize = embedded.embedding.length;
          await ensureVectorCollection(ensuredVectorSize);
        }
        points.push({
          id: pointId(documentType._id, sampleFileName, chunkIndex),
          vector: embedded.embedding,
          payload: {
            documentTypeId: String(documentType._id),
            documentTypeName: documentType.name,
            category: documentType.category,
            sampleFileName,
            chunkIndex,
          },
        });
      }
    } finally {
      if (isBlobStorageConfigured()) await removeTempFile(filePath);
    }
  }

  if (!points.length) return;
  await vectorDatabase.upsert(points);
}

async function searchDocumentTypeVectors(document, textOptions = {}, options = {}, resultLimit) {
  const text = typeof options.preparedText === 'string'
    ? options.preparedText.slice(0, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000))
    : await extractDocumentText(document.filePath, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000), {
      ...textOptions,
      fileName: document.originalName || document.fileName,
    });
  const chunks = chunkText([
    `Uploaded file name: ${document.originalName || document.fileName || 'unknown'}`,
    text,
  ].join('\n'), embeddingTextLimit(), maxQueryChunksPerDocument());
  const hitsByPoint = new Map();
  let embeddingMetrics = emptyMetrics(embeddingModelName(options));
  let ensuredVectorSize = 0;

  for (const chunk of chunks) {
    const embedded = await embedText(chunk, options);
    if (!ensuredVectorSize) {
      ensuredVectorSize = embedded.embedding.length;
      await ensureVectorCollection(ensuredVectorSize);
    }
    embeddingMetrics = addMetrics(embeddingMetrics, embedded.metrics);
    const hits = await vectorDatabase.search(
      embedded.embedding,
      resultLimit || Number(process.env.CLASSIFIER_VECTOR_LIMIT || 5),
    );

    for (const hit of hits) {
      const existing = hitsByPoint.get(hit.id);
      if (!existing || hit.score > existing.score) hitsByPoint.set(hit.id, hit);
    }
  }

  return {
    hits: Array.from(hitsByPoint.values()).sort((a, b) => b.score - a.score),
    metrics: embeddingMetrics,
  };
}

async function trainClassifierProfile(documentType, sampleFileName, options = {}) {
  const samples = existingSamples(documentType);
  if (!samples.length) {
    throw new Error(`Training sample file not found for ${documentType.name}`);
  }

  const embeddingsEnabled = embeddingProviderName(options) === 'ollama' || Boolean(options.apiKey);
  if (embeddingsEnabled) {
    await deleteDocumentTypeVectors(documentType._id);
    await upsertDocumentTypeVectors(documentType, samples, options);
  }

  const latestSample = sampleFileName || samples.at(-1);
  const latestSamplePath = await resolveSamplePath(latestSample);
  try {
    const sampleText = await extractDocumentText(latestSamplePath, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000));
    return [
      fallbackProfile(documentType, latestSample),
      embeddingsEnabled
        ? `Training samples indexed with ${embeddingProviderName(options) === 'ollama' ? 'Ollama' : 'OpenAI'} embeddings: ${samples.length}`
        : `Training samples profiled without embeddings: ${samples.length}`,
      `Sample text preview: ${sampleText.slice(0, Number(process.env.CLASSIFIER_PROFILE_TEXT_LIMIT || 2000))}`,
    ].join('\n');
  } finally {
    if (isBlobStorageConfigured()) await removeTempFile(latestSamplePath);
  }
}

async function classifyDocument(document, documentTypes, options = {}) {
  const candidates = documentTypes.filter((documentType) =>
    documentType.includeInClassification &&
    documentType.finalized &&
    latestExistingSample(documentType)
  );
  if (!candidates.length) {
    throw new Error('Upload at least one sample and save the schema for a document type before automatic classification.');
  }

  const useOcr = Boolean(options.useOcr);
  const classificationMode = ['vector', 'llm', 'rag'].includes(options.classificationMode)
    ? options.classificationMode
    : 'vector';
  const ragTopK = Math.min(50, Math.max(1, Number(options.ragTopK) || 5));
  const textOptions = {
    mode: options.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
    markdownServiceUrl: options.markdownServiceUrl,
  };
  let vectorHits = [];
  let embeddingMetrics = emptyMetrics(embeddingModelName(options));
  const needsVectorSearch = classificationMode === 'vector' || classificationMode === 'rag';
  if (needsVectorSearch && (embeddingProviderName(options) === 'ollama' || options.apiKey)) {
    try {
      const vectorSearch = await searchDocumentTypeVectors(
        document,
        textOptions,
        options,
        classificationMode === 'rag'
          ? Math.max(ragTopK * 3, Number(process.env.CLASSIFIER_VECTOR_LIMIT || 5))
          : Math.max(9, Number(process.env.CLASSIFIER_VECTOR_LIMIT || 5)),
      );
      vectorHits = vectorSearch.hits;
      embeddingMetrics = vectorSearch.metrics;
    } catch (error) {
      vectorHits = [];
    }
  }

  const candidateById = new Map(candidates.map((candidate) => [String(candidate._id), candidate]));
  const rankedDocumentTypes = [];
  const rankedIds = new Set();
  for (const hit of vectorHits) {
    const documentTypeId = String(hit.payload?.documentTypeId || '');
    const documentType = candidateById.get(documentTypeId);
    if (!documentType || rankedIds.has(documentTypeId)) continue;
    rankedIds.add(documentTypeId);
    rankedDocumentTypes.push({ documentType, hit });
  }

  if (classificationMode === 'vector') {
    const topResult = rankedDocumentTypes[0];
    if (!topResult) {
      throw new Error('Vector classification returned no trained document type. Train the classifier and verify the embedding provider configuration.');
    }
    const classificationCandidates = rankedDocumentTypes.slice(0, 3).map(({ documentType: candidate, hit }) => ({
      documentTypeId: String(candidate._id),
      category: candidate.category,
      name: candidate.name,
      score: Number(clampScore(hit.score).toFixed(4)),
    }));
    return {
      documentType: topResult.documentType,
      score: Number(clampScore(topResult.hit.score).toFixed(2)),
      method: 'vector',
      model: embeddingModelName(options),
      justification: `${topResult.documentType.name} was selected because it was the top vector search result with a similarity score of ${(clampScore(topResult.hit.score) * 100).toFixed(2)}%.`,
      classificationCandidates,
      classificationMetrics: emptyMetrics('vector'),
      embeddingMetrics,
    };
  }

  const llmCandidates = classificationMode === 'rag'
    ? rankedDocumentTypes.slice(0, ragTopK).map(({ documentType }) => documentType)
    : candidates;
  const classificationCandidates = classificationMode === 'rag'
    ? rankedDocumentTypes.slice(0, ragTopK).map(({ documentType: candidate, hit }) => ({
      documentTypeId: String(candidate._id),
      category: candidate.category,
      name: candidate.name,
      score: Number(clampScore(hit.score).toFixed(4)),
    }))
    : undefined;
  if (!llmCandidates.length) {
    throw new Error('RAG classification returned no trained document types. Train the classifier and verify the embedding provider configuration.');
  }
  if (providerName(options) !== 'ollama' && !getOpenAI(options)) {
    return {
      ...fallbackClassify(document.originalName || document.fileName || '', llmCandidates, options),
      classificationCandidates,
    };
  }

  const useDocumentText = typeof options.preparedText === 'string' ||
    useOcr ||
    providerName(options) === 'ollama' ||
    classificationMode === 'rag';
  const documentText = useDocumentText
    ? typeof options.preparedText === 'string'
      ? options.preparedText.slice(0, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000))
      : await extractDocumentText(document.filePath, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000), {
        ...textOptions,
        fileName: document.originalName || document.fileName,
      })
    : '';
  const requestConfig = openAIRequestConfig({
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    aiProvider: options.aiProvider,
    ollamaBaseUrl: options.ollamaBaseUrl,
    ollamaModel: options.ollamaModel,
  });
  const content = [
    ...(useDocumentText || providerName(options) === 'ollama' ? [] : [pdfInput(document.filePath)]),
    {
      type: 'input_text',
      text: [
        useDocumentText
          ? `Classify the uploaded document using ${textOptions.mode === 'markdown' ? 'Docling markdown' : 'locally extracted OCR/text'}, trained document type profiles, and metadata.`
          : 'Classify the uploaded PDF using trained document type profiles and metadata.',
        'Choose exactly one candidate document type. Return JSON only.',
        'The score must be a number from 0 to 1 representing match strength.',
        'The justification must concisely identify the document evidence that supports the selected type.',
        'Return this exact shape:',
        '{"documentTypeId":"candidate_id","score":0.92,"justification":"Concise evidence-based reason for choosing this type"}',
        `Uploaded file name: ${document.originalName || document.fileName || 'unknown'}`,
        useDocumentText ? `Document text:\n${documentText}` : '',
        'Candidates:',
        ...llmCandidates.map((candidate, index) => (
          `${index + 1}. id=${candidate._id}; category=${candidate.category}; name=${candidate.name}; profile=${candidate.classifierProfile || fallbackProfile(candidate, latestExistingSample(candidate))}`
        )),
        classificationMode === 'rag'
          ? `RAG retrieval results: ${rankedDocumentTypes.slice(0, ragTopK).map(({ documentType: candidate, hit }) => `${candidate.name} score=${Number(hit.score).toFixed(3)}`).join('; ')}`
          : 'All configured document types were provided for classification.',
      ].join('\n'),
    },
  ];

  const response = await createJsonResponse(content, {
    ...options,
    model: requestConfig.model,
  }, `${classificationMode === 'rag' ? 'RAG' : 'LLM'} classifier for ${document._id || document.fileName}`);
  if (!response) {
    return {
      ...fallbackClassify(document.originalName || document.fileName || '', llmCandidates, options),
      classificationCandidates,
    };
  }
  const classificationMetrics = metricsFromResponse(response.raw, response.model);

  const parsed = parseJsonObject(response.outputText);
  const selected = llmCandidates.find((candidate) => String(candidate._id) === parsed.documentTypeId) || llmCandidates[0];
  return {
    documentType: selected,
    score: Number(clampScore(parsed.score).toFixed(2)),
    method: classificationMode === 'rag' ? 'rag' : 'llm',
    model: response.model,
    justification: typeof parsed.justification === 'string' && parsed.justification.trim()
      ? parsed.justification.trim().slice(0, 2000)
      : `The LLM selected ${selected.name} as the closest match among the candidate document types.`,
    classificationCandidates,
    classificationMetrics,
    embeddingMetrics,
  };
}

function normalizeObjectId(value) {
  if (value instanceof ObjectId) return value;
  return ObjectId.isValid(value) ? new ObjectId(value) : value;
}

module.exports = {
  classifyDocument,
  normalizeObjectId,
  resetClassifierVectors,
  samplePath,
  trainClassifierProfile,
};
