const { app } = require('@azure/functions');
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const { attachBoundingBoxes } = require('../pdfBoundingBox');

let clientPromise;
let openai;

function getClient() {
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/xtract').connect();
  }
  return clientPromise;
}

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return undefined;
  if (!openai) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

function parseJsonObject(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function extractValuesWithOpenAI(document, documentType) {
  const client = getOpenAI();
  if (!client) return undefined;

  const selectedFields = (documentType.fields || []).filter((field) => field.selected);
  const pdf = fs.readFileSync(document.filePath).toString('base64');
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: path.basename(document.filePath),
            file_data: `data:application/pdf;base64,${pdf}`,
          },
          {
            type: 'input_text',
            text: [
              `Extract values from this ${documentType.name} PDF.`,
              'Return JSON only. Do not include markdown.',
              'If a value is missing, return an empty string and low confidence.',
              'For table fields, return an array of row objects.',
              'Return this exact shape:',
              '{"fields":[{"key":"field_key","value":"extracted value","confidence":0.92}]}',
              `Schema: ${JSON.stringify(
                selectedFields.map((field) => ({
                  key: field.key,
                  label: field.label,
                  type: field.type,
                  description: field.description,
                  columns: field.type === 'table' ? field.columns || [] : undefined,
                })),
              )}`,
            ].join('\n'),
          },
        ],
      },
    ],
    text: { format: { type: 'json_object' } },
  });

  const parsed = parseJsonObject(response.output_text);
  const byKey = new Map((parsed.fields || []).map((field) => [field.key, field]));
  return selectedFields.map((field) => {
    const extracted = byKey.get(field.key);
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      value: extracted?.value ?? '',
      confidence: typeof extracted?.confidence === 'number' ? extracted.confidence : undefined,
    };
  });
}

function mockValue(label, type, index) {
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'number') return index + 1;
  if (type === 'currency') return Number((250 + index * 125.5).toFixed(2));
  if (type === 'boolean') return true;
  if (type === 'table') return [{ item: 'Sample line', quantity: 1, amount: 100 }];
  return `Extracted ${label}`;
}

function resolveDocumentId(message) {
  if (typeof message === 'string') {
    try {
      const parsed = JSON.parse(message);
      return parsed.documentId || parsed.id || message;
    } catch {
      return message;
    }
  }
  return message?.documentId || message?.id;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

async function markDocumentFailed(documents, documentId, error) {
  await documents.updateOne(
    { _id: documentId },
    { $set: { status: 'failed', error, updatedAt: new Date() } },
  );
}

async function processDocument(message, context) {
  const documentId = resolveDocumentId(message);
  if (!documentId || !ObjectId.isValid(documentId)) {
    context.warn(`Skipping queue message without a valid documentId: ${JSON.stringify(message)}`);
    return;
  }

  const client = await getClient();
  const db = client.db();
  const documents = db.collection('incomingdocuments');
  const documentTypes = db.collection('documenttypes');

  const document = await documents.findOne({ _id: new ObjectId(documentId) });
  if (!document) {
    context.error(`Document ${documentId} not found`);
    return;
  }

  const documentTypeId =
    document.documentTypeId instanceof ObjectId
      ? document.documentTypeId
      : ObjectId.isValid(document.documentTypeId)
        ? new ObjectId(document.documentTypeId)
        : document.documentTypeId;
  const documentType = await documentTypes.findOne({ _id: documentTypeId });
  if (!documentType) {
    await documents.updateOne(
      { _id: document._id },
      { $set: { status: 'failed', error: 'Document type not found', updatedAt: new Date() } },
    );
    return;
  }

  if (!document.filePath || !fileExists(document.filePath)) {
    const errorMessage = `Document file not found: ${document.filePath || 'missing filePath'}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
    return;
  }

  try {
    const extractedData = await attachBoundingBoxes(
      document.filePath,
      (await extractValuesWithOpenAI(document, documentType)) ||
        (documentType.fields || [])
          .filter((field) => field.selected)
          .map((field, index) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            value: mockValue(field.label, field.type, index),
            confidence: Number((0.82 + Math.min(index, 8) * 0.015).toFixed(2)),
          })),
    );

    await documents.updateOne(
      { _id: document._id },
      {
        $set: {
          status: 'extracted',
          extractedData,
          error: null,
          updatedAt: new Date(),
        },
      },
    );
  } catch (error) {
    const errorMessage = `Processing failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
  }
}

app.storageQueue('processDocument', {
  queueName: 'document-processing',
  connection: 'AzureWebJobsStorage',
  handler: processDocument,
});
