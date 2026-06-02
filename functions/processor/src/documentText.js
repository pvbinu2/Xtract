const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
let pdfjsPromise;

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
      module.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
      return module;
    });
  }
  return pdfjsPromise;
}

async function extractPdfText(filePath) {
  const { getDocument } = await loadPdfJs();
  const data = fs.readFileSync(filePath);
  const standardFontDataUrl = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const pdf = await getDocument({ data: new Uint8Array(data), disableWorker: true, standardFontDataUrl }).promise;
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .filter((item) => 'str' in item)
      .map((item) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) pages.push(text);
  }

  return pages.join('\n');
}

async function ocrPdfText(filePath) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xtract-ocr-'));
  try {
    const prefix = path.join(tempDir, 'page');
    await execFileAsync('pdftoppm', ['-r', process.env.OCR_DPI || '200', '-png', filePath, prefix], {
      timeout: Number(process.env.OCR_RENDER_TIMEOUT_MS || 120000),
    });

    const images = (await fs.promises.readdir(tempDir))
      .filter((file) => file.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const pages = [];
    for (const image of images) {
      const { stdout } = await execFileAsync('tesseract', [path.join(tempDir, image), 'stdout', '-l', process.env.OCR_LANGUAGE || 'eng'], {
        timeout: Number(process.env.OCR_PAGE_TIMEOUT_MS || 120000),
      });
      const text = stdout.replace(/\s+/g, ' ').trim();
      if (text) pages.push(text);
    }

    return pages.join('\n');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function extractDocumentText(filePath, limit = Number(process.env.DOCUMENT_TEXT_LIMIT || 60000)) {
  const minTextLength = Number(process.env.OCR_MIN_TEXT_LENGTH || 80);
  const embeddedText = await extractPdfText(filePath);
  const text = embeddedText.trim().length >= minTextLength ? embeddedText : await ocrPdfText(filePath);
  return text.replace(/\s+\n/g, '\n').trim().slice(0, limit);
}

module.exports = {
  extractDocumentText,
  extractPdfText,
};
