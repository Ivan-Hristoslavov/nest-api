import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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

  constructor(@InjectRepository(Shop) private readonly shops: Repository<Shop>) {}

  findAll(): Promise<Shop[]> {
    return this.shops.find({ order: { name: 'ASC' } });
  }

  async findOne(id: string): Promise<Shop> {
    const shop = await this.shops.findOne({ where: { id } });
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
  async create(input: {
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
  }): Promise<Shop> {
    const host = normaliseHost(input.host);

    const existing = await this.shops.findOne({ where: { host } });
    const shop = existing ?? this.shops.create({ host });

    shop.name = input.name ?? existing?.name ?? host;
    shop.discountPercent = input.discountPercent ?? existing?.discountPercent ?? 0;
    shop.currency = input.currency ?? existing?.currency ?? 'EUR';
    shop.isActive = true;

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

  async update(id: string, changes: Partial<Shop>): Promise<Shop> {
    const shop = await this.findOne(id);
    Object.assign(shop, changes);
    return this.shops.save(shop);
  }

  async remove(id: string): Promise<void> {
    const shop = await this.findOne(id);
    await this.shops.remove(shop);
    this.logger.log(`Shop ${shop.host} removed.`);
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
