/**
 * Why a match scored what it scored, in parts a buyer can read.
 *
 * The confidence a search returns is deterministic — it comes from a ladder of
 * evidence, not from a model — but a single number is still opaque, and "94 %"
 * is not an answer to "why is this the same cable". A purchasing decision made
 * on a number nobody can take apart is a decision made on trust alone, which
 * is exactly what a wholesale buyer does not extend to software.
 *
 * So the verdict is decomposed. The components below are derived from the same
 * comparisons the verdict was reached on, which means they cannot drift from
 * it: there is one decision, presented two ways.
 *
 * Weights are here rather than scattered, so tuning is one file and one test.
 */

import { AttributeRole } from './lexicon';
import { MatchVerdict } from './deterministic-matcher';

/** One line of the reason a result scored what it did. */
export interface ScoreComponent {
  key: string;
  /** What this dimension is called, in the language the interface speaks. */
  label: string;
  /** How much this dimension can contribute, 0–1. */
  weight: number;
  /** How well it did, 0–1. */
  value: number;
  /** Naming what was actually compared, when there is something to name. */
  detail: string;
  status: 'match' | 'missing' | 'conflict';
}

export interface ScoreBreakdown {
  /** The weighted total, 0–1. Reported beside the verdict, never instead of it. */
  score: number;
  components: ScoreComponent[];
  /** One sentence a buyer reads before opening anything. */
  headline: string;
}

/**
 * What each dimension is worth.
 *
 * An identifier outweighs everything because it *is* the article. The
 * specification comes next, because it is what a buyer typed. Text similarity
 * is worth least on purpose: two listings sharing vocabulary is the weakest
 * evidence in this domain and the easiest to fake, and ranking on it is the
 * mistake this whole subsystem exists to avoid.
 */
export interface ScoreWeights {
  identifier: number;
  specification: number;
  productType: number;
  brand: number;
  variant: number;
  text: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  identifier: 0.3,
  specification: 0.35,
  productType: 0.12,
  brand: 0.1,
  variant: 0.05,
  text: 0.08,
};

const LABELS: Record<keyof ScoreWeights, string> = {
  identifier: 'Баркод или модел',
  specification: 'Спецификация',
  productType: 'Вид артикул',
  brand: 'Марка',
  variant: 'Вариант',
  text: 'Име',
};

/** Roles whose agreement counts towards the specification component. */
const SPEC_ROLES = new Set<AttributeRole>(['identity', 'compatibility']);

/**
 * Takes a verdict apart.
 *
 * Reads the comparisons the verdict already carries rather than comparing
 * anything again — a second reading is a second opinion waiting to disagree
 * with the first in front of a customer.
 */
export function explainScore(
  verdict: MatchVerdict,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreBreakdown {
  const components: ScoreComponent[] = [];

  const spec = (entries: typeof verdict.matchedAttributes) =>
    entries.filter(
      (entry) => SPEC_ROLES.has(entry.role) && entry.key !== 'brand' && entry.key !== 'type',
    );

  const agreed = spec(verdict.matchedAttributes);
  const unstated = spec(verdict.missingAttributes).filter((entry) => entry.query !== null);
  const clashed = spec(verdict.conflicts);

  // --- what identifies the article outright -------------------------------
  const identifier =
    verdict.method === 'gtin'
      ? 1
      : verdict.method === 'sku'
        ? 0.95
        : verdict.method === 'model'
          ? 0.8
          : 0;

  components.push({
    key: 'identifier',
    label: LABELS.identifier,
    weight: weights.identifier,
    value: identifier,
    detail:
      verdict.method === 'gtin'
        ? 'един и същ баркод'
        : verdict.method === 'sku'
          ? 'един и същ артикулен номер'
          : verdict.method === 'model'
            ? 'един и същ моделен код'
            : 'няма общ код',
    status: identifier > 0 ? 'match' : 'missing',
  });

  // --- the specification the buyer typed ----------------------------------
  //
  // Coverage, not count: what matters is whether everything asked for is
  // answered, which is also how the matcher itself decides.
  const asked = agreed.length + unstated.length + clashed.length;
  const specValue = clashed.length > 0 ? 0 : asked === 0 ? 0 : agreed.length / asked;

  components.push({
    key: 'specification',
    label: LABELS.specification,
    weight: weights.specification,
    value: specValue,
    detail:
      clashed.length > 0
        ? clashed.map((entry) => `${entry.label}: ${entry.query} ≠ ${entry.candidate}`).join(', ')
        : asked === 0
          ? 'не е посочена'
          : agreed.map((entry) => entry.label.toLowerCase()).join(', ') +
            (unstated.length > 0
              ? ` · неупоменато: ${unstated.map((entry) => entry.label.toLowerCase()).join(', ')}`
              : ''),
    status:
      clashed.length > 0
        ? 'conflict'
        : unstated.length > 0
          ? 'missing'
          : asked > 0
            ? 'match'
            : 'missing',
  });

  components.push(named(verdict, 'type', 'productType', weights.productType, LABELS.productType));
  components.push(named(verdict, 'brand', 'brand', weights.brand, LABELS.brand));

  // --- variants: colour, finish, pack -------------------------------------
  const variantAgreed = verdict.matchedAttributes.filter(
    (entry) => entry.role === 'variant' || entry.role === 'package',
  );
  const variantClash = verdict.conflicts.filter(
    (entry) => entry.role === 'variant' || entry.role === 'package',
  );

  components.push({
    key: 'variant',
    label: LABELS.variant,
    weight: weights.variant,
    value: variantClash.length > 0 ? 0 : variantAgreed.length > 0 ? 1 : 0.5,
    detail:
      variantClash.length > 0
        ? variantClash
            .map((entry) => `${entry.label}: ${entry.query} ≠ ${entry.candidate}`)
            .join(', ')
        : variantAgreed.length > 0
          ? variantAgreed.map((entry) => entry.label.toLowerCase()).join(', ')
          : 'няма посочен',
    status: variantClash.length > 0 ? 'conflict' : variantAgreed.length > 0 ? 'match' : 'missing',
  });

  // --- the words themselves, worth least ----------------------------------
  components.push({
    key: 'text',
    label: LABELS.text,
    weight: weights.text,
    value: verdict.method === 'text' ? Math.min(1, verdict.confidence / 0.84) : 0.6,
    detail: 'сходство по описание',
    status: 'match',
  });

  const total = components.reduce((sum, component) => sum + component.weight * component.value, 0);
  const possible = components.reduce((sum, component) => sum + component.weight, 0);

  return {
    score: verdict.blocked ? 0 : Math.round((total / possible) * 100) / 100,
    components,
    headline: headlineFor(verdict, agreed.length, unstated.length, clashed.length),
  };
}

function named(
  verdict: MatchVerdict,
  key: string,
  component: keyof ScoreWeights,
  weight: number,
  label: string,
): ScoreComponent {
  const match = verdict.matchedAttributes.find((entry) => entry.key === key);
  const clash = verdict.conflicts.find((entry) => entry.key === key);
  const absent = verdict.missingAttributes.find((entry) => entry.key === key);

  return {
    key: component,
    label,
    weight,
    value: clash ? 0 : match ? 1 : 0.5,
    detail: clash
      ? `${clash.query} ≠ ${clash.candidate}`
      : match
        ? String(match.candidate ?? match.query ?? '')
        : absent
          ? 'не е посочена'
          : 'не е посочена',
    status: clash ? 'conflict' : match ? 'match' : 'missing',
  };
}

/**
 * The one sentence shown before anything is opened.
 *
 * Written for somebody deciding where to place an order, not for somebody
 * debugging a matcher: what agreed, or what did not, and nothing else.
 */
function headlineFor(
  verdict: MatchVerdict,
  agreed: number,
  unstated: number,
  clashed: number,
): string {
  if (clashed > 0) {
    const first = verdict.conflicts[0];
    return first
      ? `Различни са: ${first.label.toLowerCase()} — ${first.query} срещу ${first.candidate}.`
      : 'Различна спецификация.';
  }

  if (verdict.method === 'gtin') return 'Един и същ баркод.';
  if (verdict.method === 'sku') return 'Един и същ артикулен номер.';
  if (verdict.method === 'model') return 'Един и същ моделен код.';

  if (agreed > 0 && unstated === 0) return 'Съвпада по всичко, което поискахте.';
  if (agreed > 0) return `Съвпада по ${agreed}, ${unstated} не е упоменато от магазина.`;

  return 'Съвпада по описание.';
}
