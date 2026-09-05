import { decode } from 'iconv-lite';
import { read as readWorkbook, utils as xlsxUtils } from 'xlsx';

import { ManualPriceInput } from './manual-prices.service';

/**
 * Reads the price list a supplier actually sends.
 *
 * The local warehouse with no website emails an Excel sheet, or a CSV
 * exported from whatever they run, once a quarter. It arrives with Bulgarian
 * headers or none, prices written "1 234,56" or "1.42 лв", the article code
 * in column A or column D, and — often enough to matter — in windows-1251,
 * which turns into mojibake the moment it is read as UTF-8. Asking the buyer
 * to reshape it into JSON is asking them not to use the feature.
 *
 * So the file is taken as it is. Columns are found by their headers where
 * there are headers, and by what is in them where there are not: the column
 * that is mostly numbers is the price, the one with the longest text is the
 * name. Every guess is reported back in {@link ParsedPriceList.columns} so
 * the buyer sees what was read before anything is written.
 */

export interface ColumnGuess {
  /** Zero-based column in the sheet. */
  index: number;
  /** The header text, when the sheet had one. */
  header: string | null;
  /** Whether it was read from the header or inferred from the values. */
  by: 'header' | 'values';
}

export interface ParsedPriceList {
  rows: ManualPriceInput[];
  columns: {
    name: ColumnGuess | null;
    price: ColumnGuess | null;
    shopCode: ColumnGuess | null;
    unit: ColumnGuess | null;
  };
  /** Rows in the file that did not yield an article, and why, first few. */
  skipped: number;
  problems: string[];
  /** What the sheet looked like, so a wrong reading is easy to spot. */
  encoding: 'utf-8' | 'windows-1251' | 'xlsx';
  delimiter: string | null;
  headerRow: boolean;
  /** Currency the price column declared, if it did — "цена (лв)" → BGN. */
  currency: string | null;
}

/** How each column is recognised by its header, lower-cased, without punctuation. */
const HEADERS: Record<keyof ParsedPriceList['columns'], string[]> = {
  name: [
    'наименование',
    'наименование на артикула',
    'наименование на стоката',
    'артикул',
    'описание',
    'име',
    'стока',
    'продукт',
    'name',
    'product',
    'description',
    'item',
    'title',
  ],
  price: [
    'цена',
    'ед цена',
    'единична цена',
    'цена без ддс',
    'цена с ддс',
    'продажна цена',
    'доставна цена',
    'price',
    'unit price',
    'net price',
  ],
  shopCode: [
    'код',
    'арт №',
    'арт номер',
    'артикул №',
    'артикулен номер',
    'кат №',
    'кат номер',
    'каталожен номер',
    'номер',
    'code',
    'sku',
    'article',
    'art no',
    'item no',
    'ref',
  ],
  unit: ['мярка', 'м е', 'ме', 'мерна единица', 'ед', 'unit', 'uom', 'measure'],
};

const MAX_PROBLEMS = 5;

export function parsePriceList(file: Buffer, filename: string): ParsedPriceList {
  const spreadsheet = /\.xlsx?$|\.xlsm$|\.ods$/i.test(filename) || looksLikeZip(file);

  if (spreadsheet) {
    const workbook = readWorkbook(file, { type: 'buffer', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const grid = sheet
      ? (xlsxUtils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' }) as unknown[][])
      : [];

    return interpret(
      grid.map((row) => row.map((cell) => String(cell ?? '').trim())),
      { encoding: 'xlsx', delimiter: null },
    );
  }

  const encoding = isValidUtf8(file) ? 'utf-8' : 'windows-1251';
  const text = (encoding === 'utf-8' ? file.toString('utf8') : decode(file, 'windows-1251'))
    // A UTF-8 BOM, which Excel writes and which would otherwise become the
    // first character of the first header.
    .replace(/^\uFEFF/, '');

  const delimiter = detectDelimiter(text);

  return interpret(parseCsv(text, delimiter), { encoding, delimiter });
}

/* --- CSV ------------------------------------------------------------- */

/**
 * The separator is whichever of the usual ones is most consistent across the
 * first lines. Bulgarian Excel exports with `;` because the decimal comma
 * takes `,`; everything else exports with `,` or a tab.
 */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 20);
  const candidates = [';', ',', '\t', '|'];

  let best = ';';
  let bestScore = -1;

  for (const candidate of candidates) {
    const counts = lines.map((line) => countOutsideQuotes(line, candidate));
    const present = counts.filter((count) => count > 0);
    if (present.length === 0) continue;

    // Consistency beats raw count: a comma inside every product name is
    // frequent but uneven, a semicolon between every field is exactly the
    // same on every line.
    const mode = present.sort((a, b) => a - b)[Math.floor(present.length / 2)];
    const consistent = counts.filter((count) => count === mode).length;
    const score = consistent * 100 + mode;

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;

  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) count += 1;
  }

  return count;
}

/** RFC 4180, with the lenience real exports need: stray quotes, CRLF, no trailing newline. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell.trim());
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }

  return rows.filter((line) => line.some((value) => value.length > 0));
}

/* --- Reading the grid ------------------------------------------------ */

function interpret(
  grid: string[][],
  shape: { encoding: ParsedPriceList['encoding']; delimiter: string | null },
): ParsedPriceList {
  const empty: ParsedPriceList = {
    rows: [],
    columns: { name: null, price: null, shopCode: null, unit: null },
    skipped: 0,
    problems: [],
    encoding: shape.encoding,
    delimiter: shape.delimiter,
    headerRow: false,
    currency: null,
  };

  if (grid.length === 0) return empty;

  const width = Math.max(...grid.map((row) => row.length));
  const padded = grid.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);

  const headerRow = looksLikeHeader(padded[0]);
  const header = headerRow ? padded[0] : null;
  const body = headerRow ? padded.slice(1) : padded;

  const columns = header ? columnsFromHeader(header) : empty.columns;

  // Whatever the header did not settle is settled by the values.
  const inferred = columnsFromValues(body, columns);

  if (!inferred.name || !inferred.price) {
    return {
      ...empty,
      columns: inferred,
      headerRow,
      skipped: body.length,
      problems: [
        !inferred.price
          ? 'Не намерих колона с цени — нито по заглавие, нито по стойности.'
          : 'Не намерих колона с наименования на артикули.',
      ],
    };
  }

  const currency = header ? currencyFromHeader(header[inferred.price.index]) : null;

  const rows: ManualPriceInput[] = [];
  const problems: string[] = [];
  let skipped = 0;

  for (const [offset, line] of body.entries()) {
    const number = offset + (headerRow ? 2 : 1);
    const name = line[inferred.name.index];
    const price = parseAmount(line[inferred.price.index]);

    if (!name || name.length < 2) {
      skipped += 1;
      if (problems.length < MAX_PROBLEMS) problems.push(`ред ${number}: няма наименование`);
      continue;
    }

    if (price === null) {
      skipped += 1;
      if (problems.length < MAX_PROBLEMS) {
        problems.push(
          `ред ${number} („${name.slice(0, 40)}"): не разчитам цена от „${line[inferred.price.index]}"`,
        );
      }
      continue;
    }

    const shopCode = inferred.shopCode ? line[inferred.shopCode.index] || null : null;
    const unit = inferred.unit ? line[inferred.unit.index] || null : null;

    rows.push({
      name: name.slice(0, 300),
      price,
      shopCode: shopCode ? shopCode.slice(0, 120) : null,
      unit: unit ? unit.slice(0, 32) : null,
      ...(currency ? { currency } : {}),
    });
  }

  return {
    rows,
    columns: inferred,
    skipped,
    problems,
    encoding: shape.encoding,
    delimiter: shape.delimiter,
    headerRow,
    currency,
  };
}

/** A header is a row of short words with no price in it. */
function looksLikeHeader(row: string[]): boolean {
  const filled = row.filter((cell) => cell.length > 0);
  if (filled.length < 2) return false;

  const numeric = filled.filter((cell) => parseAmount(cell) !== null).length;
  const known = filled.filter((cell) => headerRole(cell) !== null).length;

  return numeric === 0 && (known > 0 || filled.every((cell) => cell.length <= 40));
}

function headerRole(cell: string): keyof ParsedPriceList['columns'] | null {
  const key = normaliseHeader(cell);
  if (!key) return null;

  for (const role of Object.keys(HEADERS) as Array<keyof ParsedPriceList['columns']>) {
    if (HEADERS[role].some((label) => key === label || key.startsWith(`${label} `))) return role;
  }

  return null;
}

function normaliseHeader(cell: string): string {
  return cell
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-zа-я0-9№ ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function columnsFromHeader(header: string[]): ParsedPriceList['columns'] {
  const columns: ParsedPriceList['columns'] = { name: null, price: null, shopCode: null, unit: null };

  header.forEach((cell, index) => {
    const role = headerRole(cell);
    // The first column that claims a role keeps it: "цена без ДДС" before
    // "цена с ДДС" is the usual order, and the net figure is the one the
    // comparison wants.
    if (role && !columns[role]) columns[role] = { index, header: cell, by: 'header' };
  });

  return columns;
}

/**
 * Fills whichever roles the header left open from what the columns hold.
 *
 * Price is the column where most cells parse as an amount. Name is the
 * column with the longest text on average, among those that are not mostly
 * numbers. Code is a short, mostly alphanumeric column that is neither. Unit
 * is left alone: guessing it wrong is worse than leaving it blank.
 */
function columnsFromValues(
  body: string[][],
  known: ParsedPriceList['columns'],
): ParsedPriceList['columns'] {
  const columns = { ...known };
  const width = body[0]?.length ?? 0;
  const taken = new Set(
    Object.values(columns)
      .filter((guess): guess is ColumnGuess => guess !== null)
      .map((guess) => guess.index),
  );

  const sample = body.slice(0, 200);

  const stats = Array.from({ length: width }, (_, index) => {
    const cells = sample.map((row) => row[index] ?? '').filter((cell) => cell.length > 0);
    const numeric = cells.filter((cell) => parseAmount(cell) !== null).length;
    const averageLength = cells.reduce((sum, cell) => sum + cell.length, 0) / (cells.length || 1);
    const codeLike = cells.filter((cell) => /^[A-Za-z0-9./-]{2,24}$/.test(cell)).length;

    return { index, filled: cells.length, numeric, averageLength, codeLike };
  });

  if (!columns.price) {
    const best = stats
      .filter((s) => !taken.has(s.index) && s.filled > 0 && s.numeric / s.filled >= 0.8)
      // Among number columns, the one furthest right: quantity and code
      // columns sit left of the price on nearly every list.
      .sort((a, b) => b.numeric / b.filled - a.numeric / a.filled || b.index - a.index)[0];

    if (best) {
      columns.price = { index: best.index, header: null, by: 'values' };
      taken.add(best.index);
    }
  }

  if (!columns.name) {
    const best = stats
      .filter((s) => !taken.has(s.index) && s.filled > 0 && s.numeric / s.filled < 0.5)
      .sort((a, b) => b.averageLength - a.averageLength)[0];

    if (best) {
      columns.name = { index: best.index, header: null, by: 'values' };
      taken.add(best.index);
    }
  }

  if (!columns.shopCode) {
    const best = stats
      .filter(
        (s) =>
          !taken.has(s.index) &&
          s.filled > 0 &&
          s.codeLike / s.filled >= 0.8 &&
          s.numeric / s.filled < 0.8 &&
          s.averageLength <= 24,
      )
      .sort((a, b) => a.index - b.index)[0];

    if (best) {
      columns.shopCode = { index: best.index, header: null, by: 'values' };
      taken.add(best.index);
    }
  }

  return columns;
}

/* --- Values ----------------------------------------------------------- */

/**
 * A price as a person wrote it: "1 234,56", "1,234.56", "1.42 лв", "€ 3,20",
 * "12". Both decimal conventions are accepted; the last separator wins the
 * role of decimal point when it is followed by exactly two digits.
 */
export function parseAmount(raw: string): number | null {
  if (!raw) return null;

  const cleaned = raw
    .replace(/[€$£]|лв\.?|eur|bgn|usd|ron/gi, '')
    .replace(/\u00a0/g, ' ')
    .trim();

  if (!/^[-+]?[\d\s.,]+$/.test(cleaned) || !/\d/.test(cleaned)) return null;

  let compact = cleaned.replace(/\s+/g, '');

  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  const last = Math.max(lastComma, lastDot);

  if (last >= 0) {
    const decimals = compact.length - last - 1;
    const separator = compact[last];
    const other = separator === ',' ? '.' : ',';

    if (decimals === 1 || decimals === 2) {
      compact = compact.split(other).join('').replace(separator, '.');
    } else if (decimals === 3 && compact.includes(other)) {
      // "1.234,567" is nonsense; "1,234.567" three decimals is rare but valid.
      compact = compact.split(other).join('').replace(separator, '.');
    } else {
      // "1.234" or "1,234" on their own: a thousands group, not a decimal.
      compact = compact.replace(/[.,]/g, '');
    }
  }

  const value = Number(compact);
  if (!Number.isFinite(value) || value < 0) return null;

  return Math.round(value * 100) / 100;
}

function currencyFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const lower = header.toLowerCase();
  if (/€|eur/.test(lower)) return 'EUR';
  if (/лв|bgn/.test(lower)) return 'BGN';
  if (/ron|lei/.test(lower)) return 'RON';
  return null;
}

function looksLikeZip(file: Buffer): boolean {
  return file.length > 4 && file[0] === 0x50 && file[1] === 0x4b && file[2] === 0x03;
}

function isValidUtf8(body: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}
