import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { normaliseProductName, tokensOf } from '../matching/normalisation';
import { ManualPrice } from './entities/manual-price.entity';
import { Shop } from './entities/shop.entity';

/** One row of a supplier's price list, as the buyer typed or imported it. */
export interface ManualPriceInput {
  name: string;
  price: number;
  shopCode?: string | null;
  currency?: string;
  unit?: string | null;
  note?: string | null;
}

/**
 * Prices for the suppliers that cannot be read.
 *
 * A buyer's cheapest source is frequently the one with no website at all. This
 * holds what they know about those suppliers, so the comparison covers their
 * real list rather than the subset that happens to be online.
 *
 * Matching is a plain substring search over a few hundred rows per shop, folded
 * through the same Cyrillic/Latin homoglyphs as everything else: a buyer types
 * "свт 3x2.5" and the supplier's list says "КАБЕЛ СВТ 3x2.5". Nothing cleverer
 * is warranted — these lists are short, and a wrong guess here is as damaging
 * as a wrong scrape.
 */
@Injectable()
export class ManualPricesService {
  private readonly logger = new Logger(ManualPricesService.name);

  constructor(
    @InjectRepository(ManualPrice) private readonly prices: Repository<ManualPrice>,
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
  ) {}

  /** Every row of one supplier's list, newest change first. */
  async findForShop(ownerId: string, shopId: string): Promise<ManualPrice[]> {
    await this.assertShop(ownerId, shopId);

    return this.prices.find({ where: { shopId }, order: { name: 'ASC' } });
  }

  /**
   * Rows of this supplier's list worth putting in front of the matcher.
   *
   * This used to demand every word, which was right when it was the only
   * filter and wrong now that one follows it. A supplier who writes "Philips
   * CorePro 840 неутрална светлина" for the bulb somebody searched for as
   * "Philips LED 12W E27 4000K" shares exactly one word, so requiring all of
   * them meant that supplier was never even considered — and the matcher,
   * whose entire job is to recognise that pair, never saw it.
   *
   * So retrieval is broad and ranking is not: rows are kept if they share any
   * word, ordered by how many they share, and cut to `limit`. Deciding which
   * of them is actually the same article happens downstream, where it can be
   * done properly and explained.
   */
  async search(shopId: string, query: string, limit = 8): Promise<ManualPrice[]> {
    // The matcher's own tokeniser: it folds homoglyphs, canonicalises units so
    // "12 вата" finds "12W", and drops the filler words that would otherwise
    // match every row on the list.
    const words = tokensOf(query);

    if (words.length === 0) return [];

    const rows = await this.prices.find({ where: { shopId } });

    return rows
      .map((row) => {
        const haystack = normaliseProductName(`${row.name} ${row.shopCode ?? ''}`);
        const shared = words.filter((word) => haystack.includes(word)).length;
        return { row, shared };
      })
      .filter((entry) => entry.shared > 0)
      .sort((a, b) => b.shared - a.shared || a.row.name.localeCompare(b.row.name))
      .slice(0, limit)
      .map((entry) => entry.row);
  }

  /**
   * Replaces one row, or adds it.
   *
   * Keyed on the supplier's own article number where the list states one, and
   * on the name otherwise — re-importing a price list must update the rows it
   * already has rather than double every article.
   */
  async upsert(ownerId: string, shopId: string, input: ManualPriceInput): Promise<ManualPrice> {
    await this.assertShop(ownerId, shopId);

    const existing = input.shopCode
      ? await this.prices.findOne({ where: { shopId, shopCode: input.shopCode } })
      : await this.prices.findOne({ where: { shopId, name: input.name } });

    const row = existing ?? this.prices.create({ shopId });

    row.name = input.name;
    row.shopCode = input.shopCode ?? null;
    row.price = input.price;
    row.currency = (input.currency ?? 'EUR').toUpperCase();
    row.unit = input.unit ?? null;
    row.note = input.note ?? null;

    return this.prices.save(row);
  }

  /**
   * Imports a whole price list.
   *
   * How these suppliers actually deliver prices: an Excel sheet by email, once
   * a quarter. Typing four hundred rows by hand is how a good idea stops being
   * used in week two.
   */
  async importList(
    ownerId: string,
    shopId: string,
    rows: ManualPriceInput[],
  ): Promise<{ imported: number; updated: number; failed: number; problems: string[] }> {
    await this.assertShop(ownerId, shopId);

    let imported = 0;
    let updated = 0;
    let failed = 0;
    const problems: string[] = [];

    for (const [index, row] of rows.entries()) {
      try {
        const existed = row.shopCode
          ? await this.prices.exists({ where: { shopId, shopCode: row.shopCode } })
          : await this.prices.exists({ where: { shopId, name: row.name } });

        await this.upsert(ownerId, shopId, row);
        if (existed) updated += 1;
        else imported += 1;
      } catch (error) {
        failed += 1;
        if (problems.length < 5) {
          problems.push(
            `ред ${index + 1} ("${row.name?.slice(0, 40) ?? ''}"): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    this.logger.log(
      `Shop ${shopId}: imported ${imported}, updated ${updated}, failed ${failed} manual prices`,
    );

    return { imported, updated, failed, problems };
  }

  async remove(ownerId: string, shopId: string, id: string): Promise<void> {
    await this.assertShop(ownerId, shopId);

    const result = await this.prices.delete({ id, shopId });
    if (!result.affected) throw new NotFoundException(`Няма такъв ред с id "${id}".`);
  }

  /** Proves the supplier belongs to this account; rows inherit that. */
  private async assertShop(ownerId: string, shopId: string): Promise<void> {
    const exists = await this.shops.exists({ where: { id: shopId, ownerId } });
    if (!exists) throw new NotFoundException(`Няма магазин с id "${shopId}".`);
  }
}

// The homoglyph table that used to live here now has one home, in the
// matcher's normaliser, which this searches through.
