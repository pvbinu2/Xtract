const crypto = require('crypto');

const BLOB_MAGIC = Buffer.from('XTRACTE1', 'ascii');
const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

function generateDataEncryptionKey() {
  return crypto.randomBytes(32).toString('base64');
}

function keyBuffer(value) {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32) throw new Error('A valid 256-bit data encryption key is required.');
  return key;
}

function associatedData(kind, context, keyVersion, metadata = '') {
  return Buffer.from(`xtract:${kind}:v${ENVELOPE_VERSION}:k${keyVersion}:${context}:${metadata}`, 'utf8');
}

function encryptBuffer(value, options) {
  const keyVersion = Number(options?.keyVersion || 1);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer(options?.key), iv);
  const contentType = options?.contentType || 'application/octet-stream';
  cipher.setAAD(associatedData('blob', options?.context || '', keyVersion, contentType));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  const header = Buffer.from(JSON.stringify({
    version: ENVELOPE_VERSION,
    keyVersion,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    contentType,
  }), 'utf8');
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(header.length);
  return Buffer.concat([BLOB_MAGIC, headerLength, header, ciphertext]);
}

function isEncryptedBuffer(value) {
  return Buffer.isBuffer(value) && value.length >= BLOB_MAGIC.length + 4 && value.subarray(0, BLOB_MAGIC.length).equals(BLOB_MAGIC);
}

function decryptBuffer(value, options = {}) {
  if (!isEncryptedBuffer(value)) return { buffer: value, encrypted: false, contentType: options.contentType };
  const headerLength = value.readUInt32BE(BLOB_MAGIC.length);
  const headerStart = BLOB_MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerLength < 1 || headerEnd > value.length) throw new Error('Encrypted blob envelope is corrupt.');
  let header;
  try { header = JSON.parse(value.subarray(headerStart, headerEnd).toString('utf8')); } catch { throw new Error('Encrypted blob header is invalid.'); }
  if (header.version !== ENVELOPE_VERSION || header.algorithm !== ALGORITHM) throw new Error('Encrypted blob version or algorithm is unsupported.');
  const key = options.keys?.[String(header.keyVersion)] || options.key;
  if (!key) throw new Error(`Storage encryption key version ${header.keyVersion} is unavailable.`);
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer(key), Buffer.from(header.iv, 'base64'));
  decipher.setAAD(associatedData('blob', options.context || '', header.keyVersion, header.contentType || 'application/octet-stream'));
  decipher.setAuthTag(Buffer.from(header.tag, 'base64'));
  try {
    return {
      buffer: Buffer.concat([decipher.update(value.subarray(headerEnd)), decipher.final()]),
      encrypted: true,
      contentType: header.contentType || 'application/octet-stream',
      keyVersion: header.keyVersion,
    };
  } catch {
    throw new Error('Encrypted blob authentication failed.');
  }
}

function encryptJson(value, options) {
  const keyVersion = Number(options?.keyVersion || 1);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer(options?.key), iv);
  cipher.setAAD(associatedData('database', options?.context || '', keyVersion));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return {
    version: ENVELOPE_VERSION,
    keyVersion,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptJson(envelope, options = {}) {
  if (!envelope) return undefined;
  if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) throw new Error('Encrypted database payload version or algorithm is unsupported.');
  const key = options.keys?.[String(envelope.keyVersion)] || options.key;
  if (!key) throw new Error(`Database encryption key version ${envelope.keyVersion} is unavailable.`);
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer(key), Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(associatedData('database', options.context || '', envelope.keyVersion));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  try {
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    throw new Error('Encrypted database payload authentication failed.');
  }
}

function resolveDataEncryptionSettings(config = {}) {
  const { decryptSecret } = require('./secret');
  return {
    storage: {
      enabled: Boolean(config.storageEncryptionEnabled),
      keyVersion: Number(config.storageEncryptionKeyVersion) || 1,
      key: config.storageDataEncryptionKey || (config.encryptedStorageDataKey ? decryptSecret(config.encryptedStorageDataKey) : ''),
    },
    database: {
      enabled: Boolean(config.databaseEncryptionEnabled),
      keyVersion: Number(config.databaseEncryptionKeyVersion) || 1,
      key: config.databaseDataEncryptionKey || (config.encryptedDatabaseDataKey ? decryptSecret(config.encryptedDatabaseDataKey) : ''),
    },
  };
}

module.exports = {
  decryptBuffer,
  decryptJson,
  encryptBuffer,
  encryptJson,
  generateDataEncryptionKey,
  isEncryptedBuffer,
  resolveDataEncryptionSettings,
};
