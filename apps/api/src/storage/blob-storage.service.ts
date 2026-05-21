import { BadRequestException, Injectable } from '@nestjs/common';
import { BlobServiceClient } from '@azure/storage-blob';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, extname, join } from 'path';

export const TRAIN_CONTAINER = 'train';
export const PROCESSING_CONTAINER = 'processing';

@Injectable()
export class BlobStorageService {
  private client?: BlobServiceClient;

  private connectionString() {
    return process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
  }

  isConfigured() {
    return Boolean(this.connectionString());
  }

  private getClient() {
    const connectionString = this.connectionString();
    if (!connectionString) {
      throw new BadRequestException('Azure storage connection string is required for file storage.');
    }
    if (!this.client) this.client = BlobServiceClient.fromConnectionString(connectionString);
    return this.client;
  }

  safeFolderName(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'document-type';
  }

  createBlobName(originalName: string, folder?: string) {
    const extension = extname(originalName);
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
    return folder ? `${this.safeFolderName(folder)}/${uniqueName}` : uniqueName;
  }

  async uploadBuffer(containerName: string, blobName: string, buffer: Buffer, contentType?: string) {
    const container = this.getClient().getContainerClient(containerName);
    await container.createIfNotExists();
    const blob = container.getBlockBlobClient(blobName);
    await blob.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: contentType || 'application/octet-stream' },
    });
    return {
      containerName,
      blobName,
      url: blob.url,
    };
  }

  async uploadFile(containerName: string, blobName: string, filePath: string, contentType?: string) {
    return this.uploadBuffer(containerName, blobName, await readFile(filePath), contentType);
  }

  async downloadToTemp(containerName: string, blobName: string) {
    const container = this.getClient().getContainerClient(containerName);
    const blob = container.getBlobClient(blobName);
    const download = await blob.downloadToBuffer();
    const folder = join(tmpdir(), 'xtract-storage');
    await mkdir(folder, { recursive: true });
    const filePath = join(folder, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${basename(blobName)}`);
    await writeFile(filePath, download);
    return filePath;
  }

  async downloadBuffer(containerName: string, blobName: string) {
    const container = this.getClient().getContainerClient(containerName);
    return container.getBlobClient(blobName).downloadToBuffer();
  }

  async deleteBlob(containerName?: string, blobName?: string) {
    if (!containerName || !blobName) return;
    const container = this.getClient().getContainerClient(containerName);
    await container.getBlobClient(blobName).deleteIfExists();
  }

  async removeTempFile(filePath?: string) {
    if (!filePath) return;
    try {
      await unlink(filePath);
    } catch {
      // Temp cleanup should never mask the original operation.
    }
  }
}
