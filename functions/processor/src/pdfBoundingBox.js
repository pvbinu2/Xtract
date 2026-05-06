const path = require('path');
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

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function scalarStrings(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value) || typeof value === 'object') return [];
  const raw = String(value).trim();
  if (!raw) return [];
  const variants = new Set([raw, normalizeText(raw)]);
  if (/^[\d,.\-\/]+$/.test(raw)) variants.add(raw.replace(/,/g, ''));
  return Array.from(variants).filter(Boolean);
}

async function attachBoundingBoxes(filePath, extractedData) {
  const fs = require('fs');
  const { getDocument } = await loadPdfJs();
  const data = fs.readFileSync(filePath);
  const standardFontDataUrl = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const pdf = await getDocument({ data: new Uint8Array(data), disableWorker: true, standardFontDataUrl }).promise;
  const pageMatches = new Map();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const items = textContent.items.filter((item) => 'str' in item);

    for (const item of items) {
      const text = item.str?.trim();
      if (!text) continue;
      const [, , , d, e, f] = item.transform;
      const height = Math.abs(d) || item.height || 0;
      const width = item.width || 0;
      const box = {
        page: pageNumber - 1,
        x: e / viewport.width,
        y: 1 - (f + height) / viewport.height,
        width: width / viewport.width,
        height: height / viewport.height,
      };
      for (const candidate of [text, normalizeText(text), text.replace(/,/g, '')]) {
        if (!candidate) continue;
        const key = `${pageNumber - 1}:${candidate}`;
        const matches = pageMatches.get(key) || [];
        matches.push(box);
        pageMatches.set(key, matches);
      }
    }
  }

  return extractedData.map((field) => {
    if (field.type === 'table') return { ...field, boundingBoxes: [] };
    const boxes = [];
    for (const candidate of scalarStrings(field.value)) {
      for (let page = 0; page < pdf.numPages; page += 1) {
        const hit = pageMatches.get(`${page}:${candidate}`);
        if (hit?.length) {
          boxes.push(hit[0]);
          break;
        }
      }
      if (boxes.length) break;
    }
    return { ...field, boundingBoxes: boxes };
  });
}

module.exports = { attachBoundingBoxes };
