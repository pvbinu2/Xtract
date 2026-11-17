function shouldRouteToChunkExtraction({ enabled, usesPreparedText, spreadsheet, textLength, threshold = 24000 }) {
  if (!enabled || !usesPreparedText || spreadsheet) return false;
  if (!Number.isInteger(threshold) || threshold < 1000 || threshold > 10000000) {
    throw new Error('Invalid chunked extraction threshold.');
  }
  return textLength >= threshold;
}

module.exports = { shouldRouteToChunkExtraction };
