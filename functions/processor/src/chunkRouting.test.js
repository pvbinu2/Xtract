const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldRouteToChunkExtraction } = require('./chunkRouting');

test('routes only enabled text documents at or above the threshold', () => {
  const options = { enabled: true, usesPreparedText: true, spreadsheet: false, threshold: 24000 };
  assert.equal(shouldRouteToChunkExtraction({ ...options, textLength: 23999 }), false);
  assert.equal(shouldRouteToChunkExtraction({ ...options, textLength: 24000 }), true);
  assert.equal(shouldRouteToChunkExtraction({ ...options, textLength: 25000, enabled: false }), false);
  assert.equal(shouldRouteToChunkExtraction({ ...options, textLength: 25000, usesPreparedText: false }), false);
  assert.equal(shouldRouteToChunkExtraction({ ...options, textLength: 25000, spreadsheet: true }), false);
  assert.throws(() => shouldRouteToChunkExtraction({ ...options, textLength: 25000, threshold: 0 }), /threshold/);
});
