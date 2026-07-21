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
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().replace(/,/g, '');
}

function normalizeSpatialText(value) {
  return normalizeText(String(value || '')).replace(/[^\p{L}\p{N}]/gu, '');
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

function scalarValues(value) {
  if (value === null || value === undefined || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (typeof value === 'object') return Object.values(value).flatMap(scalarValues);
  return [value];
}

function enclosingBox(boxes) {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { page: boxes[0].page, x: left, y: top, width: right - left, height: bottom - top };
}

function mergeMatchedBoxes(items) {
  const groups = [];
  for (const item of items) {
    const last = groups.at(-1);
    const sameLine = last && last.page === item.page && (
      (item.lineKey && last.lineKey === item.lineKey) ||
      (!item.lineKey && Math.abs(last.y - item.y) <= Math.max(last.height, item.height) * 0.5)
    );
    if (sameLine) {
      last.items.push(item);
    } else {
      groups.push({ page: item.page, y: item.y, height: item.height, lineKey: item.lineKey, items: [item] });
    }
  }
  return groups.map((group) => enclosingBox(group.items));
}

function findSpatialMatch(value, items) {
  // OCR commonly inserts/removes spaces and punctuation (for example
  // "BINUPV" vs "BINU PV" or "KL-36" vs "KL 36"). Compare a compact
  // Unicode alphanumeric form while retaining the original word boxes.
  const target = normalizeSpatialText(value);
  if (!target) return [];

  const direct = items.find((item) => {
    const text = normalizeSpatialText(item.text);
    return text === target || (target.length >= 3 && text.includes(target));
  });
  if (direct) return [enclosingBox([direct])];

  for (let start = 0; start < items.length; start += 1) {
    if (items[start].page === undefined) continue;
    const matched = [];
    let combined = '';
    for (let end = start; end < Math.min(items.length, start + 30); end += 1) {
      const item = items[end];
      if (item.page !== items[start].page) break;
      combined += normalizeSpatialText(item.text);
      matched.push(item);
      if (combined === target) return mergeMatchedBoxes(matched);
      if (combined.length > target.length + 20 || !target.startsWith(combined)) break;
    }
  }
  return [];
}

async function attachBoundingBoxes(filePath, extractedData, spatialItems = []) {
  const fs = require('fs');
  const { getDocument } = await loadPdfJs();
  const data = fs.readFileSync(filePath);
  const standardFontDataUrl = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  const pdf = await getDocument({ data: new Uint8Array(data), disableWorker: true, standardFontDataUrl }).promise;
  const pageMatches = new Map();
  const pdfItems = [];

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
      pdfItems.push({ text, ...box });
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
    const fieldValues = scalarValues(field.value);
    const spatialBoxes = fieldValues.flatMap((value) => {
      const suppliedMatch = findSpatialMatch(value, spatialItems);
      return suppliedMatch.length ? suppliedMatch : findSpatialMatch(value, pdfItems);
    });
    if (spatialBoxes.length) {
      const uniqueBoxes = spatialBoxes.filter((box, index, boxes) => boxes.findIndex((candidate) => (
        candidate.page === box.page && candidate.x === box.x && candidate.y === box.y &&
        candidate.width === box.width && candidate.height === box.height
      )) === index);
      return { ...field, boundingBoxes: uniqueBoxes };
    }
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
