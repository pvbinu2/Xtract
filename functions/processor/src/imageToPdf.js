const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp',
]);

function isImageDocument(document) {
  const path = require('path');
  const mimeType = String(document.mimeType || '').toLowerCase();
  const fileName = document.originalName || document.fileName || document.storageBlobName || '';
  return mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function imageBufferToPdf(imageBuffer) {
  const metadata = await sharp(imageBuffer, { animated: true, pages: -1 }).metadata();
  const pageCount = Math.max(1, Number(metadata.pages) || 1);
  const pdf = await PDFDocument.create();

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    // Rendering each frame independently preserves all directories/pages in TIFF files.
    const pngBuffer = await sharp(imageBuffer, { page: pageIndex })
      .rotate()
      .png()
      .toBuffer();
    const png = await pdf.embedPng(pngBuffer);
    const page = pdf.addPage([png.width, png.height]);
    page.drawImage(png, {
      x: 0,
      y: 0,
      width: png.width,
      height: png.height,
    });
  }

  return Buffer.from(await pdf.save());
}

module.exports = { IMAGE_EXTENSIONS, imageBufferToPdf, isImageDocument };
