type Box = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type Extracted = {
  key: string;
  label: string;
  type: string;
  value: unknown;
  boundingBoxes?: Box[];
  confidence?: number;
};

let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
      module.GlobalWorkerOptions.workerSrc = '';
      return module;
    });
  }
  return pdfjsPromise;
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function scalarStrings(value: unknown) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value) || typeof value === 'object') return [];
  const raw = String(value).trim();
  if (!raw) return [];
  const variants = new Set([raw, normalizeText(raw)]);
  if (/^[\d,.\-\/]+$/.test(raw)) {
    variants.add(raw.replace(/,/g, ''));
  }
  return Array.from(variants).filter(Boolean);
}

export async function attachBoundingBoxes(
  filePath: string,
  extractedData: Extracted[],
): Promise<Extracted[]> {
  const { readFile } = await import('fs/promises');
  const { getDocument } = await loadPdfJs();
  const data = await readFile(filePath);
  const pdf = await getDocument({ data: new Uint8Array(data), disableWorker: true } as any).promise;
  const pageMatches = new Map<string, Box[]>();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const items = textContent.items.filter((item) => 'str' in item);

    for (const item of items) {
      const text = item.str?.trim();
      if (!text) continue;
      const [a, b, c, d, e, f] = item.transform;
      const height = Math.abs(d) || item.height || 0;
      const width = item.width || Math.abs(a) || 0;
      const x = e / viewport.width;
      const y = 1 - (f + height) / viewport.height;
      const box: Box = {
        page: pageNumber - 1,
        x,
        y,
        width: width / viewport.width,
        height: height / viewport.height,
      };

      const candidates = [text, normalizeText(text), text.replace(/,/g, '')];
      for (const candidate of candidates) {
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
    const boxes: Box[] = [];
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
