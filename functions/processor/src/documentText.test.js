const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDocumentContent } = require('./documentText');

test('passes the document correlation ID to Docling without requiring it for other callers', async () => {
  const previousFetch = global.fetch;
  const requests = [];
  global.fetch = async (_, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ markdown: 'text', elements: [] }) };
  };
  try {
    const options = { mode: 'markdown', markdownServiceUrl: 'http://example.test' };
    await extractDocumentContent(__filename, 100, { ...options, documentId: '0123456789abcdef01234567' });
    await extractDocumentContent(__filename, 100, options);
    assert.equal(requests[0].documentId, '0123456789abcdef01234567');
    assert.equal('documentId' in requests[1], false);
  } finally {
    global.fetch = previousFetch;
  }
});
