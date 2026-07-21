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

function parseTesseractTsv(tsv, page, pageWidth, pageHeight) {
  return tsv.split(/\r?\n/).slice(1).flatMap((row) => {
    const columns = row.split('\t');
    if (columns.length < 12 || columns[0] !== '5') return [];
    const text = columns.slice(11).join('\t').trim();
    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    if (!text || ![left, top, width, height].every(Number.isFinite)) return [];
    return [{
      text,
      page,
      x: left / pageWidth,
      y: top / pageHeight,
      width: width / pageWidth,
      height: height / pageHeight,
      lineKey: `${page}:${columns[2]}:${columns[3]}:${columns[4]}`,
    }];
  });
}

async function ocrPdfContent(filePath) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xtract-ocr-'));
  try {
    const dpi = Number(process.env.OCR_DPI || 200);
    const prefix = path.join(tempDir, 'page');
    await execFileAsync('pdftoppm', ['-r', String(dpi), '-png', filePath, prefix], {
      timeout: Number(process.env.OCR_RENDER_TIMEOUT_MS || 120000),
    });

    const images = (await fs.promises.readdir(tempDir))
      .filter((file) => file.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const { getDocument } = await loadPdfJs();
    const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(filePath)), disableWorker: true }).promise;
    const pages = [];
    const spatialItems = [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const pdfPage = await pdf.getPage(index + 1);
      const viewport = pdfPage.getViewport({ scale: dpi / 72 });
      const { stdout } = await execFileAsync('tesseract', [path.join(tempDir, image), 'stdout', '-l', process.env.OCR_LANGUAGE || 'eng', 'tsv'], {
        timeout: Number(process.env.OCR_PAGE_TIMEOUT_MS || 120000),
        maxBuffer: Number(process.env.OCR_MAX_BUFFER_BYTES || 20 * 1024 * 1024),
      });
      const words = parseTesseractTsv(stdout, index, viewport.width, viewport.height);
      const text = words.map((word) => word.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text) pages.push(text);
      spatialItems.push(...words);
    }

    return { text: pages.join('\n'), spatialItems };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function extractMarkdownContent(filePath, options = {}) {
  const serviceUrl = options.markdownServiceUrl || process.env.DOCLING_MARKDOWN_SERVICE_URL || '';
  if (!serviceUrl.trim()) {
    throw new Error('Markdown extraction selected but no Docling markdown service URL is configured.');
  }

  const response = await fetch(serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: options.fileName || path.basename(filePath),
      fileBase64: fs.readFileSync(filePath).toString('base64'),
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Docling markdown extraction failed: ${message || response.statusText}`);
  }

  const payload = await response.json();
  const markdown = typeof payload.markdown === 'string' ? payload.markdown : payload.text;
  if (typeof markdown !== 'string') {
    throw new Error('Docling markdown extraction response did not include markdown text.');
  }

  return {
    text: markdown,
    spatialItems: Array.isArray(payload.elements) ? payload.elements.filter((item) => (
      typeof item?.text === 'string' &&
      [item.page, item.x, item.y, item.width, item.height].every(Number.isFinite)
    )) : [],
  };
}

async function extractDocumentContent(filePath, limit = Number(process.env.DOCUMENT_TEXT_LIMIT || 60000), options = {}) {
  if (options.mode === 'markdown') {
    const content = await extractMarkdownContent(filePath, options);
    return { ...content, text: content.text.replace(/\s+\n/g, '\n').trim().slice(0, limit) };
  }

  const minTextLength = Number(process.env.OCR_MIN_TEXT_LENGTH || 80);
  const embeddedText = await extractPdfText(filePath);
  if (embeddedText.trim().length >= minTextLength) {
    return { text: embeddedText.replace(/\s+\n/g, '\n').trim().slice(0, limit), spatialItems: [] };
  }
  const content = await ocrPdfContent(filePath);
  return { ...content, text: content.text.replace(/\s+\n/g, '\n').trim().slice(0, limit) };
}

async function extractDocumentText(filePath, limit = Number(process.env.DOCUMENT_TEXT_LIMIT || 60000), options = {}) {
  return (await extractDocumentContent(filePath, limit, options)).text;
}

async function extractDocumentSpatialItems(filePath) {
  const minTextLength = Number(process.env.OCR_MIN_TEXT_LENGTH || 80);
  const embeddedText = await extractPdfText(filePath);
  if (embeddedText.trim().length >= minTextLength) return [];
  return (await ocrPdfContent(filePath)).spatialItems;
}

module.exports = {
  extractDocumentContent,
  extractDocumentSpatialItems,
  extractDocumentText,
  extractPdfText,
};
