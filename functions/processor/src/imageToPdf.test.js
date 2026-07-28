const assert = require('node:assert/strict');
const test = require('node:test');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { imageBufferToPdf, isImageDocument } = require('./imageToPdf');

test('converts a PNG into a one-page PDF', async () => {
  const image = await sharp({
    create: { width: 24, height: 32, channels: 3, background: 'white' },
  }).png().toBuffer();

  const pdf = await PDFDocument.load(await imageBufferToPdf(image));

  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 24, height: 32 });
});

test('converts every page of a multipage TIFF into a PDF page', async () => {
  const tiff = await sharp({
    create: {
      width: 40,
      height: 50,
      pageHeight: 25,
      channels: 3,
      background: 'blue',
    },
  }).tiff().toBuffer();

  const pdf = await PDFDocument.load(await imageBufferToPdf(tiff));

  assert.equal(pdf.getPageCount(), 2);
  assert.deepEqual(pdf.getPages().map((page) => page.getSize()), [
    { width: 40, height: 25 },
    { width: 40, height: 25 },
  ]);
});

test('recognizes images without changing their display metadata', () => {
  assert.equal(isImageDocument({ originalName: 'scan.TIFF' }), true);
  assert.equal(isImageDocument({ originalName: 'photo.bin', mimeType: 'image/jpeg' }), true);
  assert.equal(isImageDocument({ originalName: 'invoice.pdf', mimeType: 'application/pdf' }), false);
});
