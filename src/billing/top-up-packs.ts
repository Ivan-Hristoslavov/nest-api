/**
 * Reads `TOPUP_PRICE_IDS` — `pri_abc:1000,pri_def:5000`.
 *
 * A top-up and a subscription arrive at the webhook as the same thing: a
 * completed payment. The only way to tell them apart is the price that was
 * paid for, so this maps those ids to what each one buys. An id that is not
 * listed is not a top-up, which is the safe default: crediting comparisons
 * for an unrecognised purchase is worse than not crediting them.
 */
export function parseTopUpPacks(raw: string | undefined): Record<string, number> {
  if (!raw) return {};

  const packs: Record<string, number> = {};

  for (const entry of raw.split(',')) {
    const [id, value] = entry.split(':').map((part) => part?.trim());
    const count = Number(value);

    if (!id || !Number.isInteger(count) || count <= 0) continue;
    packs[id] = count;
  }

  return packs;
}
