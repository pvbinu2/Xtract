const test = require('node:test');
const assert = require('node:assert/strict');
const { decryptSecret, encryptSecret } = require('./secret');

test('decrypts credentials created with the legacy JWT secret after a config key is introduced', () => {
  const originalConfigKey = process.env.CONFIG_ENCRYPTION_KEY;
  const originalJwtSecret = process.env.JWT_SECRET;
  try {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    process.env.JWT_SECRET = 'legacy-jwt-secret';
    const encrypted = encryptSecret('two-factor-secret');

    process.env.CONFIG_ENCRYPTION_KEY = 'new-config-secret';
    assert.equal(decryptSecret(encrypted), 'two-factor-secret');
  } finally {
    if (originalConfigKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = originalConfigKey;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  }
});

test('new credentials use the config encryption key', () => {
  const originalConfigKey = process.env.CONFIG_ENCRYPTION_KEY;
  const originalJwtSecret = process.env.JWT_SECRET;
  try {
    process.env.CONFIG_ENCRYPTION_KEY = 'current-config-secret';
    process.env.JWT_SECRET = 'legacy-jwt-secret';
    const encrypted = encryptSecret('current-secret');
    process.env.JWT_SECRET = 'different-legacy-secret';
    assert.equal(decryptSecret(encrypted), 'current-secret');
  } finally {
    if (originalConfigKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = originalConfigKey;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  }
});
