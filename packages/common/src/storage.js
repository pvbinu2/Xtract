const fs = require('fs');
const os = require('os');
const path = require('path');
const { ManagedIdentityCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');
const { decryptBuffer, encryptBuffer } = require('./data-encryption');

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

  useManagedIdentity() { return process.env.AZURE_USE_MANAGED_IDENTITY?.toLowerCase() === 'true'; }

  blobServiceUrl() {
    return process.env.AZURE_STORAGE_BLOB_SERVICE_URL
      || (process.env.AZURE_STORAGE_ACCOUNT_NAME
        ? `https://${process.env.AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`
        : undefined);
  }

  isConfigured() { return this.useManagedIdentity() ? Boolean(this.blobServiceUrl()) : Boolean(this.connectionString()); }

  getClient() {
    if (this.client) return this.client;
    if (this.useManagedIdentity()) {
      const serviceUrl = this.blobServiceUrl();
      if (!serviceUrl) {
        throw this.errorFactory('AZURE_STORAGE_BLOB_SERVICE_URL or AZURE_STORAGE_ACCOUNT_NAME is required when managed identity is enabled.');
      }
      const credential = process.env.AZURE_CLIENT_ID
        ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
        : new ManagedIdentityCredential();
      this.client = new BlobServiceClient(serviceUrl, credential);
      return this.client;
    }
    const value = this.connectionString();
    if (!value) throw this.errorFactory('Azure storage connection string is required for file storage.');
    this.client = BlobServiceClient.fromConnectionString(value);
    return this.client;
  }

  safeFolderName(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document-type';
  }

  createBlobName(originalName, folder) {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(originalName)}`;
    return folder ? `${this.safeFolderName(folder)}/${uniqueName}` : uniqueName;
  }

  async uploadBuffer(containerName, blobName, buffer, contentType, encryption) {
    const container = this.getClient().getContainerClient(containerName);
    await container.createIfNotExists();
    const blob = container.getBlockBlobClient(blobName);
    const payload = encryption?.key ? encryptBuffer(buffer, {
      key: encryption.key, keyVersion: encryption.keyVersion, contentType,
      context: `${containerName}/${blobName}`,
    }) : buffer;
    await blob.uploadData(payload, { blobHTTPHeaders: { blobContentType: encryption?.key ? 'application/octet-stream' : (contentType || 'application/octet-stream') } });
    return { containerName, blobName, url: blob.url };
  }

  async uploadFile(containerName, blobName, filePath, contentType, encryption) {
    return this.uploadBuffer(containerName, blobName, await fs.promises.readFile(filePath), contentType, encryption);
  }

  async downloadBuffer(containerName, blobName, encryption = {}) {
    const value = await this.getClient().getContainerClient(containerName).getBlobClient(blobName).downloadToBuffer();
    return decryptBuffer(value, { ...encryption, context: `${containerName}/${blobName}` }).buffer;
  }

  async downloadToTemp(containerName, blobName, encryption) {
    const buffer = await this.downloadBuffer(containerName, blobName, encryption);
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

  async moveBlob(sourceContainerName, sourceBlobName, targetContainerName, targetBlobName, options = {}) {
    const source = this.getClient().getContainerClient(sourceContainerName).getBlobClient(sourceBlobName);
    const targetContainer = this.getClient().getContainerClient(targetContainerName);
    await targetContainer.createIfNotExists();
    const target = targetContainer.getBlockBlobClient(targetBlobName);
    const [raw, properties] = await Promise.all([source.downloadToBuffer(), source.getProperties()]);
    const decoded = decryptBuffer(raw, { ...(options.source || {}), context: `${sourceContainerName}/${sourceBlobName}`, contentType: properties.contentType });
    const contentType = decoded.contentType || properties.contentType || 'application/octet-stream';
    const payload = options.target?.key ? encryptBuffer(decoded.buffer, {
      key: options.target.key, keyVersion: options.target.keyVersion, contentType,
      context: `${targetContainerName}/${targetBlobName}`,
    }) : decoded.buffer;
    await target.uploadData(payload, { blobHTTPHeaders: { blobContentType: options.target?.key ? 'application/octet-stream' : contentType } });
    await source.deleteIfExists();
    return { containerName: targetContainerName, blobName: targetBlobName, url: target.url };
  }

  async removeTempFile(filePath) {
    if (!filePath) return;
    try { await fs.promises.unlink(filePath); } catch { /* cleanup is best effort */ }
  }
}

module.exports = { AzureBlobStorage, TRAIN_CONTAINER, PROCESSING_CONTAINER, TRIGGER_CONTAINER };
