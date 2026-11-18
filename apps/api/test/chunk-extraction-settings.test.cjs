const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ConfigurationService } = require('../dist/configuration/configuration.service');

function createService(initial = {}) {
  let stored = initial;
  const query = (value) => ({
    select() { return this; },
    lean() { return this; },
    async exec() { return value; },
  });
  const model = {
    findOne: () => query(stored),
    findOneAndUpdate: (_, update) => {
      stored = { ...stored, ...update };
      return query(stored);
    },
  };
  return new ConfigurationService(model);
}

test('batch size defaults, saves, and remains set when omitted by an older client', async () => {
  const service = createService();
  assert.equal((await service.getPublic()).chunkedExtractionBatchSize, 2);
  const config = { downstreamUrl: '', deleteAfterDownstream: false };
  assert.equal((await service.save({ ...config, chunkedExtractionBatchSize: 5 })).chunkedExtractionBatchSize, 5);
  assert.equal((await service.save(config)).chunkedExtractionBatchSize, 5);
});

test('rejects invalid batch sizes', async () => {
  const service = createService();
  for (const chunkedExtractionBatchSize of [0, 17, 1.5, '2', null]) {
    await assert.rejects(
      service.save({ downstreamUrl: '', deleteAfterDownstream: false, chunkedExtractionBatchSize }),
      /batch size must be an integer between 1 and 16/,
    );
  }
});
