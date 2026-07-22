import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { OcrService } from '@xtract/common';

const execFileAsync = promisify(execFile);
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

export type DocumentTextMode = 'ocr' | 'markdown';
export type DocumentTextOptions = {
  mode?: DocumentTextMode;
  markdownServiceUrl?: string;
  fileName?: string;
};

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
      module.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/build/pdf.worker.mjs');
      return module;
    });
  }
  return pdfjsPromise;
}

async function extractPdfText(filePath: string) {
  const { getDocument } = await loadPdfJs();
  const data = await readFile(filePath);
  const standardFontDataUrl = join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + sep;
  const pdf = await getDocument({ data: new Uint8Array(data), disableWorker: true, standardFontDataUrl } as unknown as Parameters<typeof getDocument>[0]).promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .filter((item) => 'str' in item)
      .map((item) => (item as { str: string }).str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) pages.push(text);
  }

  return pages.join('\n');
}

async function ocrPdfText(filePath: string) {
  const tempDir = await mkdtemp(join(tmpdir(), 'xtract-ocr-'));
  try {
    const prefix = join(tempDir, 'page');
    const dpi = process.env.OCR_DPI || '200';
    await execFileAsync('pdftoppm', ['-r', dpi, '-png', filePath, prefix], {
      timeout: Number(process.env.OCR_RENDER_TIMEOUT_MS || 120000),
    });

    const images = (await readdir(tempDir))
      .filter((file) => file.endsWith('.png'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const pages: string[] = [];
    for (const image of images) {
      const { stdout } = await execFileAsync('tesseract', [join(tempDir, image), 'stdout', '-l', process.env.OCR_LANGUAGE || 'eng'], {
        timeout: Number(process.env.OCR_PAGE_TIMEOUT_MS || 120000),
      });
      const text = stdout.replace(/\s+/g, ' ').trim();
      if (text) pages.push(text);
    }

    return pages.join('\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function extractMarkdownText(filePath: string, options: DocumentTextOptions = {}) {
  const serviceUrl = options.markdownServiceUrl || process.env.DOCLING_MARKDOWN_SERVICE_URL || '';
  if (!serviceUrl.trim()) {
    throw new Error('Markdown extraction selected but no Docling markdown service URL is configured.');
  }

  const fileBuffer = await readFile(filePath);
  const response = await fetch(serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: options.fileName || filePath.split(/[\\/]/).pop() || 'document.pdf',
      fileBase64: fileBuffer.toString('base64'),
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Docling markdown extraction failed: ${message || response.statusText}`);
  }

  const payload = await response.json() as { markdown?: unknown; text?: unknown };
  const markdown = typeof payload.markdown === 'string' ? payload.markdown : payload.text;
  if (typeof markdown !== 'string') {
    throw new Error('Docling markdown extraction response did not include markdown text.');
  }

  return markdown;
}

export async function extractDocumentText(
  filePath: string,
  limit = Number(process.env.DOCUMENT_TEXT_LIMIT || 60000),
  options: DocumentTextOptions = {},
) {
  return documentTextService.extractText(filePath, limit, options);
}

const documentTextService = new OcrService({
  extractEmbeddedText: extractPdfText,
  extractOcrContent: async (filePath) => ({ text: await ocrPdfText(filePath), spatialItems: [] }),
  extractMarkdownContent: async (filePath, options) => ({
    text: await extractMarkdownText(filePath, options as DocumentTextOptions),
    spatialItems: [],
  }),
});
