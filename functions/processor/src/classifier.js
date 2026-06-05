const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const OpenAI = require('openai');
const { withOpenAIRetry } = require('./openaiRetry');
const { TRAIN_CONTAINER, downloadToTemp, isConfigured: isBlobStorageConfigured, removeTempFile } = require('./blobStorage');
const { extractDocumentText } = require('./documentText');

let openai;

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return undefined;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function modelName() {
  return process.env.OPENAI_MODEL || 'gpt-5-nano';
}

function supportsReasoningEffort(model) {
  return /^(gpt-5|o\d|o\d-)/.test(model);
}

function openAIRequestConfig(options = {}) {
  const model = options.model || modelName();
  return {
    model,
    ...(options.reasoningEffort && supportsReasoningEffort(model)
      ? { reasoning: { effort: options.reasoningEffort } }
      : {}),
  };
}

function embeddingModelName() {
  return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
}

const modelPricingUsdPerMillion = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4.1': { input: 2.00, output: 8.00 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
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
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
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

function qdrantUrl() {
  return (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
}

function qdrantCollection() {
  return process.env.QDRANT_COLLECTION || 'xtract_document_classifier';
}

function vectorScoreThreshold() {
  return Number(process.env.CLASSIFIER_VECTOR_SCORE_THRESHOLD || 0.82);
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

function fallbackClassify(fileName, candidates) {
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
    method: 'llm',
    model: 'mock',
    classificationMetrics: emptyMetrics('mock'),
    embeddingMetrics: emptyMetrics(embeddingModelName()),
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

async function qdrantRequest(pathname, options = {}) {
  const response = await fetch(`${qdrantUrl()}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Qdrant request failed: ${response.status} ${message}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function ensureVectorCollection() {
  const collection = qdrantCollection();
  const response = await fetch(`${qdrantUrl()}/collections/${collection}`);
  if (response.ok) return;
  const createResponse = await fetch(`${qdrantUrl()}/collections/${collection}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: {
        size: vectorSize(),
        distance: 'Cosine',
      },
    }),
  });
  if (createResponse.ok || createResponse.status === 409) return;
  const message = await createResponse.text();
  throw new Error(`Qdrant request failed: ${createResponse.status} ${message}`);
}

async function resetClassifierVectors() {
  const collection = qdrantCollection();
  let response;
  try {
    response = await fetch(`${qdrantUrl()}/collections/${collection}`, { method: 'DELETE' });
  } catch (error) {
    throw new Error(`Could not reach Qdrant at ${qdrantUrl()}: ${error?.message || String(error)}`);
  }
  if (response.ok || response.status === 404) return;
  const message = await response.text();
  throw new Error(`Qdrant collection reset failed: ${response.status} ${message}`);
}

async function embedText(text) {
  const client = getOpenAI();
  if (!client) throw new Error('OPENAI_API_KEY is required to create classifier embeddings.');
  const model = embeddingModelName();
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
  await ensureVectorCollection();
  await qdrantRequest(`/collections/${qdrantCollection()}/points/delete`, {
    method: 'POST',
    body: JSON.stringify({
      filter: {
        must: [{ key: 'documentTypeId', match: { value: String(documentTypeId) } }],
      },
    }),
  });
}

async function upsertDocumentTypeVectors(documentType, samples) {
  await ensureVectorCollection();
  const points = [];

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
        points.push({
          id: pointId(documentType._id, sampleFileName, chunkIndex),
          vector: (await embedText(chunks[chunkIndex])).embedding,
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
  await qdrantRequest(`/collections/${qdrantCollection()}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({ points }),
  });
}

async function searchDocumentTypeVectors(document, textOptions = {}) {
  await ensureVectorCollection();
  const text = await extractDocumentText(document.filePath, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000), {
    ...textOptions,
    fileName: document.originalName || document.fileName,
  });
  const chunks = chunkText([
    `Uploaded file name: ${document.originalName || document.fileName || 'unknown'}`,
    text,
  ].join('\n'), embeddingTextLimit(), maxQueryChunksPerDocument());
  const hitsByPoint = new Map();
  let embeddingMetrics = emptyMetrics(embeddingModelName());

  for (const chunk of chunks) {
    const embedded = await embedText(chunk);
    embeddingMetrics = addMetrics(embeddingMetrics, embedded.metrics);
    const response = await qdrantRequest(`/collections/${qdrantCollection()}/points/search`, {
      method: 'POST',
      body: JSON.stringify({
        vector: embedded.embedding,
        limit: Number(process.env.CLASSIFIER_VECTOR_LIMIT || 5),
        with_payload: true,
      }),
    });

    for (const hit of response.result || []) {
      const existing = hitsByPoint.get(hit.id);
      if (!existing || hit.score > existing.score) hitsByPoint.set(hit.id, hit);
    }
  }

  return {
    hits: Array.from(hitsByPoint.values()).sort((a, b) => b.score - a.score),
    metrics: embeddingMetrics,
  };
}

async function trainClassifierProfile(documentType, sampleFileName) {
  const samples = existingSamples(documentType);
  if (!samples.length) {
    throw new Error(`Training sample file not found for ${documentType.name}`);
  }

  await deleteDocumentTypeVectors(documentType._id);
  await upsertDocumentTypeVectors(documentType, samples);

  const latestSample = sampleFileName || samples.at(-1);
  const latestSamplePath = await resolveSamplePath(latestSample);
  try {
    const sampleText = await extractDocumentText(latestSamplePath, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000));
    return [
      fallbackProfile(documentType, latestSample),
      `Training samples indexed: ${samples.length}`,
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
  const textOptions = {
    mode: options.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
    markdownServiceUrl: options.markdownServiceUrl,
  };
  let vectorHits = [];
  let embeddingMetrics = emptyMetrics(embeddingModelName());
  if (useOcr) {
    try {
      const vectorSearch = await searchDocumentTypeVectors(document, textOptions);
      vectorHits = vectorSearch.hits;
      embeddingMetrics = vectorSearch.metrics;
    } catch (error) {
      vectorHits = [];
    }
  }
  const topHit = vectorHits[0];
  const vectorDocumentType = topHit
    ? candidates.find((candidate) => String(candidate._id) === topHit.payload?.documentTypeId)
    : undefined;
  if (vectorDocumentType && topHit.score >= vectorScoreThreshold()) {
    return {
      documentType: vectorDocumentType,
      score: Number(clampScore(topHit.score).toFixed(2)),
      method: 'vector',
      model: embeddingModelName(),
      classificationMetrics: emptyMetrics('vector'),
      embeddingMetrics,
    };
  }

  const client = getOpenAI();
  if (!client) return fallbackClassify(document.originalName || document.fileName || '', candidates);

  const retrievedIds = new Set(vectorHits.map((hit) => hit.payload?.documentTypeId).filter(Boolean));
  const llmCandidates = [
    ...candidates.filter((candidate) => retrievedIds.has(String(candidate._id))),
    ...candidates.filter((candidate) => !retrievedIds.has(String(candidate._id))),
  ].slice(0, Number(process.env.CLASSIFIER_LLM_CANDIDATE_LIMIT || 8));

  const documentText = useOcr ? await extractDocumentText(document.filePath, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000), {
    ...textOptions,
    fileName: document.originalName || document.fileName,
  }) : '';
  const requestConfig = openAIRequestConfig({
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });
  const content = [
    ...(useOcr ? [] : [pdfInput(document.filePath)]),
    {
      type: 'input_text',
      text: [
        useOcr
          ? `Classify the uploaded document using ${textOptions.mode === 'markdown' ? 'Docling markdown' : 'locally extracted OCR/text'}, trained document type profiles, and metadata.`
          : 'Classify the uploaded PDF using trained document type profiles and metadata.',
        'Choose exactly one candidate document type. Return JSON only.',
        'The score must be a number from 0 to 1 representing match strength.',
        'Return this exact shape:',
        '{"documentTypeId":"candidate_id","score":0.92}',
        `Uploaded file name: ${document.originalName || document.fileName || 'unknown'}`,
        useOcr ? `Document text:\n${documentText}` : '',
        'Candidates:',
        ...llmCandidates.map((candidate, index) => (
          `${index + 1}. id=${candidate._id}; category=${candidate.category}; name=${candidate.name}; profile=${candidate.classifierProfile || fallbackProfile(candidate, latestExistingSample(candidate))}`
        )),
        vectorHits.length
          ? `Vector search top results: ${vectorHits.map((hit) => `${hit.payload?.documentTypeName || hit.payload?.documentTypeId} score=${Number(hit.score).toFixed(3)}`).join('; ')}`
          : 'Vector search returned no usable result.',
      ].join('\n'),
    },
  ];

  const response = await withOpenAIRetry(() => client.responses.create({
    ...requestConfig,
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_object' } },
  }), `Classifier LLM fallback for ${document._id || document.fileName}`);
  const classificationMetrics = metricsFromResponse(response, requestConfig.model);

  const parsed = parseJsonObject(response.output_text);
  const selected = llmCandidates.find((candidate) => String(candidate._id) === parsed.documentTypeId) || llmCandidates[0];
  return {
    documentType: selected,
    score: Number(clampScore(parsed.score).toFixed(2)),
    method: 'llm',
    model: requestConfig.model,
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
