const crypto = require('crypto');

function encryptionKey() {
  const secret = process.env.CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('CONFIG_ENCRYPTION_KEY or JWT_SECRET is required to encrypt AI credentials.');
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptSecret(value) {
  if (!value) return '';
  const [version, iv, tag, encrypted] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted credential.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { decryptSecret, encryptSecret };
