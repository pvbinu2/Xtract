const assert = require('node:assert/strict');
const test = require('node:test');
const { decryptBuffer, decryptJson, encryptBuffer, encryptJson, generateDataEncryptionKey } = require('./data-encryption');

test('encrypts binary data with unique authenticated envelopes', () => {
  const key = generateDataEncryptionKey();
  const first = encryptBuffer(Buffer.from('secret pdf'), { key, keyVersion: 1, context: 'processing/a.pdf', contentType: 'application/pdf' });
  const second = encryptBuffer(Buffer.from('secret pdf'), { key, keyVersion: 1, context: 'processing/a.pdf', contentType: 'application/pdf' });
  assert.notDeepEqual(first, second);
  assert.equal(first.includes(Buffer.from('secret pdf')), false);
  const result = decryptBuffer(first, { keys: { 1: key }, context: 'processing/a.pdf' });
  assert.equal(result.buffer.toString(), 'secret pdf');
  assert.equal(result.contentType, 'application/pdf');
});

test('rejects tampered binary data and the wrong context', () => {
  const key = generateDataEncryptionKey();
  const encrypted = encryptBuffer(Buffer.from('secret'), { key, context: 'processing/a.pdf' });
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptBuffer(encrypted, { key, context: 'processing/a.pdf' }), /authentication failed/);
  const clean = encryptBuffer(Buffer.from('secret'), { key, context: 'processing/a.pdf' });
  assert.throws(() => decryptBuffer(clean, { key, context: 'processing/b.pdf' }), /authentication failed/);
});

test('round trips JSON and rejects wrong keys', () => {
  const key = generateDataEncryptionKey();
  const envelope = encryptJson([{ key: 'invoice', value: 42 }], { key, keyVersion: 1, context: 'doc-1:extractedData' });
  assert.deepEqual(decryptJson(envelope, { keys: { 1: key }, context: 'doc-1:extractedData' }), [{ key: 'invoice', value: 42 }]);
  assert.throws(() => decryptJson(envelope, { key: generateDataEncryptionKey(), context: 'doc-1:extractedData' }), /authentication failed/);
});

test('passes legacy plaintext buffers through unchanged', () => {
  const value = Buffer.from('legacy');
  assert.deepEqual(decryptBuffer(value, { context: 'processing/legacy.pdf' }), { buffer: value, encrypted: false, contentType: undefined });
});
