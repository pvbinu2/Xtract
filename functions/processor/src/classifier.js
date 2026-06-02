const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const OpenAI = require('openai');
const { withOpenAIRetry } = require('./openaiRetry');
const { TRAIN_CONTAINER, downloadToTemp, isConfigured: isBlobStorageConfigured, removeTempFile } = require('./blobStorage');

let openai;
let pdfjsPromise;

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return undefined;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function modelName() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function embeddingModelName() {
  return process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
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

function pdfInput(filePath) {
  const data = fs.readFileSync(filePath).toString('base64');
  return {
    type: 'input_file',
    filename: path.basename(filePath),
    file_data: `data:application/pdf;base64,${data}`,
  };
}

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
      module.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
      return module;
    });
  }
  return pdfjsPromise;
}

async function extractPdfText(filePath) {
  const { getDocument } = await loadPdfJs();
  const data = fs.readFileSync(filePath);
  const standardFontDataUrl = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const pdf = await getDocument({ data: new Uint8Array(data), disableWorker: true, standardFontDataUrl }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .filter((item) => 'str' in item)
      .map((item) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) pages.push(text);
  }

  return pages.join('\n').slice(0, Number(process.env.CLASSIFIER_TEXT_LIMIT || 36000));
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
  const response = await withOpenAIRetry(() => client.embeddings.create({
    model: embeddingModelName(),
    input: text || 'empty document',
  }), 'Classifier embedding');
  return response.data[0].embedding;
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
        await extractPdfText(filePath),
      ]
        .filter(Boolean)
        .join('\n');

      const chunks = chunkText(text);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        points.push({
          id: pointId(documentType._id, sampleFileName, chunkIndex),
          vector: await embedText(chunks[chunkIndex]),
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

async function searchDocumentTypeVectors(document) {
  await ensureVectorCollection();
  const text = await extractPdfText(document.filePath);
  const chunks = chunkText([
    `Uploaded file name: ${document.originalName || document.fileName || 'unknown'}`,
    text,
  ].join('\n'), embeddingTextLimit(), maxQueryChunksPerDocument());
  const hitsByPoint = new Map();

  for (const chunk of chunks) {
    const vector = await embedText(chunk);
    const response = await qdrantRequest(`/collections/${qdrantCollection()}/points/search`, {
      method: 'POST',
      body: JSON.stringify({
        vector,
        limit: Number(process.env.CLASSIFIER_VECTOR_LIMIT || 5),
        with_payload: true,
      }),
    });

    for (const hit of response.result || []) {
      const existing = hitsByPoint.get(hit.id);
      if (!existing || hit.score > existing.score) hitsByPoint.set(hit.id, hit);
    }
  }

  return Array.from(hitsByPoint.values()).sort((a, b) => b.score - a.score);
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
    const sampleText = await extractPdfText(latestSamplePath);
    return [
      fallbackProfile(documentType, latestSample),
      `Training samples indexed: ${samples.length}`,
      `Sample text preview: ${sampleText.slice(0, Number(process.env.CLASSIFIER_PROFILE_TEXT_LIMIT || 2000))}`,
    ].join('\n');
  } finally {
    if (isBlobStorageConfigured()) await removeTempFile(latestSamplePath);
  }
}

async function classifyDocument(document, documentTypes) {
  const candidates = documentTypes.filter((documentType) =>
    documentType.includeInClassification &&
    documentType.finalized &&
    latestExistingSample(documentType)
  );
  if (!candidates.length) {
    throw new Error('Upload at least one sample and save the schema for a document type before automatic classification.');
  }

  let vectorHits = [];
  try {
    vectorHits = await searchDocumentTypeVectors(document);
  } catch (error) {
    vectorHits = [];
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
    };
  }

  const client = getOpenAI();
  if (!client) return fallbackClassify(document.originalName || document.fileName || '', candidates);

  const retrievedIds = new Set(vectorHits.map((hit) => hit.payload?.documentTypeId).filter(Boolean));
  const llmCandidates = [
    ...candidates.filter((candidate) => retrievedIds.has(String(candidate._id))),
    ...candidates.filter((candidate) => !retrievedIds.has(String(candidate._id))),
  ].slice(0, Number(process.env.CLASSIFIER_LLM_CANDIDATE_LIMIT || 8));

  const content = [
    pdfInput(document.filePath),
    {
      type: 'input_text',
      text: [
        'Classify the uploaded PDF using trained document type profiles and metadata.',
        'Choose exactly one candidate document type. Return JSON only.',
        'The score must be a number from 0 to 1 representing match strength.',
        'Return this exact shape:',
        '{"documentTypeId":"candidate_id","score":0.92}',
        `Uploaded file name: ${document.originalName || document.fileName || 'unknown'}`,
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
    model: modelName(),
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_object' } },
  }), `Classifier LLM fallback for ${document._id || document.fileName}`);

  const parsed = parseJsonObject(response.output_text);
  const selected = llmCandidates.find((candidate) => String(candidate._id) === parsed.documentTypeId) || llmCandidates[0];
  return {
    documentType: selected,
    score: Number(clampScore(parsed.score).toFixed(2)),
    method: 'llm',
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
