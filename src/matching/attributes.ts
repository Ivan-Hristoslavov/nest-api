import {
  Measurement,
  canonicalIdentifier,
  foldHomoglyphs,
  gtinsOf,
  measurementsOf,
  modelCodesOf,
  normaliseProductName,
  normaliseText,
} from './normalisation';

/**
 * What a product name says about the article, extracted without a model.
 *
 * The schema is deliberately not one fixed set of fields. A bulb has a socket
 * and a colour temperature; a cable has a cross-section and a length; a laptop
 * has storage and a screen. Rather than pretend one shape fits all, the
 * measurements are kept as they were found — value plus canonical unit — and
 * the category only decides how they are *labelled* to a human.
 */
export interface ProductAttributes {
  /** Free text as the supplier wrote it. */
  raw: string;
  /** Canonical units, no punctuation, homoglyphs folded. */
  normalised: string;
  brand: string | null;
  category: CategoryId | null;
  /** Codes that identify rather than describe: H05V-K, ST9453B, CorePro840. */
  modelCodes: string[];
  /** Checksum-valid barcodes found in the text. */
  gtins: string[];
  /** Every measurement, canonicalised. */
  measurements: Measurement[];
  /** Category-independent named specs: socket, cross-section, resolution. */
  specs: Record<string, string>;
}

export type CategoryId =
  'led-bulb' | 'cable' | 'laptop' | 'phone' | 'monitor' | 'tv' | 'tool' | 'breaker';

/**
 * Category words in the languages these catalogues are written in.
 *
 * A Bulgarian shop writes "крушка", a German one "Lampe", a French one
 * "ampoule". The buyer may have typed any of them, and the article is the
 * same — so category is matched across languages rather than within one.
 */
const CATEGORY_WORDS: Record<CategoryId, string[]> = {
  'led-bulb': [
    'bulb',
    'lamp',
    'lampe',
    'ampoule',
    'bombilla',
    'lampada',
    'крушка',
    'лампа',
    'осветител',
    'луничка',
  ],
  cable: ['cable', 'wire', 'kabel', 'câble', 'cavo', 'кабел', 'проводник', 'жило'],
  laptop: ['laptop', 'notebook', 'ultrabook', 'лаптоп', 'ноутбук'],
  phone: ['phone', 'smartphone', 'handy', 'telephone', 'téléphone', 'телефон', 'смартфон'],
  monitor: ['monitor', 'display', 'bildschirm', 'écran', 'монитор', 'дисплей'],
  tv: ['tv', 'television', 'fernseher', 'téléviseur', 'телевизор'],
  tool: [
    'drill',
    'grinder',
    'saw',
    'bohrmaschine',
    'perceuse',
    'бормашина',
    'ъглошлайф',
    'винтоверт',
    'трион',
    'флекс',
  ],
  breaker: [
    'breaker',
    'mcb',
    'rcd',
    'rcbo',
    'fuse',
    'automat',
    'schutzschalter',
    'прекъсвач',
    'предпазител',
    'дефектнотокова',
    'автомат',
  ],
};

/** Long enough to be worth naming, common enough to be worth listing. */
const BRANDS = [
  'philips',
  'osram',
  'ledvance',
  'schneider',
  'legrand',
  'abb',
  'hager',
  'eaton',
  'siemens',
  'wago',
  'elmark',
  'vivalux',
  'kanlux',
  'ultralux',
  'lival',
  'tracon',
  'emos',
  'gtv',
  'vt',
  'v-tac',
  'samsung',
  'lg',
  'sony',
  'panasonic',
  'apple',
  'xiaomi',
  'huawei',
  'nokia',
  'motorola',
  'dell',
  'hp',
  'lenovo',
  'asus',
  'acer',
  'msi',
  'microsoft',
  'intel',
  'amd',
  'nvidia',
  'bosch',
  'makita',
  'dewalt',
  'einhell',
  'stanley',
  'metabo',
  'hilti',
  'ryobi',
  'black+decker',
  'nexans',
  'prysmian',
  'lapp',
  'helukabel',
  'schrack',
  'obo',
  'fischer',
  'knipex',
];

/**
 * Names people type instead of the manufacturer, for spelling suggestions only.
 *
 * Never treated as brands. "Samsung Galaxy S24" and "Galaxy S24" are one
 * phone, and reading the range as a rival manufacturer would rule the pair out
 * on a conflict that does not exist — the same mistake as reading Philips's
 * "CorePro" as a competitor to Philips.
 */
const PRODUCT_FAMILIES = ['iphone', 'ipad', 'macbook', 'galaxy', 'thinkpad', 'corepro', 'pixel'];

/**
 * Sockets, connectors and other codes that name a *fitting* rather than a size.
 *
 * These are the attributes that most often decide whether two articles are
 * interchangeable, and none of them is a plain number, so the measurement
 * extractor cannot see them.
 */
const NAMED_SPECS: Array<{ key: string; pattern: RegExp; label: string }> = [
  {
    key: 'socket',
    pattern: /\b(e14|e27|e40|gu10|gu5\.?3|g9|g4|gx53|b22|mr16)\b/i,
    label: 'Фасунга',
  },
  {
    key: 'cross_section',
    // 3x1.5, 5х4, 3 x 2.5 — cores by square millimetres, the identity of a cable.
    pattern: /\b(\d+(?:[.,]\d+)?)\s*[x]\s*(\d+(?:[.,]\d+)?)\b/i,
    label: 'Сечение',
  },
  {
    key: 'resolution',
    pattern: /\b(\d{3,4}\s*[x]\s*\d{3,4}|4k|8k|uhd|qhd|fhd|full\s*hd)\b/i,
    label: 'Резолюция',
  },
  {
    key: 'connector',
    pattern: /\b(usb-?c|usb-?a|hdmi|displayport|rj-?45|rj-?11|type-?c)\b/i,
    label: 'Конектор',
  },
  { key: 'protection', pattern: /\bip[ -]?(\d{2})\b/i, label: 'Защита' },
  { key: 'curve', pattern: /\b([abcd])\s?(\d{1,3})\s?a\b/i, label: 'Характеристика' },
];

/**
 * Units whose value is part of the article's identity.
 *
 * A difference here is a different product, full stop — 128 GB is not 256 GB
 * and a 55" television is not a 65" one. Everything outside this set describes
 * the article without identifying it: lumens follow from wattage, weight
 * varies with packaging, and neither should ever block a match on its own.
 */
export const IDENTIFYING_UNITS = new Set([
  'W',
  'K',
  'V',
  'A',
  'GB',
  'TB',
  'MB',
  'IN',
  'M',
  'MM',
  'CM',
  'MM2',
  'GHZ',
  'HZ',
]);

/** Named specs that identify rather than describe. */
export const IDENTIFYING_SPECS = new Set(['socket', 'cross_section', 'resolution', 'connector']);

/** Human labels, for an explanation a buyer can check. */
export const ATTRIBUTE_LABELS: Record<string, string> = {
  W: 'Мощност',
  K: 'Цветна температура',
  V: 'Напрежение',
  A: 'Ток',
  GB: 'Памет',
  TB: 'Памет',
  MB: 'Памет',
  IN: 'Размер',
  M: 'Дължина',
  MM: 'Размер',
  CM: 'Размер',
  MM2: 'Сечение',
  GHZ: 'Честота',
  HZ: 'Опресняване',
  LM: 'Светлинен поток',
  KG: 'Тегло',
  socket: 'Фасунга',
  cross_section: 'Сечение',
  resolution: 'Резолюция',
  connector: 'Конектор',
  protection: 'Защита',
  curve: 'Характеристика',
  brand: 'Марка',
  category: 'Вид',
  model: 'Модел',
};

/**
 * "iphnoe 15" — a brand name with two letters swapped.
 *
 * Deliberately narrow: only brands, only tokens long enough for a typo to be
 * unambiguous, and only one edit away. A general-purpose spell checker over a
 * wholesale catalogue corrects "СВТ" to "СВЕТ" and hides the cable somebody
 * was looking for. Suggesting is also all this does — the search still runs on
 * what was typed, because the buyer may know something the list does not.
 */
export function suggestCorrection(query: string): string | null {
  const tokens = normaliseProductName(query).split(/\s+/).filter(Boolean);
  const known = [...BRANDS, ...PRODUCT_FAMILIES];
  let changed = false;

  const corrected = tokens.map((token) => {
    if (token.length < 5 || /\d/.test(token)) return token;
    if (known.includes(token)) return token;

    const near = known.find(
      (brand) => Math.abs(brand.length - token.length) <= 1 && editDistance(token, brand) === 1,
    );

    if (!near) return token;
    changed = true;
    return near;
  });

  return changed ? corrected.join(' ') : null;
}

/**
 * Edit distance counting a swap of two neighbours as one mistake.
 *
 * Plain Levenshtein scores "iphnoe" against "iphone" as two edits and would
 * miss the single most common way a name is mistyped. Bounded at 2, because
 * anything further apart is a different word rather than a slip.
 */
export function editDistance(left: string, right: string): number {
  if (Math.abs(left.length - right.length) > 2) return 3;

  const rows: number[][] = [];

  for (let i = 0; i <= left.length; i += 1) {
    rows[i] = [i, ...Array.from({ length: right.length }, () => 0)];
  }
  for (let j = 0; j <= right.length; j += 1) rows[0][j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;

      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);

      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }

  return rows[left.length][right.length];
}

/**
 * A measurement given the name of what it measures.
 *
 * Two numbers in gigabytes are not one fact. "16GB 512GB" is memory *and*
 * storage, and reading them as an unlabelled pair costs twice: two listings
 * that agree on both look like one agreement rather than two, and a listing
 * that states only the disk looks like it disagrees about the memory it never
 * mentioned.
 *
 * Which number is which cannot be read off the unit, so it is read off the
 * category and the magnitudes — the same way a person does it.
 */
export interface AttributeRole {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** A difference here means a different article. */
  identifying: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  ram_gb: 'Памет (RAM)',
  storage_gb: 'Диск',
  screen_in: 'Екран',
  refresh_hz: 'Опресняване',
  cpu_ghz: 'Процесор',
  power_w: 'Мощност',
  colour_k: 'Цветна температура',
  voltage_v: 'Напрежение',
  current_a: 'Ток',
  flux_lm: 'Светлинен поток',
  cross_section_mm2: 'Сечение',
  length_m: 'Дължина',
};

/** Roles whose disagreement is a different article rather than a detail. */
const NON_IDENTIFYING_ROLES = new Set(['flux_lm']);

/**
 * Assigns roles to the measurements of a listing whose category is known.
 *
 * @returns the roles, and the units they consumed — those units must not then
 * be compared a second time as anonymous buckets.
 */
export function rolesOf(attributes: ProductAttributes): {
  roles: Map<string, AttributeRole>;
  consumed: Set<string>;
} {
  const roles = new Map<string, AttributeRole>();
  const consumed = new Set<string>();

  const category = attributes.category;
  if (!category) return { roles, consumed };

  const valuesOf = (unit: string): number[] =>
    attributes.measurements.filter((m) => m.unit === unit).map((m) => m.value);

  const add = (key: string, value: number, unit: string): void => {
    if (roles.has(key)) return;
    roles.set(key, {
      key,
      label: ROLE_LABELS[key] ?? key,
      value,
      unit,
      identifying: !NON_IDENTIFYING_ROLES.has(key),
    });
  };

  if (category === 'laptop' || category === 'phone') {
    // Terabytes are storage by definition, and the trade quotes 1TB as 1000GB
    // rather than 1024 — matching the number printed on the box matters more
    // here than matching the one the operating system reports.
    const terabytes = valuesOf('TB');
    const gigabytes = valuesOf('GB').sort((a, b) => a - b);

    if (terabytes.length > 0) {
      add('storage_gb', Math.max(...terabytes) * 1000, 'GB');
      consumed.add('TB');
    }

    if (gigabytes.length >= 2) {
      // The smaller is memory, the larger is the disk. No laptop ships with
      // more RAM than storage, so the ordering is safe where both are stated.
      add('ram_gb', gigabytes[0], 'GB');
      add('storage_gb', gigabytes[gigabytes.length - 1], 'GB');
      consumed.add('GB');
    } else if (gigabytes.length === 1) {
      // One number alone: 64GB or less is memory on a laptop and storage on a
      // phone, which is how each is normally advertised.
      const value = gigabytes[0];
      const isMemory = category === 'laptop' && value <= 64;
      add(isMemory ? 'ram_gb' : 'storage_gb', value, 'GB');
      consumed.add('GB');
    }

    for (const inches of valuesOf('IN')) add('screen_in', inches, 'IN');
    for (const ghz of valuesOf('GHZ')) add('cpu_ghz', ghz, 'GHZ');
    if (valuesOf('IN').length > 0) consumed.add('IN');
    if (valuesOf('GHZ').length > 0) consumed.add('GHZ');
  }

  if (category === 'monitor' || category === 'tv') {
    for (const inches of valuesOf('IN')) add('screen_in', inches, 'IN');
    for (const hz of valuesOf('HZ')) add('refresh_hz', hz, 'HZ');
    if (valuesOf('IN').length > 0) consumed.add('IN');
    if (valuesOf('HZ').length > 0) consumed.add('HZ');
  }

  if (category === 'led-bulb') {
    for (const watts of valuesOf('W')) add('power_w', watts, 'W');
    for (const kelvin of valuesOf('K')) add('colour_k', kelvin, 'K');
    for (const lumens of valuesOf('LM')) add('flux_lm', lumens, 'LM');
    for (const volts of valuesOf('V')) add('voltage_v', volts, 'V');
    ['W', 'K', 'LM', 'V'].forEach((unit) => {
      if (valuesOf(unit).length > 0) consumed.add(unit);
    });
  }

  if (category === 'cable') {
    for (const mm2 of valuesOf('MM2')) add('cross_section_mm2', mm2, 'MM2');
    for (const metres of valuesOf('M')) add('length_m', metres, 'M');
    for (const volts of valuesOf('V')) add('voltage_v', volts, 'V');
    ['MM2', 'M', 'V'].forEach((unit) => {
      if (valuesOf(unit).length > 0) consumed.add(unit);
    });
  }

  if (category === 'breaker') {
    for (const amps of valuesOf('A')) add('current_a', amps, 'A');
    for (const volts of valuesOf('V')) add('voltage_v', volts, 'V');
    ['A', 'V'].forEach((unit) => {
      if (valuesOf(unit).length > 0) consumed.add(unit);
    });
  }

  return { roles, consumed };
}

/**
 * The category words, folded exactly as the text they are matched against.
 *
 * `normaliseText` folds Cyrillic letters onto their Latin twins, so "монитор"
 * in a product name arrives as "mohutop". Comparing that against an unfolded
 * "монитор" in this table never matched — every Bulgarian category word was
 * dead on arrival, and only the English ones and the LED fallback ever fired.
 */
const FOLDED_CATEGORY_WORDS = new Map<CategoryId, string[]>(
  (Object.entries(CATEGORY_WORDS) as Array<[CategoryId, string[]]>).map(([category, words]) => [
    category,
    words.map((word) => normaliseText(word)),
  ]),
);

export function detectCategory(text: string): CategoryId | null {
  const normalised = ` ${normaliseText(text)} `;

  for (const [category, words] of FOLDED_CATEGORY_WORDS) {
    if (words.some((word) => normalised.includes(` ${word} `) || normalised.includes(`${word} `))) {
      return category;
    }
  }

  // "LED" alone is not a category — an LED strip, driver and bulb are all LED.
  // Only when nothing else claimed the text does it suggest lighting.
  if (/\bled\b/.test(normalised) && /\b\d+w\b/i.test(normalised)) return 'led-bulb';

  return null;
}

export function detectBrand(text: string): string | null {
  const normalised = ` ${normaliseProductName(text)} `;

  // Longest first: "black+decker" must win over "black" were it ever listed.
  for (const brand of [...BRANDS].sort((a, b) => b.length - a.length)) {
    if (normalised.includes(` ${brand} `)) return brand;
  }

  return null;
}

/** Everything deterministic that can be read off a product name. */
export function extractAttributes(raw: string, extra?: { sku?: string | null }): ProductAttributes {
  const specs: Record<string, string> = {};

  // Folded first: a Bulgarian shop writes the socket "Е27" in Cyrillic, which
  // shares not one byte with the Latin "E27" a buyer types. Read unfolded, the
  // most identifying attribute a bulb has simply goes missing on half the
  // catalogue.
  const folded = foldHomoglyphs(raw || '');

  for (const { key, pattern } of NAMED_SPECS) {
    const match = pattern.exec(folded);
    if (!match) continue;

    specs[key] =
      key === 'cross_section'
        ? `${normaliseNumber(match[1])}x${normaliseNumber(match[2])}`
        : canonicalIdentifier(match[0]).toUpperCase();
  }

  const attributes: ProductAttributes = {
    raw: raw ?? '',
    normalised: normaliseProductName(raw),
    brand: detectBrand(raw),
    category: detectCategory(raw),
    modelCodes: modelCodesOf(raw),
    gtins: gtinsOf(raw),
    measurements: measurementsOf(raw),
    specs,
  };

  if (extra?.sku) {
    const sku = canonicalIdentifier(extra.sku);
    if (sku) attributes.specs.sku = sku.toUpperCase();
  }

  return attributes;
}

function normaliseNumber(value: string): string {
  const number = Number(value.replace(',', '.'));
  return Number.isInteger(number) ? String(number) : String(number);
}

/** One attribute both sides state, and whether they agree. */
export interface AttributeComparison {
  key: string;
  label: string;
  left: string;
  right: string;
  agrees: boolean;
  /** True when disagreement here means a different article, not a variant. */
  identifying: boolean;
}

/**
 * Compares two extractions attribute by attribute.
 *
 * Only attributes **both** sides state are compared. A missing value is not a
 * disagreement: "Philips CorePro LED 12W 840 E27" never writes 4000K — it
 * writes 840, which encodes it — and treating the silence as a conflict would
 * reject the very match this system exists to find. Missing values lower
 * confidence and are what a model is later asked about; stated values that
 * differ end the conversation.
 */
export function compareAttributes(
  left: ProductAttributes,
  right: ProductAttributes,
): AttributeComparison[] {
  const comparisons: AttributeComparison[] = [];

  const unitsOf = (attributes: ProductAttributes): Map<string, Set<number>> => {
    const map = new Map<string, Set<number>>();
    for (const { unit, value } of attributes.measurements) {
      const bucket = map.get(unit) ?? new Set<number>();
      bucket.add(value);
      map.set(unit, bucket);
    }
    return map;
  };

  // Named roles first, where the category says what each number measures.
  // Compared this way, "16GB 512GB" against "16GB SSD 512GB" is two agreements
  // rather than one, and against a listing quoting only the disk it is one
  // agreement and one silence rather than a contradiction.
  const leftRoles = rolesOf(left);
  const rightRoles = rolesOf(right);

  for (const key of new Set([...leftRoles.roles.keys(), ...rightRoles.roles.keys()])) {
    const a = leftRoles.roles.get(key);
    const b = rightRoles.roles.get(key);
    if (!a || !b) continue;

    comparisons.push({
      key,
      label: a.label,
      left: `${a.value}${a.unit}`,
      right: `${b.value}${b.unit}`,
      agrees: a.value === b.value,
      identifying: a.identifying,
    });
  }

  const leftUnits = unitsOf(left);
  const rightUnits = unitsOf(right);
  // Only where *both* sides named the unit is the anonymous comparison
  // redundant. One side naming it and the other not means the second still has
  // an unlabelled number, and dropping it loses the comparison entirely — the
  // exact case of a Bulgarian listing whose category word went unrecognised.
  const consumed = new Set([...leftRoles.consumed].filter((unit) => rightRoles.consumed.has(unit)));

  for (const unit of new Set([...leftUnits.keys(), ...rightUnits.keys()])) {
    // Already compared under a name that says what it measures.
    if (consumed.has(unit)) continue;

    const a = leftUnits.get(unit);
    const b = rightUnits.get(unit);
    if (!a || !b) continue;

    // Not equality but overlap: one side stating fewer numbers in the same
    // unit has said less, not something different. A supplier who lists only
    // the disk was being terse, and reading that as a disagreement about the
    // memory they never mentioned rejects a listing that matches.
    const smaller = a.size <= b.size ? a : b;
    const larger = a.size <= b.size ? b : a;
    const contained = [...smaller].every((value) => larger.has(value));

    comparisons.push({
      key: unit,
      label: ATTRIBUTE_LABELS[unit] ?? unit,
      left: format(a, unit),
      right: format(b, unit),
      agrees: contained,
      identifying: IDENTIFYING_UNITS.has(unit),
    });
  }

  for (const key of new Set([...Object.keys(left.specs), ...Object.keys(right.specs)])) {
    const a = left.specs[key];
    const b = right.specs[key];
    if (a === undefined || b === undefined) continue;

    comparisons.push({
      key,
      label: ATTRIBUTE_LABELS[key] ?? key,
      left: a,
      right: b,
      agrees: a === b,
      identifying: IDENTIFYING_SPECS.has(key) || key === 'sku',
    });
  }

  if (left.brand && right.brand) {
    comparisons.push({
      key: 'brand',
      label: ATTRIBUTE_LABELS.brand,
      left: left.brand,
      right: right.brand,
      agrees: left.brand === right.brand,
      identifying: true,
    });
  }

  if (left.category && right.category) {
    comparisons.push({
      key: 'category',
      label: ATTRIBUTE_LABELS.category,
      left: left.category,
      right: right.category,
      agrees: left.category === right.category,
      identifying: true,
    });
  }

  return comparisons;
}

function format(values: Set<number>, unit: string): string {
  return [...values]
    .sort((a, b) => a - b)
    .map((value) => `${value}${unit}`)
    .join(' + ');
}
