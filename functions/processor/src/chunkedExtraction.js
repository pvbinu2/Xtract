const { splitDocumentText } = require('./extractionChunks');
const { createChunkIndex } = require('./chunkRetrieval');

function addMetrics(total, next) {
  total.model = next.model || total.model;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'estimatedCostUsd']) {
    total[key] += Number(next[key] || 0);
  }
}

function evidenceFor(chunk, quote, from = 0) {
  if (typeof quote !== 'string' || !quote.trim()) throw new Error('Extracted value is missing source evidence.');
  const offset = chunk.text.indexOf(quote, from);
  if (offset < 0) throw new Error('Extracted source evidence was not found in the document chunk.');
  return { start: chunk.start + offset, end: chunk.start + offset + quote.length, quote };
}

function hasValue(value) {
  return value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '');
}

async function extractChunkedDocument({ text, fields, indexOptions, extractChunk, batchSize = 2, createIndex = createChunkIndex, log = () => {} }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 16) {
    throw new RangeError('Chunk extraction batch size must be an integer between 1 and 16.');
  }
  const chunks = splitDocumentText(text);
  if (!chunks.length) throw new Error('Prepared document text is empty.');
  log(`Chunk extraction started (chunkCount=${chunks.length}, fieldCount=${fields.length}, batchSize=${batchSize}, index=${indexOptions?.index || 'custom'}).`);
  for (const chunk of chunks) {
    let before = Math.max(0, chunk.start - 200);
    let after = Math.min(text.length, chunk.end + 200);
    if (before && /[\uDC00-\uDFFF]/.test(text[before]) && /[\uD800-\uDBFF]/.test(text[before - 1])) before -= 1;
    if (after < text.length && /[\uD800-\uDBFF]/.test(text[after - 1]) && /[\uDC00-\uDFFF]/.test(text[after])) after += 1;
    chunk.contextBefore = text.slice(before, chunk.start);
    chunk.contextAfter = text.slice(chunk.end, after);
  }
  if (fields.some((field) => field.type === 'table')) {
    for (const line of text.split('\n')) {
      if (line.trimStart().startsWith('|') && line.length > 4000) {
        throw new Error('A Markdown table row exceeds the chunk size.');
      }
    }
    const headers = [...text.matchAll(/^\s*(\|[^\n]+\|)\s*\n\s*(\|[\s:|-]+\|)[ \t]*$/gm)]
      .map((match) => ({ start: match.index, text: `${match[1]}\n${match[2]}` }));
    let headerIndex = -1;
    for (const chunk of chunks) {
      while (headerIndex + 1 < headers.length && headers[headerIndex + 1].start < chunk.start) headerIndex += 1;
      if (headerIndex >= 0 && headers[headerIndex].text.length <= 1000 && chunk.text.includes('|')) {
        chunk.tableHeader = headers[headerIndex].text;
      }
    }
  }
  const metrics = { model: '', inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, processedAt: new Date() };
  const index = await createIndex(chunks, indexOptions);
  log('Chunk index created.');
  let extractionError;
  try {
    const values = [];
    for (const [fieldIndex, field] of fields.entries()) {
      const base = { key: field.key, label: field.label, type: field.type };
      const query = [field.label, field.key.replace(/_/g, ' '), field.description, ...(field.columns || []).map((column) => column.label)].filter(Boolean).join(' ');
      const retrieved = field.type === 'table' ? chunks : await index.search(query, Math.min(5, chunks.length));
      const selected = field.type === 'table' ? chunks : [...new Set(retrieved.flatMap((chunk) => [
        chunks[chunk.index - 1], chunk, chunks[chunk.index + 1],
      ]).filter(Boolean))].sort((a, b) => a.index - b.index);
      log(`Processing field ${fieldIndex + 1}/${fields.length} (selectedChunks=${selected.length}, table=${field.type === 'table'}).`);
      const candidates = [];
      const visited = new Set();
      const processResult = (chunk, result) => {
        addMetrics(metrics, result.metrics);
        if (field.type === 'table') {
          if (!Array.isArray(result.value)) throw new Error(`Invalid table extraction result for ${field.key}.`);
          let nextEvidenceOffset = 0;
          for (const row of result.value) {
            if (!row || typeof row.value !== 'object' || Array.isArray(row.value) || row.value === null) {
              throw new Error(`Invalid table row for ${field.key}.`);
            }
            const evidence = evidenceFor(chunk, row.evidence, nextEvidenceOffset);
            nextEvidenceOffset = evidence.end - chunk.start;
            candidates.push({ value: row.value, evidence, confidence: result.confidence });
          }
        } else if (hasValue(result.value)) {
          candidates.push({ value: result.value, evidence: evidenceFor(chunk, result.evidence), confidence: result.confidence });
        }
      };
      const processChunks = async (items) => {
        for (let offset = 0; offset < items.length; offset += batchSize) {
          const batch = items.slice(offset, offset + batchSize);
          const results = await Promise.allSettled(batch.map((chunk) => {
            visited.add(chunk.index);
            log(`Processing field ${fieldIndex + 1}/${fields.length}, chunk ${chunk.index + 1}/${chunks.length}.`);
            return Promise.resolve().then(() => extractChunk(field, chunk));
          }));
          const failure = results.find((result) => result.status === 'rejected');
          if (failure) throw failure.reason;
          results.forEach((result, index) => processResult(batch[index], result.value));
        }
      };
      await processChunks(selected);
      if (field.type !== 'table' && !candidates.length) {
        log(`No candidates in selected chunks for field ${fieldIndex + 1}; scanning remaining chunks.`);
        await processChunks(chunks.filter((chunk) => !visited.has(chunk.index)));
      }
      log(`Processed field ${fieldIndex + 1}/${fields.length} (visitedChunks=${visited.size}, candidates=${candidates.length}).`);

      if (field.type === 'table') {
        candidates.sort((a, b) => a.evidence.start - b.evidence.start);
        values.push({ ...base, value: candidates.map((candidate) => candidate.value), sourceEvidence: candidates.map((candidate) => candidate.evidence) });
      } else {
        const unique = new Map();
        for (const candidate of candidates) {
          const key = JSON.stringify(candidate.value);
          if (!unique.has(key)) unique.set(key, candidate);
        }
        if (unique.size > 1) {
          values.push({ ...base, value: '', confidence: 0, needsReview: true, reviewCandidates: [...unique.values()] });
        } else if (unique.size === 1) {
          const candidate = unique.values().next().value;
          values.push({ ...base, value: candidate.value, confidence: candidate.confidence, sourceEvidence: [candidate.evidence] });
        } else {
          values.push({ ...base, value: '', confidence: 0 });
        }
      }
    }
    return { values, metrics, embeddingMetrics: index.metrics };
  } catch (error) {
    extractionError = error;
    throw error;
  } finally {
    try {
      await index.close();
      log('Chunk index closed.');
    } catch (cleanupError) {
      if (extractionError) {
        throw new AggregateError([extractionError, cleanupError], 'Chunk extraction and vector cleanup both failed.');
      }
      throw cleanupError;
    }
  }
}

module.exports = { extractChunkedDocument };
