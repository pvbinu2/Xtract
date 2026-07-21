const fs = require('fs');
const os = require('os');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const TRAIN_CONTAINER = 'train';
const PROCESSING_CONTAINER = 'processing';
const TRIGGER_CONTAINER = 'trigger';

class AzureBlobStorage {
  constructor(options = {}) {
    this.configuredConnectionString = options.connectionString;
    this.errorFactory = options.errorFactory || ((message) => new Error(message));
    this.client = undefined;
  }

  connectionString() {
    return this.configuredConnectionString || process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  }

  isConfigured() { return Boolean(this.connectionString()); }

  getClient() {
    const value = this.connectionString();
    if (!value) throw this.errorFactory('Azure storage connection string is required for file storage.');
    if (!this.client) this.client = BlobServiceClient.fromConnectionString(value);
    return this.client;
  }

  safeFolderName(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document-type';
  }

  createBlobName(originalName, folder) {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(originalName)}`;
    return folder ? `${this.safeFolderName(folder)}/${uniqueName}` : uniqueName;
  }

  async uploadBuffer(containerName, blobName, buffer, contentType) {
    const container = this.getClient().getContainerClient(containerName);
    await container.createIfNotExists();
    const blob = container.getBlockBlobClient(blobName);
    await blob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType || 'application/octet-stream' } });
    return { containerName, blobName, url: blob.url };
  }

  async uploadFile(containerName, blobName, filePath, contentType) {
    return this.uploadBuffer(containerName, blobName, await fs.promises.readFile(filePath), contentType);
  }

  async downloadBuffer(containerName, blobName) {
    return this.getClient().getContainerClient(containerName).getBlobClient(blobName).downloadToBuffer();
  }

  async downloadToTemp(containerName, blobName) {
    const buffer = await this.downloadBuffer(containerName, blobName);
    const folder = path.join(os.tmpdir(), 'xtract-storage');
    await fs.promises.mkdir(folder, { recursive: true });
    const filePath = path.join(folder, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${path.basename(blobName)}`);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  }

  async deleteBlob(containerName, blobName) {
    if (!containerName || !blobName) return;
    await this.getClient().getContainerClient(containerName).getBlobClient(blobName).deleteIfExists();
  }

  async moveBlob(sourceContainerName, sourceBlobName, targetContainerName, targetBlobName) {
    const source = this.getClient().getContainerClient(sourceContainerName).getBlobClient(sourceBlobName);
    const targetContainer = this.getClient().getContainerClient(targetContainerName);
    await targetContainer.createIfNotExists();
    const target = targetContainer.getBlockBlobClient(targetBlobName);
    const [buffer, properties] = await Promise.all([source.downloadToBuffer(), source.getProperties()]);
    await target.uploadData(buffer, { blobHTTPHeaders: { blobContentType: properties.contentType || 'application/octet-stream' } });
    await source.deleteIfExists();
    return { containerName: targetContainerName, blobName: targetBlobName, url: target.url };
  }

  async removeTempFile(filePath) {
    if (!filePath) return;
    try { await fs.promises.unlink(filePath); } catch { /* cleanup is best effort */ }
  }
}

module.exports = { AzureBlobStorage, TRAIN_CONTAINER, PROCESSING_CONTAINER, TRIGGER_CONTAINER };
