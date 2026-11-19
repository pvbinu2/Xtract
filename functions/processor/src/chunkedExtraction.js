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
    const scalarFields = fields.filter((field) => field.type !== 'table');
    const tableFields = fields.filter((field) => field.type === 'table');
    const scalarCandidates = new Map(scalarFields.map((field) => [field.key, []]));
    const tableCandidates = new Map(tableFields.map((field) => [field.key, []]));

    if (scalarFields.length) {
      const query = scalarFields.map((field) => [
        field.label, field.key.replace(/_/g, ' '), field.description,
      ].filter(Boolean).join(' ')).join(' ');
      const retrieved = await index.search(query, Math.min(5, chunks.length));
      const selected = [...new Set(retrieved.flatMap((chunk) => [
        chunks[chunk.index - 1], chunk, chunks[chunk.index + 1],
      ]).filter(Boolean))].sort((a, b) => a.index - b.index);
      log(`Processing scalar fields (fieldCount=${scalarFields.length}, selectedChunks=${selected.length}).`);
      const visited = new Set();
      const allScalarKeys = new Set(scalarFields.map((field) => field.key));
      const fieldsByKey = new Map(scalarFields.map((field) => [field.key, field]));
      const processResult = (chunk, result, targetKeys = allScalarKeys) => {
        addMetrics(metrics, result.metrics);
        if (!Array.isArray(result.values)) throw new Error('Invalid scalar extraction result.');
        const seen = new Set();
        for (const extracted of result.values) {
          if (!extracted || !fieldsByKey.has(extracted.key) || seen.has(extracted.key)) {
            throw new Error('Invalid scalar field in chunk extraction result.');
          }
          seen.add(extracted.key);
          if (!hasValue(extracted.value)) continue;
          if (typeof extracted.value === 'object') throw new Error(`Invalid scalar value for ${extracted.key}.`);
          if (targetKeys.has(extracted.key)) {
            scalarCandidates.get(extracted.key).push({
              value: extracted.value,
              evidence: evidenceFor(chunk, extracted.evidence),
              confidence: extracted.confidence,
            });
          }
        }
        if (seen.size !== scalarFields.length) throw new Error('Scalar chunk result omitted one or more requested fields.');
      };
      const processChunks = async (items, targetKeys = allScalarKeys) => {
        for (let offset = 0; offset < items.length; offset += batchSize) {
          const batch = items.slice(offset, offset + batchSize);
          const results = await Promise.allSettled(batch.map((chunk) => {
            visited.add(chunk.index);
            log(`Processing scalar fields, chunk ${chunk.index + 1}/${chunks.length}.`);
            return Promise.resolve().then(() => extractChunk({ type: 'scalar', fields: scalarFields }, chunk));
          }));
          const failure = results.find((result) => result.status === 'rejected');
          if (failure) throw failure.reason;
          results.forEach((result, index) => processResult(batch[index], result.value, targetKeys));
        }
      };
      await processChunks(selected);
      const missingKeys = new Set(scalarFields
        .filter((field) => scalarCandidates.get(field.key).length === 0)
        .map((field) => field.key));
      if (missingKeys.size) {
        log(`No candidates in selected chunks for ${missingKeys.size} scalar field(s); scanning remaining chunks.`);
        const remaining = chunks.filter((chunk) => !visited.has(chunk.index));
        await processChunks(remaining, missingKeys);
      }
      log(`Processed scalar fields (visitedChunks=${visited.size}, missingFields=${missingKeys.size}).`);
    }

    for (const [fieldIndex, field] of tableFields.entries()) {
      const base = { key: field.key, label: field.label, type: field.type };
      log(`Processing table field ${fieldIndex + 1}/${tableFields.length}.`);
      for (let offset = 0; offset < chunks.length; offset += batchSize) {
        const batch = chunks.slice(offset, offset + batchSize);
        const results = await Promise.allSettled(batch.map((chunk) => {
          log(`Processing table field ${fieldIndex + 1}/${tableFields.length}, chunk ${chunk.index + 1}/${chunks.length}.`);
          return Promise.resolve().then(() => extractChunk({ type: 'table', field }, chunk));
        }));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
        results.forEach((result, index) => {
          const { value } = result.value;
          addMetrics(metrics, result.value.metrics);
          if (!Array.isArray(value)) throw new Error(`Invalid table extraction result for ${field.key}.`);
          let nextEvidenceOffset = 0;
          for (const row of value) {
            if (!row || typeof row.value !== 'object' || Array.isArray(row.value) || row.value === null) {
              throw new Error(`Invalid table row for ${field.key}.`);
            }
            const evidence = evidenceFor(batch[index], row.evidence, nextEvidenceOffset);
            nextEvidenceOffset = evidence.end - batch[index].start;
            tableCandidates.get(field.key).push({ value: row.value, evidence });
          }
        });
      }
      const candidates = tableCandidates.get(field.key).sort((a, b) => a.evidence.start - b.evidence.start);
      values.push({ ...base, value: candidates.map((candidate) => candidate.value), sourceEvidence: candidates.map((candidate) => candidate.evidence) });
    }

    const scalarValues = scalarFields.map((field) => {
      const base = { key: field.key, label: field.label, type: field.type };
      const unique = new Map();
      for (const candidate of scalarCandidates.get(field.key)) {
        const key = JSON.stringify(candidate.value);
        if (!unique.has(key)) unique.set(key, candidate);
      }
      if (unique.size > 1) {
        return { ...base, value: '', confidence: 0, needsReview: true, reviewCandidates: [...unique.values()] };
      }
      if (unique.size === 1) {
        const candidate = unique.values().next().value;
        return { ...base, value: candidate.value, confidence: candidate.confidence, sourceEvidence: [candidate.evidence] };
      }
      return { ...base, value: '', confidence: 0 };
    });
    const valuesByKey = new Map([...scalarValues, ...values].map((value) => [value.key, value]));
    const orderedValues = fields.map((field) => valuesByKey.get(field.key));
    return { values: orderedValues, metrics, embeddingMetrics: index.metrics };
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
