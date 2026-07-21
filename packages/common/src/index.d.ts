import type { Collection, Db, MongoClient } from 'mongodb';

export { ObjectId } from 'mongodb';
export const TRAIN_CONTAINER: string;
export const PROCESSING_CONTAINER: string;
export const TRIGGER_CONTAINER: string;

export class MongoDatabase {
  constructor(options?: { uri?: string; databaseName?: string });
  static resolveUri(): string;
  connect(): Promise<MongoClient>;
  database(): Promise<Db>;
  collection<T extends object = object>(name: string): Promise<Collection<T>>;
  close(): Promise<void>;
}

export class AzureBlobStorage {
  constructor(options?: { connectionString?: string; errorFactory?: (message: string) => Error });
  connectionString(): string | undefined;
  isConfigured(): boolean;
  safeFolderName(value: string): string;
  createBlobName(originalName: string, folder?: string): string;
  uploadBuffer(containerName: string, blobName: string, buffer: Buffer, contentType?: string): Promise<{containerName: string; blobName: string; url: string}>;
  uploadFile(containerName: string, blobName: string, filePath: string, contentType?: string): Promise<{containerName: string; blobName: string; url: string}>;
  downloadBuffer(containerName: string, blobName: string): Promise<Buffer>;
  downloadToTemp(containerName: string, blobName: string): Promise<string>;
  deleteBlob(containerName?: string, blobName?: string): Promise<void>;
  moveBlob(sourceContainerName: string, sourceBlobName: string, targetContainerName: string, targetBlobName: string): Promise<{containerName: string; blobName: string; url: string}>;
  removeTempFile(filePath?: string): Promise<void>;
}

export class QdrantVectorDatabase {
  constructor(options?: { baseUrl?: string; collectionName?: string; fetch?: typeof fetch });
  ensureCollection(size: number): Promise<void>;
  resetCollection(): Promise<void>;
  deleteByFilter(filter: object): Promise<void>;
  upsert(points: object[]): Promise<unknown>;
  search(vector: number[], limit?: number): Promise<any[]>;
}

export type OcrContent = { text: string; spatialItems?: object[] };
export class OcrService {
  constructor(strategies: {
    extractEmbeddedText: (filePath: string) => Promise<string>;
    extractOcrContent: (filePath: string, options?: object) => Promise<OcrContent>;
    extractMarkdownContent?: (filePath: string, options?: object) => Promise<OcrContent>;
  });
  extract(filePath: string, limit?: number, options?: object): Promise<Required<OcrContent>>;
  extractText(filePath: string, limit?: number, options?: object): Promise<string>;
}
