const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const OpenAI = require('openai');

let openai;

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return undefined;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function modelName() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

function uploadRoot() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'apps', 'api', 'uploads');
}

function samplePath(fileName) {
  return path.join(uploadRoot(), fileName);
}

function pdfInput(filePath) {
  const data = fs.readFileSync(filePath).toString('base64');
  return {
    type: 'input_file',
    filename: path.basename(filePath),
    file_data: `data:application/pdf;base64,${data}`,
  };
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
  return [...(documentType.sampleFiles || [])].reverse().find((fileName) => fileExists(samplePath(fileName)));
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
  };
}

async function trainClassifierProfile(documentType, sampleFileName) {
  const sample = samplePath(sampleFileName);
  if (!fileExists(sample)) {
    throw new Error(`Training sample file not found: ${sample}`);
  }

  const client = getOpenAI();
  if (!client) return fallbackProfile(documentType, sampleFileName);

  const response = await client.responses.create({
    model: modelName(),
    input: [
      {
        role: 'user',
        content: [
          pdfInput(sample),
          {
            type: 'input_text',
            text: [
              'Create a compact retrieval profile for classifying future documents against this document type.',
              'Summarize visual layout cues, issuer/recipient patterns, titles, labels, table structures, and terms that distinguish this type.',
              'Do not extract private values unless they are structural labels.',
              `Document type: ${documentType.name}`,
              `Category: ${documentType.category}`,
              `Extraction prompt: ${documentType.prompt || 'none'}`,
            ].join('\n'),
          },
        ],
      },
    ],
  });

  return response.output_text.trim();
}

async function classifyDocument(document, documentTypes) {
  const candidates = documentTypes.filter((documentType) => documentType.finalized && latestExistingSample(documentType));
  if (!candidates.length) {
    throw new Error('Upload at least one sample and save the schema for a document type before automatic classification.');
  }

  const client = getOpenAI();
  if (!client) return fallbackClassify(document.originalName || document.fileName || '', candidates);

  const content = [
    pdfInput(document.filePath),
    {
      type: 'input_text',
      text: [
        'Classify the uploaded PDF using retrieval profiles and sample PDFs from trained document types.',
        'Choose exactly one candidate document type. Return JSON only.',
        'The score must be a number from 0 to 1 representing match strength.',
        'Return this exact shape:',
        '{"documentTypeId":"candidate_id","score":0.92}',
        `Uploaded file name: ${document.originalName || document.fileName || 'unknown'}`,
        'Candidates:',
        ...candidates.map((candidate, index) => (
          `${index + 1}. id=${candidate._id}; category=${candidate.category}; name=${candidate.name}; profile=${candidate.classifierProfile || fallbackProfile(candidate, latestExistingSample(candidate))}`
        )),
      ].join('\n'),
    },
  ];

  candidates.forEach((candidate, index) => {
    const sampleFileName = latestExistingSample(candidate);
    if (!sampleFileName) return;
    content.push({
      type: 'input_text',
      text: `Retrieved sample for candidate ${index + 1}: id=${candidate._id}; category=${candidate.category}; name=${candidate.name}`,
    });
    content.push(pdfInput(samplePath(sampleFileName)));
  });

  const response = await client.responses.create({
    model: modelName(),
    input: [{ role: 'user', content }],
    text: { format: { type: 'json_object' } },
  });

  const parsed = parseJsonObject(response.output_text);
  const selected = candidates.find((candidate) => String(candidate._id) === parsed.documentTypeId) || candidates[0];
  return {
    documentType: selected,
    score: Number(clampScore(parsed.score).toFixed(2)),
  };
}

function normalizeObjectId(value) {
  if (value instanceof ObjectId) return value;
  return ObjectId.isValid(value) ? new ObjectId(value) : value;
}

module.exports = {
  classifyDocument,
  normalizeObjectId,
  samplePath,
  trainClassifierProfile,
};
