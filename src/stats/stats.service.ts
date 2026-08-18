import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Competitor } from '../products/entities/competitor.entity';
import { PriceHistory } from '../products/entities/price-history.entity';
import { Product } from '../products/entities/product.entity';
import { ScrapeStatus } from '../products/enums/scrape-status.enum';
import { Shop } from '../shops/entities/shop.entity';
import { PublicStatsDto } from './dto/public-stats.dto';

/** How long a computed snapshot is served before it is counted again. */
const CACHE_TTL_MS = 60_000;

/**
 * The counters behind the landing page.
 *
 * Unauthenticated, so the cost per request matters more than freshness: five
 * `COUNT(*)`s on every page view is a free denial-of-service against your own
 * database. A minute-old number is indistinguishable from a live one to a
 * reader, so the snapshot is cached for a minute and shared by everyone.
 */
@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);
  private cached: { at: number; value: PublicStatsDto } | null = null;

  constructor(
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
    @InjectRepository(Product) private readonly products: Repository<Product>,
    @InjectRepository(Competitor) private readonly competitors: Repository<Competitor>,
    @InjectRepository(PriceHistory) private readonly history: Repository<PriceHistory>,
  ) {}

  async snapshot(): Promise<PublicStatsDto> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) {
      return this.cached.value;
    }

    const value = await this.count();
    this.cached = { at: Date.now(), value };
    return value;
  }

  private async count(): Promise<PublicStatsDto> {
    const [shops, offlineShops, products, listings, priceMovements, checked, succeeded, latest] =
      await Promise.all([
        this.shops.count({ where: { isActive: true } }),
        this.shops.count({ where: { isActive: true, hasWebsite: false } }),
        this.products.count(),
        this.competitors.count({ where: { isActive: true } }),
        this.history.count(),
        // Pending listings are excluded from both sides of the ratio: a listing
        // that has never been checked has neither succeeded nor failed, and
        // counting it as a failure would punish us for a queue.
        this.competitors.count({
          where: { isActive: true, scrapeStatus: In([ScrapeStatus.Success, ScrapeStatus.Failed]) },
        }),
        this.competitors.count({ where: { isActive: true, scrapeStatus: ScrapeStatus.Success } }),
        this.competitors.findOne({
          where: { isActive: true },
          order: { lastCheckedAt: 'DESC' },
          select: { id: true, lastCheckedAt: true },
        }),
      ]);

    return {
      shops,
      offlineShops,
      products,
      listings,
      priceMovements,
      successRate: checked > 0 ? Math.round((succeeded / checked) * 1000) / 10 : null,
      lastCheckAt: latest?.lastCheckedAt ? latest.lastCheckedAt.toISOString() : null,
    };
  }
}
