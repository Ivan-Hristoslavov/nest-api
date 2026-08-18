import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Competitor } from '../products/entities/competitor.entity';
import { PriceHistory } from '../products/entities/price-history.entity';
import { Product } from '../products/entities/product.entity';
import { ProductsService } from '../products/products.service';
import {
  CompetitorBreakdownDto,
  MarketOverviewDto,
  PricePointDto,
  ProductAnalyticsDto,
  PriceTrend,
} from './dto/product-analytics.dto';

/** A change smaller than this (in percent) counts as "flat", not a trend. */
const TREND_DEADBAND_PERCENT = 1;

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(PriceHistory)
    private readonly priceHistoryRepository: Repository<PriceHistory>,
    @InjectRepository(Competitor)
    private readonly competitorsRepository: Repository<Competitor>,
    private readonly productsService: ProductsService,
  ) {}

  /**
   * Price behaviour of one product over the last `days` days.
   *
   * The series is what makes this useful: `min`/`max`/`avg` say how volatile a
   * rival is, the trend says which way it is moving, and the per-competitor
   * breakdown says who is actually setting the market price.
   */
  async forProduct(ownerId: string, productId: string, days: number): Promise<ProductAnalyticsDto> {
    const product = await this.productsService.findOne(ownerId, productId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const history = await this.priceHistoryRepository
      .createQueryBuilder('history')
      .where('history.product_id = :productId', { productId })
      .andWhere('history.recorded_at >= :since', { since })
      .orderBy('history.recorded_at', 'ASC')
      .getMany();

    const competitors = await this.competitorsRepository.find({ where: { productId } });

    const prices = history.map((point) => point.price);
    const first = prices.at(0) ?? null;
    const last = prices.at(-1) ?? product.currentPrice;

    const changePercent =
      first !== null && first !== 0 && last !== null
        ? this.round(((last - first) / first) * 100, 2)
        : null;

    return {
      productId: product.id,
      productName: product.name,
      currency: product.currency,
      periodDays: days,
      from: since.toISOString(),
      to: new Date().toISOString(),
      dataPoints: history.length,
      currentPrice: product.currentPrice,
      ourPrice: product.ourPrice,
      targetPrice: product.targetPrice,
      minPrice: prices.length > 0 ? this.round(Math.min(...prices)) : null,
      maxPrice: prices.length > 0 ? this.round(Math.max(...prices)) : null,
      averagePrice: prices.length > 0 ? this.round(this.mean(prices)) : null,
      volatilityPercent: this.volatility(prices),
      changePercent,
      trend: this.trendFrom(changePercent),
      changeCount: history.length,
      allTimeLow: product.lowestPrice,
      allTimeHigh: product.highestPrice,
      undercutsTargetPrice:
        product.targetPrice !== null &&
        product.currentPrice !== null &&
        product.currentPrice < product.targetPrice,
      marginPercent: this.marginPercent(product),
      competitors: this.breakdown(competitors, product),
      series: history.map<PricePointDto>((point) => ({
        recordedAt: point.recordedAt.toISOString(),
        price: point.price,
        competitorId: point.competitorId,
        changePercent: point.changePercent,
      })),
    };
  }

  /**
   * Portfolio-level view: how the catalog sits against the market right now.
   * One pass over the products table plus one over the listings.
   */
  async overview(ownerId: string): Promise<MarketOverviewDto> {
    const products = await this.productsRepository
      .createQueryBuilder('product')
      .select('COUNT(*)::int', 'trackedProducts')
      .addSelect('COUNT(*) FILTER (WHERE product.is_active)::int', 'activeProducts')
      .addSelect(
        'COUNT(*) FILTER (WHERE product.target_price IS NOT NULL AND product.current_price < product.target_price)::int',
        'undercutProducts',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE product.our_price IS NOT NULL AND product.current_price IS NOT NULL AND product.our_price <= product.current_price)::int',
        'productsWeWin',
      )
      .addSelect(
        'COUNT(*) FILTER (WHERE product.our_price IS NOT NULL AND product.current_price IS NOT NULL AND product.our_price > product.current_price)::int',
        'productsWeLose',
      )
      .addSelect('AVG(product.current_price)', 'averageMarketPrice')
      .addSelect(
        'AVG(product.our_price - product.current_price) FILTER (WHERE product.our_price IS NOT NULL AND product.current_price IS NOT NULL)',
        'averageGap',
      )
      .where('product.owner_id = :ownerId', { ownerId })
      .getRawOne<{
        trackedProducts: number;
        activeProducts: number;
        undercutProducts: number;
        productsWeWin: number;
        productsWeLose: number;
        averageMarketPrice: string | null;
        averageGap: string | null;
      }>();

    const listings = await this.competitorsRepository
      .createQueryBuilder('competitor')
      .select('COUNT(*)::int', 'total')
      .addSelect('COUNT(*) FILTER (WHERE competitor.is_active)::int', 'active')
      .addSelect("COUNT(*) FILTER (WHERE competitor.scrape_status = 'failed')::int", 'failing')
      .addSelect('COUNT(DISTINCT competitor.host)::int', 'retailers')
      // Listings hang off products, which is where ownership is recorded.
      .innerJoin('competitor.product', 'product')
      .where('product.owner_id = :ownerId', { ownerId })
      .getRawOne<{ total: number; active: number; failing: number; retailers: number }>();

    const movers = await this.priceHistoryRepository
      .createQueryBuilder('history')
      .innerJoin('history.product', 'product')
      .select('product.id', 'productId')
      .addSelect('product.name', 'productName')
      .addSelect('history.change_percent', 'changePercent')
      .addSelect('history.price', 'price')
      .addSelect('history.recorded_at', 'recordedAt')
      .where('product.owner_id = :ownerId', { ownerId })
      .andWhere("history.recorded_at >= NOW() - INTERVAL '7 days'")
      .andWhere('history.change_percent IS NOT NULL')
      .orderBy('ABS(history.change_percent)', 'DESC')
      .limit(10)
      .getRawMany<{
        productId: string;
        productName: string;
        changePercent: string;
        price: string;
        recordedAt: Date;
      }>();

    return {
      trackedProducts: products?.trackedProducts ?? 0,
      activeProducts: products?.activeProducts ?? 0,
      trackedListings: listings?.total ?? 0,
      activeListings: listings?.active ?? 0,
      failingListings: listings?.failing ?? 0,
      retailers: listings?.retailers ?? 0,
      undercutProducts: products?.undercutProducts ?? 0,
      productsWeWin: products?.productsWeWin ?? 0,
      productsWeLose: products?.productsWeLose ?? 0,
      averageMarketPrice: products?.averageMarketPrice
        ? this.round(Number.parseFloat(products.averageMarketPrice))
        : null,
      averagePriceGap: products?.averageGap
        ? this.round(Number.parseFloat(products.averageGap))
        : null,
      biggestMovers: movers.map((mover) => ({
        productId: mover.productId,
        productName: mover.productName,
        price: this.round(Number.parseFloat(mover.price)),
        changePercent: this.round(Number.parseFloat(mover.changePercent), 2),
        recordedAt: new Date(mover.recordedAt).toISOString(),
      })),
    };
  }

  private breakdown(competitors: Competitor[], product: Product): CompetitorBreakdownDto[] {
    const cheapest = product.currentPrice;

    return competitors
      .map<CompetitorBreakdownDto>((competitor) => ({
        competitorId: competitor.id,
        name: competitor.name,
        host: competitor.host,
        url: competitor.url,
        currentPrice: competitor.currentPrice,
        previousPrice: competitor.previousPrice,
        currency: competitor.currency,
        inStock: competitor.inStock,
        isCheapest:
          competitor.currentPrice !== null &&
          cheapest !== null &&
          competitor.currentPrice === cheapest,
        isActive: competitor.isActive,
        lastCheckedAt: competitor.lastCheckedAt?.toISOString() ?? null,
        scrapeStatus: competitor.scrapeStatus,
        // How far above the cheapest listing this one sits.
        premiumPercent:
          competitor.currentPrice !== null && cheapest !== null && cheapest > 0
            ? this.round(((competitor.currentPrice - cheapest) / cheapest) * 100, 2)
            : null,
      }))
      .sort((a, b) => (a.currentPrice ?? Infinity) - (b.currentPrice ?? Infinity));
  }

  /** Our price relative to the market price, in percent. Positive = we are dearer. */
  private marginPercent(product: Product): number | null {
    if (product.ourPrice === null || product.currentPrice === null || product.currentPrice === 0) {
      return null;
    }

    return this.round(((product.ourPrice - product.currentPrice) / product.currentPrice) * 100, 2);
  }

  /** Coefficient of variation: standard deviation as a percentage of the mean. */
  private volatility(prices: number[]): number | null {
    if (prices.length < 2) return null;

    const mean = this.mean(prices);
    if (mean === 0) return null;

    const variance = this.mean(prices.map((price) => (price - mean) ** 2));
    return this.round((Math.sqrt(variance) / mean) * 100, 2);
  }

  private trendFrom(changePercent: number | null): PriceTrend {
    if (changePercent === null) return 'unknown';
    if (changePercent > TREND_DEADBAND_PERCENT) return 'rising';
    if (changePercent < -TREND_DEADBAND_PERCENT) return 'falling';
    return 'flat';
  }

  private mean(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private round(value: number, decimals = 2): number {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }
}
