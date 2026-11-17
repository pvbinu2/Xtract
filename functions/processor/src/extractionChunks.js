function splitDocumentText(text, maxChars = 4000) {
  if (typeof text !== 'string') throw new TypeError('Document text must be a string.');
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError('Chunk size must be a positive integer.');

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start) end = newline + 1;
      if (end > start && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
    }
    if (end === start) throw new RangeError('Chunk size is too small for a Unicode character.');
    chunks.push({ index: chunks.length, start, end, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

function terms(text) {
  return new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) {
    throw new Error('Embedding vectors must have matching, nonzero dimensions.');
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error('Embedding vectors must contain finite numbers.');
    dot += left[i] * right[i];
    leftNorm += left[i] ** 2;
    rightNorm += right[i] ** 2;
  }
  if (!leftNorm || !rightNorm) throw new Error('Embedding vectors must not be zero vectors.');
  const score = dot / Math.sqrt(leftNorm * rightNorm);
  if (!Number.isFinite(score)) throw new Error('Embedding similarity is not finite.');
  return score;
}

function rankSearchResults(chunks, query, semanticScores) {
  const queryTerms = terms(query);
  return chunks.map((chunk) => {
    const chunkTerms = terms(chunk.text);
    const keywordScore = queryTerms.size
      ? [...queryTerms].filter((term) => chunkTerms.has(term)).length / queryTerms.size
      : 0;
    return {
      chunk,
      keywordScore,
      semanticScore: semanticScores.get(chunk.index),
      score: keywordScore + (semanticScores.has(chunk.index) ? (semanticScores.get(chunk.index) + 1) / 2 : 0),
    };
  }).sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
}

module.exports = { splitDocumentText, cosineSimilarity, rankSearchResults };
