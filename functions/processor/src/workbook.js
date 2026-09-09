const path = require('path');
const XLSX = require('xlsx');

const EXCEL_EXTENSIONS = new Set(['.xls', '.xlsx']);

function isExcelDocument(document) {
  return EXCEL_EXTENSIONS.has(path.extname(document.originalName || document.fileName || '').toLowerCase());
}

function cellDisplayValue(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (cell.f && cell.v === undefined) return '';
  return cell.w !== undefined ? String(cell.w) : String(cell.v);
}

function parseWorkbook(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, cellHTML: false, cellNF: false });
  } catch (error) {
    throw new Error(`Workbook is corrupt, password-protected, or unreadable: ${error?.message || String(error)}`);
  }
  const visibility = workbook.Workbook?.Sheets || [];
  const sheets = workbook.SheetNames.flatMap((name, workbookIndex) => {
    if (visibility[workbookIndex]?.Hidden) return [];
    const sheet = workbook.Sheets[name];
    const range = sheet?.['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
    const cells = [];
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address];
        const value = cellDisplayValue(cell);
        if (!value) continue;
        cells.push({ address, row, column, value, type: cell?.t || 's' });
      }
    }
    return [{
      index: workbookIndex,
      name,
      rowCount: Math.max(0, range.e.r + 1),
      columnCount: Math.max(0, range.e.c + 1),
      merges: (sheet?.['!merges'] || []).map((merge) => XLSX.utils.encode_range(merge)),
      cells,
    }];
  });
  const text = sheets.map((sheet) => {
    const rows = new Map();
    sheet.cells.forEach((cell) => {
      if (!rows.has(cell.row)) rows.set(cell.row, []);
      rows.get(cell.row)[cell.column] = cell.value;
    });
    return [`[Sheet: ${sheet.name}]`, ...[...rows.values()].map((row) => row.map((value) => value || '').join('\t'))].join('\n');
  }).join('\n\n');
  return { artifact: { version: 1, sheets }, text };
}

module.exports = { isExcelDocument, parseWorkbook };
