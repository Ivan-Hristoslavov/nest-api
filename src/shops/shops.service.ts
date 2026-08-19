import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ProbeResult } from '../discovery/shop-probe.service';
import { ManualPrice } from './entities/manual-price.entity';
import { Shop } from './entities/shop.entity';

/**
 * The supplier list.
 *
 * All this holds is who your suppliers are, what you pay them relative to
 * their shelf price, and how to phrase a search at each one. No copy of
 * anyone's catalogue: prices are read at the moment they are asked for, by
 * {@link DiscoveryService}.
 */
@Injectable()
export class ShopsService {
  private readonly logger = new Logger(ShopsService.name);

  constructor(
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
    @InjectRepository(ManualPrice) private readonly manualPrices: Repository<ManualPrice>,
  ) {}

  findAll(ownerId: string): Promise<Shop[]> {
    return this.shops.find({ where: { ownerId }, order: { name: 'ASC' } });
  }

  /**
   * One supplier of this account.
   *
   * A shop belonging to somebody else is reported as missing rather than
   * forbidden: "not found" and "not yours" are the same fact to a caller who
   * is not entitled to know the row exists, and the difference between the two
   * answers is itself a way to enumerate other customers' suppliers.
   */
  async findOne(ownerId: string, id: string): Promise<Shop> {
    const shop = await this.shops.findOne({ where: { id, ownerId } });
    if (!shop) throw new NotFoundException(`Няма магазин с id "${id}".`);
    return shop;
  }

  /**
   * Registers a supplier.
   *
   * The host is normalised without `www.` so the same shop cannot be added
   * twice under two spellings and then compared against itself. A subdomain is
   * *not* stripped — `bg.elmarkstore.eu` and `elmarkstore.eu` are different
   * storefronts with different catalogues and, often, different prices.
   */
  async create(
    ownerId: string,
    input: {
      host: string;
      name?: string;
      discountPercent?: number;
      currency?: string;
      searchUrlTemplate?: string;
      searchResultSelector?: string;
      searchTileSelector?: string;
      searchTitleSelector?: string;
      searchPriceSelector?: string;
      searchConfidence?: number;
      hasWebsite?: boolean;
    },
  ): Promise<Shop> {
    const host = normaliseHost(input.host);

    const existing = await this.shops.findOne({ where: { host, ownerId } });
    const shop = existing ?? this.shops.create({ host, ownerId });

    shop.name = input.name ?? existing?.name ?? host;
    shop.discountPercent = input.discountPercent ?? existing?.discountPercent ?? 0;
    shop.currency = input.currency ?? existing?.currency ?? 'EUR';
    shop.isActive = true;

    if (input.hasWebsite === false) {
      shop.hasWebsite = false;
      // Says what it is rather than "не може да се търси": this supplier is
      // searched, just from what you told us rather than from their site.
      shop.searchMethod = 'manual';
      shop.searchSummary =
        'Няма сайт — търси се в цените, които вие сте въвели. Качете ценоразписа му.';
      shop.searchBlockedReason = null;
    }

    if (input.searchUrlTemplate !== undefined) {
      shop.searchUrlTemplate = input.searchUrlTemplate;
      shop.searchResultSelector = input.searchResultSelector ?? null;
      shop.searchTileSelector = input.searchTileSelector ?? null;
      shop.searchTitleSelector = input.searchTitleSelector ?? null;
      shop.searchPriceSelector = input.searchPriceSelector ?? null;
      shop.searchConfidence = input.searchConfidence ?? null;
      // A shop that can now be searched is no longer blocked, whatever it was
      // marked as before.
      shop.searchBlockedReason = null;
    }

    const saved = await this.shops.save(shop);
    this.logger.log(
      `Shop ${saved.host} ready (live search: ${saved.searchUrlTemplate ? 'configured' : 'not configured'})`,
    );
    return saved;
  }

  /**
   * Records how the probe decided this shop will be searched.
   *
   * The detected configuration is saved along with the verdict, so a shop that
   * probed as live-searchable is searchable from that moment without a second
   * round trip to work out its selectors again.
   */
  async applyProbe(ownerId: string, id: string, result: ProbeResult): Promise<Shop> {
    const shop = await this.findOne(ownerId, id);

    shop.searchMethod = result.method;
    shop.searchSummary = result.summary;
    shop.searchBlockedReason = result.reason;

    if (result.detected) {
      shop.searchUrlTemplate = result.detected.urlTemplate;
      shop.searchResultSelector = result.detected.linkSelector;
      shop.searchTileSelector = result.detected.tileSelector;
      shop.searchTitleSelector = result.detected.titleSelector;
      shop.searchPriceSelector = result.detected.priceSelector;
      shop.searchConfidence = result.detected.confidence;
    }

    this.logger.log(`${shop.host}: search method is "${result.method}" — ${result.summary}`);

    return this.shops.save(shop);
  }

  async update(ownerId: string, id: string, changes: Partial<Shop>): Promise<Shop> {
    const shop = await this.findOne(ownerId, id);
    // The owner is never taken from the payload: accepting it there would let
    // a caller move their row into somebody else's account.
    delete changes.ownerId;
    Object.assign(shop, changes);
    return this.shops.save(shop);
  }

  /**
   * Removes a supplier and the prices entered by hand against it.
   *
   * For a supplier with no website that list *is* the data — typed off a
   * price sheet, and retypeable only from that sheet. Losing it silently
   * because somebody removed the wrong row is not recoverable by re-reading
   * anything.
   */
  async remove(ownerId: string, id: string, purge = false): Promise<void> {
    const shop = await this.findOne(ownerId, id);
    const prices = await this.manualPrices.count({ where: { shopId: id } });

    if (prices > 0 && !purge) {
      throw new ConflictException(
        `„${shop.name}" носи ${prices} ръчно въведени цени, които не могат да бъдат прочетени отново. ` +
          'Повторете заявката с ?purge=true, ако наистина искате да ги загубите.',
      );
    }

    await this.shops.remove(shop);

    this.logger.warn(
      `Account ${ownerId} removed shop ${shop.host} ("${shop.name}") with ${prices} manual prices.`,
    );
  }
}

/** Lowercase, no protocol, no path, no `www.` — but subdomains preserved. */
export function normaliseHost(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .split(':')[0]
    .toLowerCase();
}
