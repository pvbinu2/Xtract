const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const filename = path.join(__dirname, '../src/conflict-resolution.ts');
const compiled = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS },
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(compiled, filename);
const { selectReviewCandidate } = loaded.exports;

test('selecting a candidate preserves its type and evidence and clears the conflict', () => {
  const field = {
    key: 'amount', label: 'Amount', type: 'number', value: '', needsReview: true,
    boundingBoxes: [{ page: 0 }], cellReferences: [{ sheetIndex: 0 }],
    reviewCandidates: [
      { value: 10, confidence: 0.9, evidence: { start: 5, end: 7, quote: '10' } },
      { value: 0, confidence: 0.7, evidence: { start: 50, end: 51, quote: '0' } },
    ],
  };
  const selected = selectReviewCandidate(field, field.reviewCandidates[1]);
  assert.equal(selected.value, 0);
  assert.equal(selected.confidence, 0.7);
  assert.equal(selected.needsReview, false);
  assert.deepEqual(selected.sourceEvidence, [{ start: 50, end: 51, quote: '0' }]);
  assert.deepEqual(selected.reviewCandidates, []);
  assert.deepEqual(selected.boundingBoxes, []);
  assert.deepEqual(selected.cellReferences, []);
  assert.equal(field.needsReview, true);
  assert.equal(field.reviewCandidates.length, 2);
});
