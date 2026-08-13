const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { isExcelDocument, parseWorkbook } = require('./workbook');

test('parses visible workbook cells and cached values', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name', 'Amount'], ['Widget', 12]]), 'Data');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Secret']]), 'Hidden');
  workbook.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
  const parsed = parseWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(parsed.artifact.sheets.length, 1);
  assert.equal(parsed.artifact.sheets[0].cells[3].value, '12');
  assert.match(parsed.text, /\[Sheet: Data\]/);
  assert.doesNotMatch(parsed.text, /Secret/);
});

test('recognizes only xls and xlsx', () => {
  assert.equal(isExcelDocument({ originalName: 'book.xlsx' }), true);
  assert.equal(isExcelDocument({ originalName: 'book.xls' }), true);
  assert.equal(isExcelDocument({ originalName: 'book.csv' }), false);
});

test('parses a legacy xls workbook', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Legacy', 42]]), 'Sheet1');
  const parsed = parseWorkbook(XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }));
  assert.equal(parsed.artifact.sheets[0].cells[1].value, '42');
});
