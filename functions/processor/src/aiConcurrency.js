function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createConcurrencyGate(limit) {
  let active = 0;
  const waiting = [];

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  async function acquire() {
    if (active >= limit) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active += 1;
  }

  return function withConcurrency(handler) {
    return async function concurrencyLimitedHandler(...args) {
      await acquire();
      try {
        return await handler(...args);
      } finally {
        release();
      }
    };
  };
}

const withAiConcurrency = createConcurrencyGate(
  positiveInteger(process.env.AI_PROCESSING_CONCURRENCY, 1),
);

module.exports = { createConcurrencyGate, withAiConcurrency };
