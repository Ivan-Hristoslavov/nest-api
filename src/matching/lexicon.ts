/**
 * The words that tell you what a number is about.
 *
 * This file is data. It has no branches, no product categories and no
 * `if (category === …)`, and adding an industry to it means adding rows rather
 * than adding code. That distinction is the whole architecture: the engine
 * below it reasons about *concepts* — a diameter, a capacity, a pack size —
 * and this table is only how the trade happens to spell them this week.
 *
 * Three things live here and nothing else:
 *
 *  1. **Concepts.** What an attribute is, which dimension it is measured in,
 *     and what role it plays in deciding whether two listings are one article.
 *  2. **Labels.** Every spelling of a concept, in the languages these
 *     catalogues are written in. A label beside a number names the number.
 *  3. **Vocabulary.** Words that are worth recognising as a class rather than
 *     one at a time: colours, materials, finishes, packaging words, positions.
 *
 * Nothing here says what a laptop is. A laptop is whatever the buyer typed.
 */

import { QuantityKind } from './units';

/**
 * What an attribute *does* when two listings are compared.
 *
 * The distinction section 6 asks for, and the reason a single generic matcher
 * can serve every industry. A conflict in an identity attribute is a different
 * article; a conflict in a variant attribute is a different version of the
 * same one; a conflict in a compatibility attribute means it will not fit; a
 * difference in a descriptive attribute means very little at all.
 *
 * Roles come from the concept, not from the product. Storage capacity
 * identifies a laptop, a memory card and a water tank alike, and none of those
 * needed a rule of its own.
 */
export type AttributeRole =
  'identity' | 'variant' | 'compatibility' | 'package' | 'commercial' | 'descriptive';

export interface ConceptDefinition {
  /** The canonical key an attribute is filed under. */
  key: string;
  /** The dimension this concept is measured in, when it is measured at all. */
  kind: QuantityKind | null;
  role: AttributeRole;
  /** Every spelling that names this concept, in every language we have seen. */
  labels: string[];
  /** Shown to a person. English, because the debugger and the API are English. */
  label: string;
}

/**
 * The concepts, and what names them.
 *
 * Ordering matters only in that longer labels are matched first, which the
 * index below arranges. Everything else about this list is alphabetical
 * convenience.
 */
export const CONCEPTS: ConceptDefinition[] = [
  // --- capacity and memory ---------------------------------------------
  {
    key: 'ram',
    kind: 'data',
    role: 'identity',
    label: 'Memory',
    labels: [
      'ram',
      'memory',
      'system memory',
      'оперативна памет',
      'памет',
      'ram memory',
      'arbeitsspeicher',
      'mémoire',
      'memorie',
      'μνήμη',
      'ddr3',
      'ddr4',
      'ddr5',
      'sodimm',
    ],
  },
  {
    key: 'storage',
    kind: 'data',
    role: 'identity',
    label: 'Storage',
    labels: [
      'storage',
      'ssd',
      'hdd',
      'nvme',
      'emmc',
      'disk',
      'drive',
      'hard drive',
      'диск',
      'твърд диск',
      'съхранение',
      'speicher',
      'festplatte',
      'stockage',
      'stocare',
      'δίσκος',
      'm.2',
      'sata',
      'microsd',
      'sd card',
    ],
  },
  {
    key: 'capacity',
    kind: 'volume',
    role: 'identity',
    label: 'Capacity',
    labels: [
      'capacity',
      'volume',
      'обем',
      'вместимост',
      'inhalt',
      'contenance',
      'capacitate',
      'χωρητικότητα',
    ],
  },
  {
    key: 'battery',
    kind: 'energy',
    role: 'identity',
    label: 'Battery',
    labels: ['battery', 'батерия', 'акумулатор', 'akku', 'batterie', 'baterie', 'μπαταρία'],
  },

  // --- geometry ---------------------------------------------------------
  {
    key: 'length',
    kind: 'length',
    role: 'identity',
    label: 'Length',
    labels: ['length', 'long', 'дължина', 'дълж', 'länge', 'longueur', 'lungime', 'μήκος', 'lg'],
  },
  {
    key: 'width',
    kind: 'length',
    role: 'identity',
    label: 'Width',
    labels: ['width', 'wide', 'ширина', 'шир', 'breite', 'largeur', 'lățime', 'latime', 'πλάτος'],
  },
  {
    key: 'height',
    kind: 'length',
    role: 'identity',
    label: 'Height',
    labels: [
      'height',
      'high',
      'височина',
      'вис',
      'höhe',
      'hauteur',
      'înălțime',
      'inaltime',
      'ύψος',
    ],
  },
  {
    key: 'depth',
    kind: 'length',
    role: 'identity',
    label: 'Depth',
    labels: ['depth', 'дълбочина', 'tiefe', 'profondeur', 'adâncime'],
  },
  {
    key: 'diameter',
    kind: 'length',
    role: 'identity',
    label: 'Diameter',
    labels: [
      'diameter',
      'dia',
      'ø',
      'Ø',
      'dn',
      'nominal diameter',
      'диаметър',
      'диам',
      'durchmesser',
      'diamètre',
      'diametru',
      'διάμετρος',
      'od',
      'bore',
    ],
  },
  {
    key: 'thickness',
    kind: 'length',
    role: 'identity',
    label: 'Thickness',
    labels: ['thickness', 'дебелина', 'деб', 'stärke', 'starke', 'épaisseur', 'grosime'],
  },
  {
    key: 'cross_section',
    kind: 'area',
    role: 'identity',
    label: 'Cross-section',
    labels: [
      'cross section',
      'cross-section',
      'сечение',
      'напречно сечение',
      'querschnitt',
      'section',
    ],
  },
  {
    key: 'screen',
    kind: 'length',
    role: 'identity',
    label: 'Screen',
    labels: [
      'screen',
      'display',
      'diagonal',
      'екран',
      'дисплей',
      'диагонал',
      'bildschirm',
      'écran',
      'οθόνη',
    ],
  },

  // --- electrical -------------------------------------------------------
  {
    key: 'power',
    kind: 'power',
    role: 'identity',
    label: 'Power',
    labels: ['power', 'wattage', 'output', 'мощност', 'leistung', 'puissance', 'putere', 'ισχύς'],
  },
  {
    key: 'voltage',
    kind: 'voltage',
    role: 'identity',
    label: 'Voltage',
    labels: ['voltage', 'напрежение', 'spannung', 'tension', 'tensiune', 'τάση'],
  },
  {
    key: 'current',
    kind: 'current',
    role: 'identity',
    label: 'Current',
    labels: ['current', 'amperage', 'ток', 'strom', 'courant', 'curent', 'ρεύμα'],
  },
  {
    key: 'colour_temperature',
    kind: 'colour_temperature',
    role: 'identity',
    label: 'Colour temperature',
    labels: [
      'colour temperature',
      'color temperature',
      'cct',
      'цветна температура',
      'farbtemperatur',
    ],
  },
  {
    key: 'luminous_flux',
    kind: 'luminous_flux',
    role: 'descriptive',
    label: 'Luminous flux',
    labels: ['luminous flux', 'светлинен поток', 'lichtstrom', 'flux lumineux'],
  },
  {
    key: 'frequency',
    kind: 'frequency',
    role: 'identity',
    label: 'Frequency',
    labels: ['frequency', 'честота', 'frequenz', 'fréquence', 'frecvență'],
  },
  {
    key: 'refresh_rate',
    kind: 'frequency',
    role: 'variant',
    label: 'Refresh rate',
    labels: ['refresh rate', 'refresh', 'опресняване', 'bildwiederholrate'],
  },
  {
    key: 'cpu',
    kind: 'frequency',
    role: 'identity',
    label: 'Processor',
    labels: ['cpu', 'processor', 'процесор', 'prozessor', 'procesor', 'επεξεργαστής'],
  },

  // --- mechanical -------------------------------------------------------
  {
    key: 'pressure',
    kind: 'pressure',
    role: 'identity',
    label: 'Pressure',
    labels: ['pressure', 'pn', 'налягане', 'druck', 'pression', 'presiune', 'πίεση'],
  },
  {
    key: 'torque',
    kind: 'torque',
    role: 'identity',
    label: 'Torque',
    labels: ['torque', 'въртящ момент', 'drehmoment', 'couple', 'cuplu'],
  },
  {
    key: 'rotation',
    kind: 'rotation',
    role: 'identity',
    label: 'Speed',
    labels: ['rpm', 'обороти', 'drehzahl', 'turatie', 'turație'],
  },
  {
    key: 'weight',
    kind: 'mass',
    role: 'descriptive',
    label: 'Weight',
    labels: ['weight', 'тегло', 'gewicht', 'poids', 'greutate', 'βάρος', 'net weight'],
  },
  {
    key: 'grammage',
    kind: 'grammage',
    role: 'identity',
    label: 'Grammage',
    labels: ['grammage', 'basis weight', 'грамаж', 'flächengewicht'],
  },
  {
    key: 'temperature_rating',
    kind: 'temperature',
    role: 'identity',
    label: 'Temperature',
    labels: ['temperature', 'температура', 'temperatur', 'température'],
  },

  // --- packaging and commerce ------------------------------------------
  {
    key: 'package_quantity',
    kind: 'count',
    role: 'package',
    label: 'Pack size',
    labels: [
      'pack',
      'pack of',
      'package',
      'packung',
      'опаковка',
      'в опаковка',
      'в пакет',
      'комплект',
      'set',
      'set of',
      'kit',
      'бр в опаковка',
      'blister',
      'carton',
      'кашон',
      'box of',
      'кутия',
      'sheets',
      'листа',
      'per pack',
    ],
  },
  {
    key: 'warranty',
    kind: 'time',
    role: 'commercial',
    label: 'Warranty',
    labels: ['warranty', 'guarantee', 'гаранция', 'garantie', 'garanție'],
  },
  {
    key: 'model_year',
    kind: null,
    role: 'compatibility',
    label: 'Year',
    labels: ['year', 'model year', 'година', 'baujahr', 'an fabricatie'],
  },
];

/** Concept by key, for role and label lookups. */
export const CONCEPT_BY_KEY = new Map(CONCEPTS.map((concept) => [concept.key, concept]));

/**
 * Every label spelling, pointing at its concept — longest spelling first.
 *
 * Longest first because labels nest: "colour temperature" must win over
 * "temperature", and "hard drive" over "drive". A shorter label winning would
 * file the number under the wrong concept, which is worse than filing it under
 * none.
 */
export const LABEL_INDEX: Array<{ spelling: string; concept: ConceptDefinition }> =
  CONCEPTS.flatMap((concept) =>
    concept.labels.map((spelling) => ({ spelling: spelling.toLowerCase(), concept })),
  ).sort((a, b) => b.spelling.length - a.spelling.length);

/** The concept a label names, or null. Exact spellings only — no guessing. */
export function conceptForLabel(label: string): ConceptDefinition | null {
  const needle = label.toLowerCase().trim();
  return LABEL_INDEX.find((entry) => entry.spelling === needle)?.concept ?? null;
}

/**
 * What an unlabelled measurement of each dimension is presumed to be about.
 *
 * A bare number with a unit and no word beside it still says something: a
 * listing that writes "65W" and nothing else is talking about power, and
 * whether that identifies the article is a property of *power*, not of
 * chargers. Where a dimension has no obvious role, identity is the safe
 * assumption — it makes the matcher stricter, and a match refused is cheaper
 * than an order sent to the wrong supplier.
 */
export const ROLE_BY_KIND: Record<QuantityKind, AttributeRole> = {
  length: 'identity',
  area: 'identity',
  volume: 'identity',
  mass: 'descriptive',
  data: 'identity',
  power: 'identity',
  voltage: 'identity',
  current: 'identity',
  resistance: 'identity',
  frequency: 'identity',
  energy: 'identity',
  colour_temperature: 'identity',
  temperature: 'descriptive',
  pressure: 'identity',
  luminous_flux: 'descriptive',
  angle: 'descriptive',
  time: 'descriptive',
  speed: 'identity',
  torque: 'identity',
  grammage: 'identity',
  density: 'descriptive',
  rotation: 'identity',
  resolution: 'identity',
  count: 'package',
};

/**
 * Coded specifications: values that identify a fitting rather than measure it.
 *
 * None of these is a plain number, so no dimensional extractor can see them,
 * and every one of them decides whether two articles are interchangeable. They
 * are patterns rather than words because that is what they are in the world —
 * "E27", "IP44", "M8", "A4", "3/4\"" are formats, not vocabulary.
 */
export const CODED_SPECS: Array<{
  key: string;
  label: string;
  role: AttributeRole;
  pattern: RegExp;
  /**
   * Spellings of one fitting, folded onto the spelling both sides can share.
   *
   * "USB-C" and "Type-C" are one connector and shared not a single character,
   * so a charger search rejected the very listing it was looking for. This is
   * section 7's semantic normalisation kept where it belongs — beside the
   * pattern that produced the value, as data.
   */
  aliases?: Record<string, string>;
}> = [
  {
    key: 'socket',
    label: 'Socket',
    role: 'identity',
    pattern: /\b(e14|e27|e40|gu10|gu5\.?3|g9|g4|gx53|b22|mr16|g13|t8|t5)\b/i,
  },
  {
    key: 'connector',
    label: 'Connector',
    role: 'identity',
    pattern:
      /\b(usb[- ]?c|usb[- ]?a|usb[- ]?b|type[- ]?c|micro[- ]?usb|hdmi|displayport|rj[- ]?45|rj[- ]?11|xlr|jack|dvi|vga)\b/i,
    aliases: { TYPEC: 'USBC', TYPEA: 'USBA', TYPEB: 'USBB', USBTYPEC: 'USBC' },
  },
  {
    key: 'protection',
    label: 'Ingress protection',
    role: 'identity',
    pattern: /\bip[ -]?(\d{2}k?)\b/i,
  },
  // "m2" and "m3" are square and cubic metres, not an M2 thread, so they are
  // refused here rather than stolen from the unit reader.
  {
    key: 'thread',
    label: 'Thread',
    role: 'identity',
    pattern: /\b(m(?!2\b|3\b)\d{1,3}(?:\s*[x×х]\s*\d+(?:[.,]\d+)?)?|g\d\/\d|\d\/\d\s?["”])\b/i,
  },
  {
    key: 'paper_format',
    label: 'Format',
    role: 'identity',
    pattern: /\b((?:din\s?)?a[0-8]|b[0-8]|c[0-8]|letter|legal|folio)\b/i,
    aliases: {
      DINA0: 'A0',
      DINA1: 'A1',
      DINA2: 'A2',
      DINA3: 'A3',
      DINA4: 'A4',
      DINA5: 'A5',
      DINA6: 'A6',
    },
  },
  {
    key: 'resolution',
    label: 'Resolution',
    role: 'identity',
    pattern: /\b(\d{3,4}\s*[xх]\s*\d{3,4}|4k|8k|uhd|qhd|fhd|full\s*hd|hd\+?)\b/i,
    aliases: {
      FULLHD: 'FHD',
      '1920X1080': 'FHD',
      UHD: '4K',
      '3840X2160': '4K',
      '2560X1440': 'QHD',
    },
  },
  {
    key: 'efficiency',
    label: 'Efficiency class',
    role: 'descriptive',
    pattern: /\b([a-g]\+{0,3})\s?(?:class|клас)\b/i,
  },
  {
    key: 'breaker_curve',
    label: 'Tripping curve',
    role: 'identity',
    pattern: /\b([abcdkz])\s?(\d{1,3})\s?a\b/i,
  },
  {
    key: 'standard',
    label: 'Standard',
    role: 'identity',
    pattern: /\b(en\s?\d{3,5}|iso\s?\d{3,5}|din\s?\d{3,5}|bs\s?\d{3,5})\b/i,
  },
];

/**
 * Colours, as the trade writes them.
 *
 * A class rather than a concept because a colour is recognised by being a
 * colour word, not by having "colour:" printed in front of it. Whether a
 * colour identifies the article or merely varies it is decided per search —
 * see {@link ROLE_BY_KIND}'s neighbours in `relate.ts` — because a black chair
 * and a white chair are two products, while a black and a white cable tie are
 * usually one line in a catalogue.
 */
export const COLOURS: Record<string, string> = {
  black: 'black',
  schwarz: 'black',
  noir: 'black',
  negru: 'black',
  черен: 'black',
  черно: 'black',
  черна: 'black',
  μαύρο: 'black',
  white: 'white',
  weiss: 'white',
  weiß: 'white',
  blanc: 'white',
  alb: 'white',
  бял: 'white',
  бяло: 'white',
  бяла: 'white',
  λευκό: 'white',
  grey: 'grey',
  gray: 'grey',
  grau: 'grey',
  gris: 'grey',
  gri: 'grey',
  сив: 'grey',
  сиво: 'grey',
  сива: 'grey',
  silver: 'silver',
  silber: 'silver',
  argent: 'silver',
  argintiu: 'silver',
  сребрист: 'silver',
  сребърен: 'silver',
  red: 'red',
  rot: 'red',
  rouge: 'red',
  roșu: 'red',
  червен: 'red',
  червено: 'red',
  червена: 'red',
  blue: 'blue',
  blau: 'blue',
  bleu: 'blue',
  albastru: 'blue',
  син: 'blue',
  синьо: 'blue',
  синя: 'blue',
  green: 'green',
  grün: 'green',
  vert: 'green',
  verde: 'green',
  зелен: 'green',
  зелено: 'green',
  зелена: 'green',
  yellow: 'yellow',
  gelb: 'yellow',
  jaune: 'yellow',
  galben: 'yellow',
  жълт: 'yellow',
  жълто: 'yellow',
  brown: 'brown',
  braun: 'brown',
  marron: 'brown',
  maro: 'brown',
  кафяв: 'brown',
  кафяво: 'brown',
  gold: 'gold',
  auriu: 'gold',
  златен: 'gold',
  златист: 'gold',
  beige: 'beige',
  бежов: 'beige',
  orange: 'orange',
  оранжев: 'orange',
  pink: 'pink',
  rosa: 'pink',
  розов: 'pink',
  purple: 'purple',
  lila: 'purple',
  виолетов: 'purple',
  лилав: 'purple',
  transparent: 'transparent',
  прозрачен: 'transparent',
  klar: 'transparent',
};

/** Materials and finishes: a variant axis in most trades, identity in some. */
export const MATERIALS: Record<string, string> = {
  steel: 'steel',
  stahl: 'steel',
  acier: 'steel',
  otel: 'steel',
  стомана: 'steel',
  стоманен: 'steel',
  stainless: 'stainless',
  inox: 'stainless',
  неръждаем: 'stainless',
  edelstahl: 'stainless',
  galvanized: 'galvanised',
  galvanised: 'galvanised',
  verzinkt: 'galvanised',
  поцинкован: 'galvanised',
  zincat: 'galvanised',
  brass: 'brass',
  messing: 'brass',
  месинг: 'brass',
  laiton: 'brass',
  copper: 'copper',
  kupfer: 'copper',
  мед: 'copper',
  меден: 'copper',
  aluminium: 'aluminium',
  aluminum: 'aluminium',
  alu: 'aluminium',
  алуминий: 'aluminium',
  алуминиев: 'aluminium',
  plastic: 'plastic',
  kunststoff: 'plastic',
  пластмаса: 'plastic',
  пластмасов: 'plastic',
  pvc: 'pvc',
  'pvc-u': 'pvc',
  pvcu: 'pvc',
  upvc: 'pvc',
  пвц: 'pvc',
  pe: 'pe',
  hdpe: 'pe',
  ldpe: 'pe',
  pp: 'pp',
  ppr: 'ppr',
  pex: 'pex',
  wood: 'wood',
  holz: 'wood',
  дърво: 'wood',
  дървен: 'wood',
  lemn: 'wood',
  glass: 'glass',
  glas: 'glass',
  стъкло: 'glass',
  стъклен: 'glass',
  rubber: 'rubber',
  gummi: 'rubber',
  гума: 'rubber',
  гумен: 'rubber',
  ceramic: 'ceramic',
  керамика: 'ceramic',
  керамичен: 'ceramic',
  paper: 'paper',
  papier: 'paper',
  хартия: 'paper',
  хартиен: 'paper',
  cotton: 'cotton',
  памук: 'cotton',
  baumwolle: 'cotton',
  chrome: 'chrome',
  chrom: 'chrome',
  хром: 'chrome',
  хромиран: 'chrome',
  nickel: 'nickel',
  никел: 'nickel',
  satin: 'satin',
  сатен: 'satin',
  matt: 'matt',
  мат: 'matt',
  gloss: 'gloss',
  гланц: 'gloss',
};

/**
 * Where on the machine the part goes.
 *
 * Compatibility rather than identity: a front brake pad and a rear brake pad
 * are different articles, but a listing that omits the position has not
 * contradicted anything.
 */
export const POSITIONS: Record<string, string> = {
  front: 'front',
  vorne: 'front',
  avant: 'front',
  fata: 'front',
  предна: 'front',
  преден: 'front',
  rear: 'rear',
  back: 'rear',
  hinten: 'rear',
  arriere: 'rear',
  spate: 'rear',
  задна: 'rear',
  заден: 'rear',
  left: 'left',
  links: 'left',
  gauche: 'left',
  stanga: 'left',
  ляв: 'left',
  лява: 'left',
  right: 'right',
  rechts: 'right',
  droite: 'right',
  dreapta: 'right',
  десен: 'right',
  дясна: 'right',
  upper: 'upper',
  top: 'upper',
  горен: 'upper',
  lower: 'lower',
  bottom: 'lower',
  долен: 'lower',
  inner: 'inner',
  вътрешен: 'inner',
  outer: 'outer',
  външен: 'outer',
  axle: 'axle',
  ос: 'axle',
  мост: 'axle',
};

/**
 * Cross-lingual names for the same kind of thing.
 *
 * Deliberately short, and deliberately *not* a category system. Its only job
 * is to let a Bulgarian query find a German listing: "крушка" and "Lampe" are
 * filed under one canonical name so that agreeing on the kind of article
 * counts as agreement. A word missing from this table is not a failure — the
 * type then compares as itself, stemmed, which is what makes the engine work
 * for industries nobody has written a row for.
 */
export const TYPE_SYNONYMS: Record<string, string> = {
  bulb: 'bulb',
  lamp: 'bulb',
  lampe: 'bulb',
  ampoule: 'bulb',
  bombilla: 'bulb',
  lampada: 'bulb',
  крушка: 'bulb',
  лампа: 'bulb',
  becuri: 'bulb',
  bec: 'bulb',
  λάμπα: 'bulb',
  cable: 'cable',
  wire: 'cable',
  kabel: 'cable',
  cablu: 'cable',
  кабел: 'cable',
  проводник: 'cable',
  καλώδιο: 'cable',
  laptop: 'laptop',
  notebook: 'laptop',
  ultrabook: 'laptop',
  лаптоп: 'laptop',
  portabil: 'laptop',
  phone: 'phone',
  smartphone: 'phone',
  handy: 'phone',
  telefon: 'phone',
  телефон: 'phone',
  смартфон: 'phone',
  monitor: 'monitor',
  bildschirm: 'monitor',
  монитор: 'monitor',
  οθόνη: 'monitor',
  tv: 'tv',
  television: 'tv',
  fernseher: 'tv',
  televizor: 'tv',
  телевизор: 'tv',
  breaker: 'breaker',
  mcb: 'breaker',
  rcd: 'breaker',
  rcbo: 'breaker',
  fuse: 'breaker',
  schutzschalter: 'breaker',
  прекъсвач: 'breaker',
  предпазител: 'breaker',
  автомат: 'breaker',
  siguranta: 'breaker',
  pipe: 'pipe',
  tube: 'pipe',
  rohr: 'pipe',
  teava: 'pipe',
  țeavă: 'pipe',
  тръба: 'pipe',
  σωλήνας: 'pipe',
  charger: 'charger',
  ladegerat: 'charger',
  ladegerät: 'charger',
  incarcator: 'charger',
  зарядно: 'charger',
  cup: 'cup',
  becher: 'cup',
  pahar: 'cup',
  чаша: 'cup',
  ποτήρι: 'cup',
  paper: 'paper',
  papier: 'paper',
  hartie: 'paper',
  хартия: 'paper',
  χαρτί: 'paper',
  bolt: 'bolt',
  screw: 'bolt',
  schraube: 'bolt',
  surub: 'bolt',
  șurub: 'bolt',
  болт: 'bolt',
  винт: 'bolt',
  'brake pad': 'brake_pad',
  bremsbelag: 'brake_pad',
  placute: 'brake_pad',
  накладки: 'brake_pad',
  drill: 'drill',
  bohrmaschine: 'drill',
  perceuse: 'drill',
  бормашина: 'drill',
  chair: 'chair',
  stuhl: 'chair',
  scaun: 'chair',
  стол: 'chair',
};

/**
 * Words that describe nothing and identify nobody.
 *
 * Dropped before the head noun is chosen, so "Set of 4 new PVC pipes" is a
 * pipe rather than a set.
 */
export const NOISE_WORDS = new Set([
  'the',
  'and',
  'with',
  'for',
  'of',
  'new',
  'original',
  'genuine',
  'quality',
  'professional',
  'premium',
  'и',
  'за',
  'с',
  'от',
  'на',
  'нов',
  'нова',
  'ново',
  'оригинален',
  'качествен',
  'професионален',
  'und',
  'mit',
  'für',
  'neu',
  'et',
  'avec',
  'pour',
  'neuf',
  'nou',
  'pentru',
  'cu',
]);

/**
 * Latin technical terms as they get typed in Cyrillic.
 *
 * Kept short on purpose: transliterating the whole alphabet would rewrite
 * ordinary Bulgarian words too. These are borrowed acronyms that only ever
 * mean the Latin thing.
 */
export const BORROWED_TERMS: Record<string, string> = {
  лед: 'led',
  олед: 'oled',
  лцд: 'lcd',
  тв: 'tv',
  юсб: 'usb',
  хдми: 'hdmi',
  ссд: 'ssd',
  хдд: 'hdd',
  лан: 'lan',
  смарт: 'smart',
  пвц: 'pvc',
  пвх: 'pvc',
};

/**
 * Manufacturers we are sure about.
 *
 * Not the only way a brand is found — see `extraction.ts`, which will infer an
 * unlisted one from position and shape — but the only way a brand becomes hard
 * evidence. An *inferred* brand disagreeing is a doubt; a *known* brand
 * disagreeing is a different article.
 */
export const KNOWN_BRANDS = [
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
  'bmw',
  'audi',
  'volkswagen',
  'vw',
  'mercedes',
  'opel',
  'ford',
  'renault',
  'peugeot',
  'toyota',
  'skoda',
  'fiat',
  'nissan',
  'honda',
  'mazda',
  'hyundai',
  'kia',
  'volvo',
  'brembo',
  'bilstein',
  'wavin',
  'pestan',
  'rehau',
  'geberit',
  'grohe',
  'hansgrohe',
  'viega',
  'uponor',
  'canon',
  'epson',
  'brother',
  'xerox',
  'mondi',
  'navigator',
  'double a',
  'lyreco',
  'tork',
  'katrin',
  'duni',
  'huhtamaki',
];

/**
 * Ranges and lines people type instead of the manufacturer.
 *
 * Never treated as brands: "Galaxy S24" and "Samsung Galaxy S24" are one
 * phone, and reading the range as a rival maker would reject the pair on a
 * conflict that does not exist.
 */
export const PRODUCT_FAMILIES = [
  'iphone',
  'ipad',
  'macbook',
  'galaxy',
  'thinkpad',
  'ideapad',
  'latitude',
  'inspiron',
  'corepro',
  'pixel',
  'elitebook',
  'probook',
  'vostro',
  'aspire',
  'nitro',
  'zenbook',
  'vivobook',
];

/**
 * What a concept's number means when the supplier wrote no unit at all.
 *
 * "512 SSD" and "DN50" state a quantity and trust the reader to know the unit,
 * because within a trade everybody does. Filling it in here is what lets
 * "Lenovo laptop 16GB 512 SSD" meet "512 GB NVMe" — and it is a property of
 * the concept, not of laptops, so it costs no category rule.
 */
export const DEFAULT_UNITS: Record<string, string> = {
  ram: 'GB',
  storage: 'GB',
  diameter: 'mm',
  thickness: 'mm',
  length: 'mm',
  width: 'mm',
  height: 'mm',
  depth: 'mm',
  grammage: 'g/m²',
  package_quantity: 'pcs',
  screen: '"',
  colour_temperature: 'K',
  cross_section: 'mm²',
};

/**
 * What each attribute is called in the language the interface speaks.
 *
 * The concepts above are named in English because the API, the Swagger page
 * and the search debugger are English. The product is not: a buyer reading why
 * two listings matched reads "Мощност", not "Power". Keeping the two apart
 * here means neither has to compromise, and a third language is a third table
 * rather than a rewrite.
 */
export const BULGARIAN_LABELS: Record<string, string> = {
  ram: 'Памет (RAM)',
  storage: 'Диск',
  capacity: 'Обем',
  battery: 'Батерия',
  length: 'Дължина',
  width: 'Ширина',
  height: 'Височина',
  depth: 'Дълбочина',
  diameter: 'Диаметър',
  thickness: 'Дебелина',
  cross_section: 'Сечение',
  dimensions: 'Размери',
  screen: 'Екран',
  power: 'Мощност',
  voltage: 'Напрежение',
  current: 'Ток',
  colour_temperature: 'Цветна температура',
  luminous_flux: 'Светлинен поток',
  frequency: 'Честота',
  refresh_rate: 'Опресняване',
  cpu: 'Процесор',
  pressure: 'Налягане',
  torque: 'Въртящ момент',
  rotation: 'Обороти',
  weight: 'Тегло',
  grammage: 'Грамаж',
  temperature_rating: 'Температура',
  package_quantity: 'Опаковка',
  warranty: 'Гаранция',
  model_year: 'Година',
  socket: 'Фасунга',
  connector: 'Конектор',
  protection: 'Защита',
  thread: 'Резба',
  paper_format: 'Формат',
  resolution: 'Резолюция',
  efficiency: 'Клас',
  breaker_curve: 'Характеристика',
  standard: 'Стандарт',
  colour: 'Цвят',
  material: 'Материал',
  position: 'Позиция',
  brand: 'Марка',
  type: 'Вид',
  family: 'Серия',
  model: 'Модел',
  gtin: 'Баркод',
  sku: 'Артикулен номер',
  fits: 'Съвместим с',
  // Dimensions an unlabelled number falls back to.
  data: 'Памет',
  volume: 'Обем',
  mass: 'Тегло',
  area: 'Площ',
  energy: 'Енергия',
  time: 'Време',
  speed: 'Скорост',
  angle: 'Ъгъл',
  count: 'Брой',
  density: 'Плътност',
  resistance: 'Съпротивление',
  temperature: 'Температура',
};

/** The Bulgarian name for an attribute, or the English one where none exists. */
export function displayLabel(key: string, fallback: string): string {
  return BULGARIAN_LABELS[key] ?? fallback;
}
