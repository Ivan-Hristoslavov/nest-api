import { encode } from 'iconv-lite';
import { utils as xlsxUtils, write as writeWorkbook } from 'xlsx';

import { detectDelimiter, parseAmount, parsePriceList } from './price-list-parser';

/**
 * The lists these suppliers send, as they send them. Each case here was a
 * way a real file could have failed silently: read as the wrong encoding, cut
 * on the wrong separator, or with the price taken from the quantity column.
 */

describe('reading an amount as a person wrote it', () => {
  it.each([
    ['1,42', 1.42],
    ['1.42', 1.42],
    ['1 234,56', 1234.56],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['1.234', 1234],
    ['12', 12],
    ['1,42 лв', 1.42],
    ['1.42 лв.', 1.42],
    ['€ 3,20', 3.2],
    ['3.20 EUR', 3.2],
    ['0', 0],
  ])('%s → %s', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it.each(['', 'н/а', 'по запитване', 'abc', '-'])('refuses "%s"', (raw) => {
    expect(parseAmount(raw)).toBeNull();
  });
});

describe('finding the separator', () => {
  it('prefers the one that is the same on every line', () => {
    // Commas inside names, semicolons between fields.
    const text = 'Код;Наименование;Цена\nA1;Кабел, 3x1.5, черен;1,42\nA2;Лампа, LED;3,20\n';
    expect(detectDelimiter(text)).toBe(';');
  });

  it('reads a comma-separated export', () => {
    expect(detectDelimiter('code,name,price\nA1,Cable,1.42\n')).toBe(',');
  });

  it('reads a tab-separated export', () => {
    expect(detectDelimiter('code\tname\tprice\nA1\tCable\t1.42\n')).toBe('\t');
  });
});

describe('reading a supplier price list', () => {
  const csv = (text: string) => parsePriceList(Buffer.from(text, 'utf8'), 'ceni.csv');

  it('maps columns by their Bulgarian headers', () => {
    const parsed = csv(
      'Арт. №;Наименование на артикула;Мярка;Цена без ДДС (лв);Цена с ДДС\n' +
        'SVT-3X25;КАБЕЛ СВТ 3x2.5;м;1,42;1,70\n' +
        'LED-12;Лампа LED 12W E27;бр;3,20;3,84\n',
    );

    expect(parsed.headerRow).toBe(true);
    expect(parsed.columns.shopCode).toMatchObject({ index: 0, by: 'header' });
    expect(parsed.columns.name).toMatchObject({ index: 1, by: 'header' });
    expect(parsed.columns.unit).toMatchObject({ index: 2, by: 'header' });
    // The net price, not the gross one two columns over.
    expect(parsed.columns.price).toMatchObject({ index: 3, by: 'header' });
    expect(parsed.currency).toBe('BGN');

    expect(parsed.rows).toEqual([
      { name: 'КАБЕЛ СВТ 3x2.5', price: 1.42, shopCode: 'SVT-3X25', unit: 'м', currency: 'BGN' },
      { name: 'Лампа LED 12W E27', price: 3.2, shopCode: 'LED-12', unit: 'бр', currency: 'BGN' },
    ]);
    expect(parsed.skipped).toBe(0);
  });

  it('works out the columns from the values when there is no header', () => {
    const parsed = csv('SVT-3X25;КАБЕЛ СВТ 3x2.5;100;1,42\nLED-12;Лампа LED 12W E27;20;3,20\n');

    expect(parsed.headerRow).toBe(false);
    // The rightmost numeric column is the price; the one before it is a
    // quantity and must not be mistaken for it.
    expect(parsed.columns.price).toMatchObject({ index: 3, by: 'values' });
    expect(parsed.columns.name).toMatchObject({ index: 1, by: 'values' });
    expect(parsed.columns.shopCode).toMatchObject({ index: 0, by: 'values' });
    expect(parsed.rows.map((row) => row.price)).toEqual([1.42, 3.2]);
    expect(parsed.rows[0].currency).toBeUndefined();
  });

  it('decodes windows-1251, which is what half these exports are', () => {
    const text = 'Код;Наименование;Цена\nA1;Кабел СВТ 3x1.5;0,94\n';
    const parsed = parsePriceList(encode(text, 'windows-1251'), 'ceni.csv');

    expect(parsed.encoding).toBe('windows-1251');
    expect(parsed.rows[0].name).toBe('Кабел СВТ 3x1.5');
  });

  it('drops the BOM Excel puts before the first header', () => {
    const parsed = csv('\uFEFFКод;Наименование;Цена\nA1;Кабел;0,94\n');

    expect(parsed.columns.shopCode).toMatchObject({ index: 0, header: 'Код' });
  });

  it('keeps quoted names with the separator inside them', () => {
    const parsed = csv('Наименование;Цена\n"Кабел; черен, 3x1.5";1,42\n');

    expect(parsed.rows[0].name).toBe('Кабел; черен, 3x1.5');
  });

  it('reports the rows it could not read, with the row number', () => {
    const parsed = csv('Наименование;Цена\nКабел СВТ;1,42\n;3,20\nЛампа;по запитване\nВинт;0,05\n');

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.skipped).toBe(2);
    expect(parsed.problems[0]).toContain('ред 3');
    expect(parsed.problems[1]).toContain('ред 4');
    expect(parsed.problems[1]).toContain('по запитване');
  });

  it('says so when there is no price column at all', () => {
    const parsed = csv('Код;Наименование\nA1;Кабел\nA2;Лампа\n');

    expect(parsed.rows).toHaveLength(0);
    expect(parsed.problems[0]).toContain('цени');
  });

  it('reads an Excel workbook', () => {
    const sheet = xlsxUtils.aoa_to_sheet([
      ['Код', 'Наименование', 'Цена (€)'],
      ['A1', 'Кабел СВТ 3x1.5', 0.94],
      ['A2', 'Лампа LED', 3.2],
    ]);
    const workbook = xlsxUtils.book_new();
    xlsxUtils.book_append_sheet(workbook, sheet, 'Ценоразпис');
    const file = writeWorkbook(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const parsed = parsePriceList(file, 'ceni.xlsx');

    expect(parsed.encoding).toBe('xlsx');
    expect(parsed.currency).toBe('EUR');
    expect(parsed.rows).toEqual([
      { name: 'Кабел СВТ 3x1.5', price: 0.94, shopCode: 'A1', unit: null, currency: 'EUR' },
      { name: 'Лампа LED', price: 3.2, shopCode: 'A2', unit: null, currency: 'EUR' },
    ]);
  });

  it('recognises a workbook by its bytes when the name does not say', () => {
    const sheet = xlsxUtils.aoa_to_sheet([
      ['Наименование', 'Цена'],
      ['Кабел', 1.42],
    ]);
    const workbook = xlsxUtils.book_new();
    xlsxUtils.book_append_sheet(workbook, sheet, 'Лист1');
    const file = writeWorkbook(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    expect(parsePriceList(file, 'attachment').rows).toHaveLength(1);
  });
});
