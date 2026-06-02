import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, sep } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

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

export async function extractDocumentText(filePath: string, limit = Number(process.env.DOCUMENT_TEXT_LIMIT || 60000)) {
  const minTextLength = Number(process.env.OCR_MIN_TEXT_LENGTH || 80);
  const embeddedText = await extractPdfText(filePath);
  const text = embeddedText.trim().length >= minTextLength ? embeddedText : await ocrPdfText(filePath);
  return text.replace(/\s+\n/g, '\n').trim().slice(0, limit);
}
