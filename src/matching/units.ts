/**
 * One place that knows what a unit means.
 *
 * Every matcher before this one carried its own idea of measurement, and each
 * of them was right about a different industry. The bulb matcher knew watts;
 * the cable matcher knew square millimetres; nobody knew litres, and so
 * "250ml" and "0.25L" were two unrelated products for a hospitality buyer who
 * meant one cup.
 *
 * The fix is dimensional rather than categorical. A unit belongs to a
 * *quantity kind* — length, volume, data, power — and every unit of a kind
 * converts to that kind's base. Two measurements are then comparable exactly
 * when they share a kind, whatever industry either came from, and 1 m equals
 * 1000 mm equals 100 cm without anybody writing a rule about pipes.
 *
 * Nothing here knows what a product is. That is the point.
 */

/**
 * The dimensions this system can compare across.
 *
 * Colour temperature is kept apart from ordinary temperature deliberately.
 * They share a physical dimension and nothing else: 4000 K is what a lamp
 * looks like, 40 °C is what a room feels like, and a matcher that converts
 * between them would rule a lamp out for disagreeing with a thermostat.
 */
export type QuantityKind =
  | 'length'
  | 'area'
  | 'volume'
  | 'mass'
  | 'data'
  | 'power'
  | 'voltage'
  | 'current'
  | 'resistance'
  | 'frequency'
  | 'energy'
  | 'colour_temperature'
  | 'temperature'
  | 'pressure'
  | 'luminous_flux'
  | 'angle'
  | 'time'
  | 'speed'
  | 'torque'
  | 'grammage'
  | 'density'
  | 'rotation'
  | 'resolution'
  | 'count';

interface UnitDefinition {
  kind: QuantityKind;
  /** How this unit is written once canonicalised. */
  canonical: string;
  /** Multiply by this to reach the kind's base unit. */
  factor: number;
  /** Added after scaling. Only temperature needs it. */
  offset?: number;
}

/** The unit every value of a kind is stored in. */
export const BASE_UNIT: Record<QuantityKind, string> = {
  length: 'm',
  area: 'm²',
  volume: 'l',
  mass: 'kg',
  data: 'GB',
  power: 'W',
  voltage: 'V',
  current: 'A',
  resistance: 'Ω',
  frequency: 'Hz',
  energy: 'Wh',
  colour_temperature: 'K',
  temperature: '°C',
  pressure: 'bar',
  luminous_flux: 'lm',
  angle: '°',
  time: 's',
  speed: 'km/h',
  torque: 'Nm',
  grammage: 'g/m²',
  density: 'kg/m³',
  rotation: 'rpm',
  resolution: 'dpi',
  count: 'pcs',
};

/**
 * Every spelling of every unit, in the languages these catalogues use.
 *
 * A list rather than a single definition per spelling, because spellings
 * collide: "G" is grams to a food distributor and gigabytes to an IT reseller,
 * "M" is metres to a plumber and a clothing size to a uniform supplier. The
 * first entry is what the spelling means when nothing says otherwise; the rest
 * are what {@link unitFor} can be steered to with a hint.
 *
 * Adding a language means adding spellings here. It never means adding code.
 */
const UNIT_ALIASES: Record<string, UnitDefinition[]> = {};

function define(
  kind: QuantityKind,
  canonical: string,
  factor: number,
  spellings: string[],
  offset?: number,
): void {
  for (const spelling of spellings) {
    const key = spelling.toLowerCase();
    const list = UNIT_ALIASES[key] ?? [];
    list.push({ kind, canonical, factor, offset });
    UNIT_ALIASES[key] = list;
  }
}

// --- length -------------------------------------------------------------
define('length', 'mm', 0.001, ['mm', 'мм', 'millimeter', 'millimetre', 'милиметра', 'милиметър']);
define('length', 'cm', 0.01, ['cm', 'см', 'centimeter', 'centimetre', 'сантиметра', 'сантиметър']);
define('length', 'dm', 0.1, ['dm', 'дм']);
define('length', 'm', 1, [
  'm',
  'м',
  'meter',
  'metre',
  'meters',
  'metres',
  'метра',
  'метър',
  'метри',
  'lfm',
  'мл',
]);
define('length', 'km', 1000, ['km', 'км', 'kilometer', 'kilometre']);
// "in" is deliberately absent. It is a unit in a catalogue and a preposition
// everywhere else, and "500 in stock" read as five hundred inches is a worse
// mistake than missing the handful of listings that abbreviate inches that way.
define('length', '"', 0.0254, ['inch', 'inches', '"', '”', '″', 'цол', 'цола', 'zoll']);
define('length', 'ft', 0.3048, ['ft', 'foot', 'feet']);
define('length', 'μm', 0.000001, ['um', 'µm', 'μm', 'micron', 'микрон']);

// --- area ---------------------------------------------------------------
define('area', 'mm²', 0.000001, ['mm2', 'мм2', 'mm²', 'мм²', 'sqmm']);
define('area', 'cm²', 0.0001, ['cm2', 'см2', 'cm²', 'см²']);
define('area', 'm²', 1, ['m2', 'м2', 'm²', 'м²', 'sqm', 'кв.м', 'кв м']);

// --- volume -------------------------------------------------------------
define('volume', 'ml', 0.001, ['ml', 'мл', 'milliliter', 'millilitre', 'cc', 'ccm']);
define('volume', 'cl', 0.01, ['cl', 'сл']);
define('volume', 'l', 1, [
  'l',
  'lt',
  'ltr',
  'liter',
  'litre',
  'liters',
  'litres',
  'л',
  'литра',
  'литър',
]);
define('volume', 'm³', 1000, ['m3', 'м3', 'm³', 'cbm']);

// --- mass ---------------------------------------------------------------
define('mass', 'mg', 0.000001, ['mg', 'мг']);
define('mass', 'g', 0.001, ['g', 'gr', 'gram', 'grams', 'gramm', 'г', 'гр', 'грам', 'грама']);
define('mass', 'kg', 1, ['kg', 'кг', 'kilo', 'kilogram', 'килограм', 'килограма']);
define('mass', 't', 1000, ['t', 'тон', 'tonne', 'ton']);
define('mass', 'lb', 0.4536, ['lb', 'lbs', 'pound']);

// --- data ---------------------------------------------------------------
//
// Decimal, not binary. The trade quotes 1 TB as 1000 GB because that is what
// the box says, and matching the box matters more here than matching what the
// operating system will later report.
define('data', 'KB', 0.000001, ['kb', 'кб']);
define('data', 'MB', 0.001, ['mb', 'мб']);
define('data', 'GB', 1, ['gb', 'гб', 'gib', 'gbyte']);
define('data', 'TB', 1000, ['tb', 'тб']);
// "16G RAM" and "1T SSD" are gigabytes and terabytes to everyone in the trade.
// Registered after grams and tonnes, so a bare "500 g" of coffee still weighs
// something — the label beside the number is what promotes these.
define('data', 'GB', 1, ['g']);
define('data', 'TB', 1000, ['t']);

// --- electrical ---------------------------------------------------------
define('power', 'mW', 0.001, ['mw']);
define('power', 'W', 1, ['w', 'wt', 'watt', 'watts', 'вт', 'ват', 'вата', 'ватa', 'ватов']);
define('power', 'kW', 1000, ['kw', 'кв', 'kilowatt', 'киловат']);
define('power', 'hp', 735.5, ['hp', 'ps', 'к.с', 'кс']);
define('voltage', 'mV', 0.001, ['mv']);
define('voltage', 'V', 1, ['v', 'в', 'volt', 'volts', 'волт', 'волта']);
define('voltage', 'kV', 1000, ['kv', 'кв.']);
define('current', 'mA', 0.001, ['ma', 'ма']);
define('current', 'A', 1, ['a', 'amp', 'amps', 'ampere', 'ампер', 'ампера']);
define('current', 'kA', 1000, ['ka']);
define('resistance', 'Ω', 1, ['ohm', 'ohms', 'ом', 'Ω', 'ω']);
define('resistance', 'kΩ', 1000, ['kohm', 'kω']);
define('energy', 'Wh', 1, ['wh', 'вч']);
define('energy', 'kWh', 1000, ['kwh', 'квч']);
define('energy', 'mAh', 0.0037, ['mah', 'мач']);

// --- frequency ----------------------------------------------------------
define('frequency', 'Hz', 1, ['hz', 'хц', 'херца', 'hertz']);
define('frequency', 'kHz', 1000, ['khz', 'кхц']);
define('frequency', 'MHz', 1000000, ['mhz', 'мхц']);
define('frequency', 'GHz', 1000000000, ['ghz', 'гхц']);

// --- temperature --------------------------------------------------------
define('colour_temperature', 'K', 1, ['k', 'kelvin', 'келвин', 'келвина']);
define('temperature', '°C', 1, ['°c', 'c°', 'celsius', '℃', 'градуса']);
define('temperature', '°F', 5 / 9, ['°f', 'fahrenheit'], -17.7778);

// --- the rest -----------------------------------------------------------
define('pressure', 'bar', 1, ['bar', 'бар', 'бара']);
define('pressure', 'mbar', 0.001, ['mbar', 'мбар']);
define('pressure', 'Pa', 0.00001, ['pa', 'па']);
define('pressure', 'kPa', 0.01, ['kpa', 'кпа']);
define('pressure', 'MPa', 10, ['mpa', 'мпа']);
define('pressure', 'psi', 0.0689, ['psi']);
define('pressure', 'atm', 1.01325, ['atm', 'атм']);
define('luminous_flux', 'lm', 1, ['lm', 'lumen', 'lumens', 'лумен', 'лумена']);
define('angle', '°', 1, ['°', 'deg', 'degree', 'degrees', 'градус']);
// Single letters that are also ordinary words — s, d, y — are left out for the
// same reason "in" is: a false measurement is worse than a missed one.
define('time', 's', 1, ['sec', 'second', 'seconds', 'сек', 'секунди']);
define('time', 'min', 60, ['min', 'minute', 'minutes', 'мин', 'минути']);
define('time', 'h', 3600, ['h', 'hr', 'hour', 'hours', 'ч', 'часа']);
define('time', 'd', 86400, ['day', 'days', 'дни', 'ден']);
define('time', 'y', 31536000, ['year', 'years', 'год', 'години']);
define('speed', 'km/h', 1, ['km/h', 'kmh', 'kph', 'км/ч']);
define('speed', 'm/s', 3.6, ['m/s', 'ms-1', 'м/с']);
define('speed', 'mph', 1.609, ['mph']);
define('torque', 'Nm', 1, ['nm', 'н.м', 'нм', 'newtonmeter']);
define('grammage', 'g/m²', 1, ['gsm', 'g/m2', 'g/m²', 'гр/м2', 'г/м2', 'гсм']);
define('density', 'kg/m³', 1, ['kg/m3', 'kg/m³', 'кг/м3']);
define('rotation', 'rpm', 1, ['rpm', 'об/мин', 'об.мин', 'u/min']);
define('resolution', 'dpi', 1, ['dpi', 'ppi']);
define('count', 'pcs', 1, [
  'pcs',
  'pc',
  'piece',
  'pieces',
  'x',
  'бр',
  'бр.',
  'броя',
  'брой',
  'stück',
  'stk',
  'pièces',
  'buc',
  'τεμ',
  'sheets',
  'sheet',
  'листа',
  'лист',
  'blatt',
  'foi',
  'ks',
]);

/** Everything a unit spelling could mean, most likely first. */
export function unitCandidates(spelling: string): UnitDefinition[] {
  return UNIT_ALIASES[spelling.toLowerCase().trim()] ?? [];
}

/**
 * What a unit spelling means, optionally steered by what is expected.
 *
 * The hint is how "16G RAM" reads as gigabytes while "500 g flour" reads as
 * grams, without either being a rule about laptops or about flour. The label
 * beside the number says which dimension is in play; the unit table says the
 * rest.
 */
export function unitFor(spelling: string, hint?: QuantityKind | null): UnitDefinition | null {
  const candidates = unitCandidates(spelling);
  if (candidates.length === 0) return null;
  if (hint) {
    const steered = candidates.find((candidate) => candidate.kind === hint);
    if (steered) return steered;
  }
  return candidates[0];
}

/** A measurement, in the unit it was written and in its kind's base. */
export interface Quantity {
  kind: QuantityKind;
  /** The number as written. */
  value: number;
  /** The unit as canonically spelled. */
  unit: string;
  /** The same measurement in {@link BASE_UNIT}, which is what comparisons use. */
  base: number;
}

/** Builds a quantity from a number and a unit spelling. */
export function quantityOf(
  value: number,
  spelling: string,
  hint?: QuantityKind | null,
): Quantity | null {
  const unit = unitFor(spelling, hint);
  if (!unit || !Number.isFinite(value)) return null;

  return {
    kind: unit.kind,
    value: round(value),
    unit: unit.canonical,
    base: round(value * unit.factor + (unit.offset ?? 0), 9),
  };
}

/**
 * Two measurements of the same kind, compared at the precision the trade uses.
 *
 * Exact equality is wrong for anything continuous: 0.0254 m and 25.4 mm are
 * one inch written twice, and a float comparison says they differ. A relative
 * tolerance of a tenth of a percent absorbs that and nothing else — 50 mm and
 * 51 mm remain two different pipes, which is the whole point of section 11.
 */
export function sameQuantity(left: Quantity, right: Quantity, tolerance = 0.001): boolean {
  if (left.kind !== right.kind) return false;
  const scale = Math.max(Math.abs(left.base), Math.abs(right.base), 1e-9);
  return Math.abs(left.base - right.base) / scale <= tolerance;
}

/** The measurement as a person would write it. */
export function formatQuantity(quantity: Quantity): string {
  const spaced = /^[a-zA-Zµ°Ω]/.test(quantity.unit) && quantity.unit !== '"';
  return `${trim(quantity.value)}${spaced ? ' ' : ''}${quantity.unit}`;
}

/** The same measurement expressed in the kind's base unit, for a debug view. */
export function formatBase(quantity: Quantity): string {
  return `${trim(quantity.base)} ${BASE_UNIT[quantity.kind]}`;
}

/** Converts a measurement into another unit of the same kind, or null. */
export function convert(quantity: Quantity, spelling: string): Quantity | null {
  const unit = unitFor(spelling, quantity.kind);
  if (!unit || unit.kind !== quantity.kind) return null;

  const value = (quantity.base - (unit.offset ?? 0)) / unit.factor;
  return { kind: unit.kind, value: round(value), unit: unit.canonical, base: quantity.base };
}

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/**
 * Every unit spelling the extractor can look for, longest first.
 *
 * Longest first matters: "mm2" must be tried before "mm", or every
 * cross-section in an electrical catalogue is read as a length.
 */
export const UNIT_SPELLINGS: string[] = Object.keys(UNIT_ALIASES)
  .filter((spelling) => spelling !== 'x')
  .sort((a, b) => b.length - a.length);
