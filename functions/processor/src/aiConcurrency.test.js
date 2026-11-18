const test = require('node:test');
const assert = require('node:assert/strict');

test('model classification can reuse an already held LLM gate after configuration changes', { timeout: 1000 }, async () => {
  const filename = require.resolve('./configurationCache');
  const original = require.cache[filename];
  let mode = 'rag';
  require.cache[filename] = {
    id: filename, filename, loaded: true,
    exports: { getConfiguration: async () => ({ classificationMode: mode, llmClassificationConcurrency: 1 }) },
  };
  delete require.cache[require.resolve('./aiConcurrency')];
  try {
    const { withClassificationConcurrency, withLlmClassificationConcurrency } = require('./aiConcurrency');
    const handler = withClassificationConcurrency(async () => {
      mode = 'vector';
      return withLlmClassificationConcurrency(async () => 'completed')();
    });
    assert.equal(await handler(), 'completed');
  } finally {
    if (original) require.cache[filename] = original;
    else delete require.cache[filename];
    delete require.cache[require.resolve('./aiConcurrency')];
  }
});
