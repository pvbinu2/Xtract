const fs = require('fs');
const os = require('os');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const TRAIN_CONTAINER = 'train';
const PROCESSING_CONTAINER = 'processing';
const TRIGGER_CONTAINER = 'trigger';

let client;

function connectionString() {
  return process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
}

function isConfigured() {
  return Boolean(connectionString());
}

function getClient() {
  const value = connectionString();
  if (!value) throw new Error('Azure storage connection string is required for file storage.');
  if (!client) client = BlobServiceClient.fromConnectionString(value);
  return client;
}

function createBlobName(originalName) {
  const extension = path.extname(originalName);
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
}

async function moveBlob(sourceContainerName, sourceBlobName, targetContainerName, targetBlobName) {
  const serviceClient = getClient();
  const sourceBlob = serviceClient.getContainerClient(sourceContainerName).getBlobClient(sourceBlobName);
  const targetContainer = serviceClient.getContainerClient(targetContainerName);
  await targetContainer.createIfNotExists();
  const targetBlob = targetContainer.getBlockBlobClient(targetBlobName);
  const [buffer, properties] = await Promise.all([
    sourceBlob.downloadToBuffer(),
    sourceBlob.getProperties(),
  ]);
  await targetBlob.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: properties.contentType || 'application/octet-stream',
    },
  });
  await sourceBlob.deleteIfExists();
  return {
    containerName: targetContainerName,
    blobName: targetBlobName,
    url: targetBlob.url,
  };
}

async function downloadToTemp(containerName, blobName) {
  const container = getClient().getContainerClient(containerName);
  const buffer = await container.getBlobClient(blobName).downloadToBuffer();
  const folder = path.join(os.tmpdir(), 'xtract-storage');
  await fs.promises.mkdir(folder, { recursive: true });
  const filePath = path.join(folder, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(blobName)}`);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

async function removeTempFile(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // Cleanup should not hide processing errors.
  }
}

module.exports = {
  PROCESSING_CONTAINER,
  TRAIN_CONTAINER,
  TRIGGER_CONTAINER,
  createBlobName,
  downloadToTemp,
  isConfigured,
  moveBlob,
  removeTempFile,
};
