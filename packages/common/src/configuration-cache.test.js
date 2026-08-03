const assert = require('node:assert/strict');
const test = require('node:test');
const { ConfigurationCache } = require('./configuration-cache');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('coalesces concurrent loads and refreshes after the configured TTL', async () => {
  let loads = 0;
  const cache = new ConfigurationCache({
    ttlMs: 10,
    loader: async () => {
      const version = ++loads;
      await pause(5);
      return { version };
    },
  });

  const values = await Promise.all(Array.from({ length: 10 }, () => cache.get()));
  assert.equal(loads, 1);
  assert.ok(values.every(({ version }) => version === 1));
  await pause(15);
  assert.deepEqual(await cache.get(), { version: 2 });
});

test('serves stale configuration when a refresh fails', async () => {
  let fail = false;
  const warnings = [];
  const cache = new ConfigurationCache({
    ttlMs: 5,
    logger: { warn: (message) => warnings.push(message) },
    loader: async () => {
      if (fail) throw new Error('database unavailable');
      return { version: 1 };
    },
  });

  await cache.get();
  fail = true;
  await pause(10);
  assert.deepEqual(await cache.get(), { version: 1 });
  assert.match(warnings[0], /stale in-memory configuration/);
});

test('replacement makes saved configuration immediately available', async () => {
  const cache = new ConfigurationCache({ loader: async () => ({ version: 1 }) });
  await cache.get();
  cache.replace({ version: 2 });
  assert.deepEqual(await cache.get(), { version: 2 });
});

test('disabled caching reads through to the loader every time without stale fallback', async () => {
  let loads = 0;
  let fail = false;
  const cache = new ConfigurationCache({
    loader: async () => {
      if (fail) throw new Error('database unavailable');
      return { cachingEnabled: false, version: ++loads };
    },
  });

  assert.equal((await cache.get()).version, 1);
  assert.equal((await cache.get()).version, 2);
  fail = true;
  await assert.rejects(cache.get(), /database unavailable/);
});

test('uses the TTL saved in configuration', async () => {
  let loads = 0;
  const cache = new ConfigurationCache({
    ttlMs: 60000,
    loader: async () => ({ cachingEnabled: true, configurationCacheTtlSeconds: 0.01, version: ++loads }),
  });

  await cache.get();
  await pause(15);
  assert.equal((await cache.get()).version, 2);
});
