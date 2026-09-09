const test = require('node:test');
const assert = require('node:assert/strict');
const { AzureBlobStorage } = require('./storage');

const environmentNames = [
  'AZURE_USE_MANAGED_IDENTITY',
  'AZURE_STORAGE_ACCOUNT_NAME',
  'AZURE_STORAGE_BLOB_SERVICE_URL',
  'AZURE_STORAGE_CONNECTION_STRING',
  'AzureWebJobsStorage',
];

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
  Object.assign(process.env, values);
  try {
    callback();
  } finally {
    for (const name of environmentNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('uses a connection string when managed identity is disabled', () => {
  withEnvironment({ AZURE_USE_MANAGED_IDENTITY: 'false', AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true' }, () => {
    const storage = new AzureBlobStorage();
    assert.equal(storage.useManagedIdentity(), false);
    assert.equal(storage.isConfigured(), true);
  });
});

test('derives the blob endpoint when managed identity is enabled', () => {
  withEnvironment({ AZURE_USE_MANAGED_IDENTITY: 'true', AZURE_STORAGE_ACCOUNT_NAME: 'xtractstorage' }, () => {
    const storage = new AzureBlobStorage();
    assert.equal(storage.useManagedIdentity(), true);
    assert.equal(storage.blobServiceUrl(), 'https://xtractstorage.blob.core.windows.net');
    assert.equal(storage.isConfigured(), true);
  });
});

test('does not fall back to a connection string when managed identity is enabled', () => {
  withEnvironment({ AZURE_USE_MANAGED_IDENTITY: 'true', AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true' }, () => {
    assert.equal(new AzureBlobStorage().isConfigured(), false);
  });
});
