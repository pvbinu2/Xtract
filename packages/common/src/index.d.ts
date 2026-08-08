import type { Collection, Db, MongoClient } from 'mongodb';

export { ObjectId } from 'mongodb';
export const TRAIN_CONTAINER: string;
export const PROCESSING_CONTAINER: string;
export const TRIGGER_CONTAINER: string;
export function encryptSecret(value: string): string;
export function decryptSecret(value?: string): string;
export function generateDataEncryptionKey(): string;
export type DataEncryptionEnvelope = { version: number; keyVersion: number; algorithm: string; iv: string; tag: string; ciphertext: string };
export function encryptJson<T>(value: T, options: { key: string; keyVersion?: number; context: string }): DataEncryptionEnvelope;
export function decryptJson<T>(value: DataEncryptionEnvelope, options: { key?: string; keys?: Record<string, string>; context: string }): T;
export function encryptBuffer(value: Buffer, options: { key: string; keyVersion?: number; context: string; contentType?: string }): Buffer;
export function decryptBuffer(value: Buffer, options?: { key?: string; keys?: Record<string, string>; context?: string; contentType?: string }): { buffer: Buffer; encrypted: boolean; contentType?: string; keyVersion?: number };
export function isEncryptedBuffer(value: Buffer): boolean;
export function resolveDataEncryptionSettings(config: Record<string, any>): {
  storage: { enabled: boolean; keyVersion: number; key: string };
  database: { enabled: boolean; keyVersion: number; key: string };
};

export class ConfigurationCache<T = Record<string, unknown>> {
  constructor(options: {
    loader: () => Promise<T>;
    ttlMs?: number;
    logger?: Pick<Console, 'warn'>;
  });
  get(): Promise<T>;
  replace(value: T): T;
  invalidate(): void;
}

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
  uploadBuffer(containerName: string, blobName: string, buffer: Buffer, contentType?: string, encryption?: {key: string; keyVersion: number}): Promise<{containerName: string; blobName: string; url: string}>;
  uploadFile(containerName: string, blobName: string, filePath: string, contentType?: string, encryption?: {key: string; keyVersion: number}): Promise<{containerName: string; blobName: string; url: string}>;
  downloadBuffer(containerName: string, blobName: string, encryption?: {key?: string; keys?: Record<string,string>}): Promise<Buffer>;
  downloadToTemp(containerName: string, blobName: string, encryption?: {key?: string; keys?: Record<string,string>}): Promise<string>;
  deleteBlob(containerName?: string, blobName?: string): Promise<void>;
  moveBlob(sourceContainerName: string, sourceBlobName: string, targetContainerName: string, targetBlobName: string, options?: {
    source?: {key?: string; keys?: Record<string,string>};
    target?: {key: string; keyVersion: number};
  }): Promise<{containerName: string; blobName: string; url: string}>;
  removeTempFile(filePath?: string): Promise<void>;
}

export class QdrantVectorDatabase {
  constructor(options?: { baseUrl?: string; collectionName?: string; apiKey?: string; fetch?: typeof fetch });
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
