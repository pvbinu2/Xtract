const { MongoDatabase } = require('@xtract/common');

const database = new MongoDatabase();

function positiveInteger(value, fallback, maximum = 16) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function createConcurrencyGate(defaultLimit = 1) {
  let active = 0;
  const waiting = [];

  function drain() {
    while (waiting.length && active < waiting[0].limit) {
      active += 1;
      waiting.shift().resolve();
    }
  }

  async function acquire(requestedLimit) {
    const limit = positiveInteger(requestedLimit, defaultLimit);
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push({ limit, resolve }));
  }

  function release() {
    active = Math.max(0, active - 1);
    drain();
  }

  return function withConcurrency(resolveLimit, handler) {
    return async function concurrencyLimitedHandler(...args) {
      let limit = defaultLimit;
      try {
        limit = positiveInteger(await resolveLimit(), defaultLimit);
      } catch {
        // A configuration lookup failure should not prevent queue processing.
      }
      await acquire(limit);
      try {
        return await handler(...args);
      } finally {
        release();
      }
    };
  };
}

async function configuredLimit(field, environmentName, fallback) {
  const client = await database.connect();
  const configuration = await client.db().collection('configuration').findOne({});
  return positiveInteger(
    configuration?.[field],
    positiveInteger(process.env[environmentName], fallback),
  );
}

const preprocessingGate = createConcurrencyGate(4);
const vectorClassificationGate = createConcurrencyGate(4);
const llmClassificationGate = createConcurrencyGate(1);
const extractionGate = createConcurrencyGate(1);

function withPreprocessingConcurrency(handler) {
  return preprocessingGate(
    () => configuredLimit('preprocessingConcurrency', 'PREPROCESSING_CONCURRENCY', 4),
    handler,
  );
}

function withClassificationConcurrency(handler) {
  return async function classificationConcurrencyHandler(...args) {
    let configuration = {};
    try {
      const client = await database.connect();
      configuration = await client.db().collection('configuration').findOne({}) || {};
    } catch {
      // Use environment/default limits when configuration cannot be read.
    }
    const vectorMode = configuration.classificationMode !== 'llm' && configuration.classificationMode !== 'rag';
    const limit = vectorMode
      ? positiveInteger(
        configuration.vectorClassificationConcurrency,
        positiveInteger(process.env.VECTOR_CLASSIFICATION_CONCURRENCY, 4),
      )
      : positiveInteger(
        configuration.llmClassificationConcurrency,
        positiveInteger(process.env.LLM_CLASSIFICATION_CONCURRENCY, 1),
      );
    const gate = vectorMode ? vectorClassificationGate : llmClassificationGate;
    return gate(async () => limit, handler)(...args);
  };
}

function withExtractionConcurrency(handler) {
  return extractionGate(
    () => configuredLimit('extractionConcurrency', 'EXTRACTION_CONCURRENCY', 1),
    handler,
  );
}

module.exports = {
  createConcurrencyGate,
  withClassificationConcurrency,
  withExtractionConcurrency,
  withPreprocessingConcurrency,
};
