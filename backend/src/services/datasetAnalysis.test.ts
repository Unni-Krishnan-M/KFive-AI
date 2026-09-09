import {
  DATASET_LIMITS,
  DatasetInputError,
  analyzeDataset,
  deriveDataset,
  parseDataset,
} from './datasetAnalysis';

describe('dataset analysis', () => {
  it('parses strict UTF-8 CSV with BOM, quoted commas, quotes, and line breaks', () => {
    const parsed = parseDataset(Buffer.from('\ufeffname,note,score\r\nAda,"hello, ""world""",10\r\nLinus,"two\nlines",20\r\n'), 'csv');
    expect(parsed).toEqual({
      format: 'csv',
      columns: ['name', 'note', 'score'],
      rows: [['Ada', 'hello, "world"', '10'], ['Linus', 'two\nlines', '20']],
    });
  });

  it('rejects malformed, ragged, binary, duplicate-header, and oversized CSV input', () => {
    const invalid = [
      Buffer.from('a,b\n1\n'),
      Buffer.from('a,a\n1,2\n'),
      Buffer.from('e\u0301,é\n1,2\n'),
      Buffer.from('a\n"unterminated\n'),
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.from('a\nvalue\0hidden\n'),
      Buffer.from(`a\n${'x'.repeat(DATASET_LIMITS.cellBytes + 1)}\n`),
      Buffer.from(`a\n${'€'.repeat(Math.floor(DATASET_LIMITS.cellBytes / 3) + 1)}\n`),
    ];
    for (const buffer of invalid) expect(() => parseDataset(buffer, 'csv')).toThrow(DatasetInputError);
  });

  it('enforces the CSV row and column limits while parsing', () => {
    const tooManyRows = Buffer.from(`a\n${Array.from({ length: DATASET_LIMITS.rows + 1 }, () => '1').join('\n')}\n`);
    expect(() => parseDataset(tooManyRows, 'csv')).toThrow(expect.objectContaining({ code: 'DATASET_LIMIT_EXCEEDED', statusCode: 413 }));
    const tooManyColumns = Buffer.from(`${Array.from({ length: DATASET_LIMITS.columns + 1 }, (_, index) => `c${index}`).join(',')}\n`);
    expect(() => parseDataset(tooManyColumns, 'csv')).toThrow(expect.objectContaining({ code: 'DATASET_LIMIT_EXCEEDED', statusCode: 413 }));
  });

  it('allows the trusted stored-derived byte ceiling without relaxing upload parsing by default', () => {
    const overUpload = Buffer.alloc(DATASET_LIMITS.uploadBytes + 1, 0x20);
    expect(() => parseDataset(overUpload, 'csv')).toThrow(expect.objectContaining({ code: 'DATASET_TOO_LARGE', statusCode: 413 }));
    expect(() => parseDataset(overUpload, 'csv', DATASET_LIMITS.derivedBytes))
      .toThrow(expect.not.objectContaining({ code: 'DATASET_TOO_LARGE' }));
    expect(() => parseDataset(Buffer.from('a\n1\n'), 'csv', DATASET_LIMITS.derivedBytes + 1))
      .toThrow(expect.objectContaining({ code: 'INVALID_DATASET_FILE', statusCode: 400 }));
  });

  it('parses only non-empty arrays of flat JSON objects with an exact safe schema', () => {
    expect(parseDataset(Buffer.from(JSON.stringify([
      { name: 'Ada', score: 10, active: true, note: null },
      { name: 'Linus', score: 20, active: false, note: '' },
    ])), 'json')).toMatchObject({
      format: 'json', columns: ['name', 'score', 'active', 'note'],
      rows: [['Ada', 10, true, null], ['Linus', 20, false, '']],
    });

    const invalid = [
      {}, [], [{ a: { nested: true } }], [{ a: 1 }, { b: 2 }],
      JSON.parse('[{"__proto__":"unsafe"}]'),
      [{ ' name ': 'Ada' }],
      [{ 'e\u0301': 1 }],
    ];
    for (const value of invalid) expect(() => parseDataset(Buffer.from(JSON.stringify(value)), 'json')).toThrow(DatasetInputError);
  });

  it('returns deterministic bounded quality, type, numeric, category, outlier, and correlation analysis', () => {
    const parsed = parseDataset(Buffer.from([
      'name,age,score,active',
      'Ada,30,10,true',
      'Bob,40,20,false',
      'Bob,40,20,false',
      'Cara,,100,true',
    ].join('\n')), 'csv');
    const analysis = analyzeDataset(parsed);
    expect(analysis).toMatchObject({
      schemaVersion: 1,
      rowCount: 4,
      columnCount: 4,
      duplicateRowCount: 1,
      missingCellCount: 1,
    });
    expect(analysis.columns.find((column) => column.name === 'age')).toMatchObject({
      inferredType: 'integer', missingCount: 1, nonMissingCount: 3, uniqueCount: 2,
      numeric: { min: 30, max: 40 },
    });
    expect(analysis.columns.find((column) => column.name === 'active')).toMatchObject({ inferredType: 'boolean' });
    expect(analysis.correlations).toEqual(expect.arrayContaining([
      expect.objectContaining({ left: 'age', right: 'score', pairedRows: 3 }),
    ]));
    expect(analysis.preview).toHaveLength(4);
    expect(analysis.suggestions.join(' ')).toMatch(/missing.*duplicate/i);
  });

  it('bounds preview cell content independently from accepted cell content', () => {
    const long = 'x'.repeat(DATASET_LIMITS.previewCellCharacters + 10);
    const analysis = analyzeDataset(parseDataset(Buffer.from(`text\n${long}\n`), 'csv'));
    expect(analysis.preview[0].text).toHaveLength(DATASET_LIMITS.previewCellCharacters);
    expect(analysis.previewTruncatedCellCount).toBe(1);
  });

  it('keeps statistics and correlations finite for extreme finite values', () => {
    const analysis = analyzeDataset(parseDataset(Buffer.from(JSON.stringify([
      { x: -1e308, y: 1e308 },
      { x: 1e308, y: -1e308 },
    ])), 'json'));
    const x = analysis.columns.find((column) => column.name === 'x');
    expect(Number.isFinite(x?.numeric?.mean)).toBe(true);
    expect(Number.isFinite(x?.numeric?.standardDeviation)).toBe(true);
    expect(Number.isFinite(analysis.correlations[0].coefficient)).toBe(true);
  });

  it('creates a new cleaned representation without mutating the parsed source', () => {
    const original = parseDataset(Buffer.from('name,value\n Ada ,=2+3\n Ada ,=2+3\nBob,\n'), 'csv');
    const before = JSON.stringify(original);
    const derived = deriveDataset(original, {
      trimStrings: true,
      dropDuplicateRows: true,
      dropRowsWithMissingValues: true,
      escapeSpreadsheetFormulas: true,
    });
    expect(JSON.stringify(original)).toBe(before);
    expect(derived.parsed.rows).toEqual([['Ada', "'=2+3"]]);
    expect(derived.buffer.toString()).toBe("name,value\nAda,'=2+3\n");
  });

  it('keeps derived CSV analysis identical to the stored formula-safe representation', () => {
    const original = parseDataset(Buffer.from('=label,value\nrow,+SUM(A1)\n'), 'csv');
    const escaped = deriveDataset(original, {
      trimStrings: false,
      dropDuplicateRows: false,
      dropRowsWithMissingValues: false,
      escapeSpreadsheetFormulas: true,
    });
    expect(escaped.parsed.columns).toEqual(["'=label", 'value']);
    expect(escaped.parsed.rows).toEqual([['row', "'+SUM(A1)"]]);
    expect(parseDataset(escaped.buffer, 'csv')).toEqual(escaped.parsed);

    const unchanged = deriveDataset(original, {
      trimStrings: true,
      dropDuplicateRows: false,
      dropRowsWithMissingValues: false,
      escapeSpreadsheetFormulas: false,
    });
    expect(parseDataset(unchanged.buffer, 'csv')).toEqual(unchanged.parsed);
  });

  it('returns a stable input error when formula escaping would collapse headers', () => {
    const source = parseDataset(Buffer.from("=name,'=name\nfirst,second\n"), 'csv');
    expect(() => deriveDataset(source, {
      trimStrings: false,
      dropDuplicateRows: false,
      dropRowsWithMissingValues: false,
      escapeSpreadsheetFormulas: true,
    })).toThrow(expect.objectContaining({ code: 'INVALID_DATASET_FILE', statusCode: 400 }));
  });

  it('preserves JSON scalar types when deriving a JSON dataset', () => {
    const original = parseDataset(Buffer.from('[{"name":" Ada ","score":1,"active":true,"note":null}]'), 'json');
    const derived = deriveDataset(original, {
      trimStrings: true,
      dropDuplicateRows: false,
      dropRowsWithMissingValues: false,
      escapeSpreadsheetFormulas: true,
    });
    expect(JSON.parse(derived.buffer.toString())).toEqual([{ name: 'Ada', score: 1, active: true, note: null }]);
  });
});
