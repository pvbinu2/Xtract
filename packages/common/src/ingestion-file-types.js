const path = require('path');

const DEFAULT_INGESTION_FILE_TYPES = [
  { extensions: ['.pdf'], label: 'PDF', mimeTypes: ['application/pdf'], enabled: true },
  { extensions: ['.xlsx'], label: 'Excel', mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], enabled: true },
  { extensions: ['.xls'], label: 'Excel (legacy)', mimeTypes: ['application/vnd.ms-excel'], enabled: true },
  { extensions: ['.png'], label: 'PNG', mimeTypes: ['image/png'], enabled: true },
  { extensions: ['.jpg', '.jpeg'], label: 'JPEG', mimeTypes: ['image/jpeg'], enabled: true },
  { extensions: ['.tif', '.tiff'], label: 'TIFF', mimeTypes: ['image/tiff'], enabled: true },
  { extensions: ['.webp'], label: 'WebP', mimeTypes: ['image/webp'], enabled: true },
  { extensions: ['.bmp'], label: 'Bitmap', mimeTypes: ['image/bmp'], enabled: true },
  { extensions: ['.gif'], label: 'GIF', mimeTypes: ['image/gif'], enabled: true },
  { extensions: ['.avif'], label: 'AVIF', mimeTypes: ['image/avif'], enabled: true },
  { extensions: ['.heic'], label: 'HEIC', mimeTypes: ['image/heic'], enabled: true },
  { extensions: ['.heif'], label: 'HEIF', mimeTypes: ['image/heif'], enabled: true },
  { extensions: ['.svg'], label: 'SVG', mimeTypes: ['image/svg+xml'], enabled: true },
];

function normalizeIngestionFileTypes(value) {
  const configured = Array.isArray(value) ? value : [];
  return DEFAULT_INGESTION_FILE_TYPES.map((definition) => {
    const match = configured.find((item) => Array.isArray(item?.extensions)
      && item.extensions.some((extension) => definition.extensions.includes(String(extension).toLowerCase())));
    return { ...definition, extensions: [...definition.extensions], mimeTypes: [...definition.mimeTypes], enabled: match?.enabled ?? definition.enabled };
  });
}

function ingestionFileSupport(fileName, mimeType, configuredTypes) {
  const extension = path.extname(fileName || '').toLowerCase();
  const normalizedMimeType = String(mimeType || '').toLowerCase();
  const types = normalizeIngestionFileTypes(configuredTypes);
  const matched = types.find((item) => item.enabled && item.extensions.includes(extension)
    && item.mimeTypes.includes(normalizedMimeType));
  return {
    supported: Boolean(matched), extension, mimeType: normalizedMimeType,
    message: `File format ${extension || '(none)'}${normalizedMimeType ? ` (${normalizedMimeType})` : ''} is not enabled for processing.`,
  };
}

module.exports = { DEFAULT_INGESTION_FILE_TYPES, ingestionFileSupport, normalizeIngestionFileTypes };
