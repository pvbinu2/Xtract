const test = require('node:test');
const assert = require('node:assert/strict');
const { splitDocumentText, cosineSimilarity } = require('./extractionChunks');

test('chunks preserve every character and prefer line boundaries', () => {
  const text = 'heading\none row\ntwo rows\nlast row';
  const chunks = splitDocumentText(text, 16);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text);
  assert.deepEqual(chunks.map(({ start, end }) => [start, end]), [[0, 16], [16, 25], [25, 33]]);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 16));
});

test('oversized lines and content beyond 60,000 characters are retained', () => {
  const text = `${'a'.repeat(61000)}\nEnd value`;
  const chunks = splitDocumentText(text);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text);
  assert.equal(chunks.at(-1).end, text.length);
});

test('does not split a table row that fits within a chunk', () => {
  const row = `| ${'a'.repeat(3000)} |`;
  const chunks = splitDocumentText(`${'b'.repeat(100)}\n${row}\n`);
  assert.ok(chunks.some((chunk) => chunk.text.includes(row)));
});

test('rejects invalid vectors during similarity calculation', () => {
  assert.throws(() => cosineSimilarity([1, 2], [1]), /matching/);
  assert.throws(() => cosineSimilarity([0, 0], [1, 0]), /zero/);
});
