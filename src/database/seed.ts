import { Logger } from '@nestjs/common';

import { Competitor } from '../products/entities/competitor.entity';
import { PriceHistory } from '../products/entities/price-history.entity';
import { Product } from '../products/entities/product.entity';
import { ScrapeStatus } from '../products/enums/scrape-status.enum';
import { retailerNameForHost } from '../scraper/parsers/site-profiles';
import dataSource from './data-source';

/**
 * Seeds a demo catalog so the API has something to work with.
 *
 * Idempotent: products are matched by SKU, so re-running updates the existing
 * rows instead of creating duplicates. Price history is left untouched — it is
 * an append-only log and the scraper fills it.
 *
 *   npm run seed          # insert / update the demo catalog
 *   npm run seed -- --reset   # delete every product first (also drops history)
 */
/** SKU is mandatory here: it is the key the seed matches on when re-running. */
type DemoProduct = Partial<Product> & { sku: string };

const DEMO_PRODUCTS: DemoProduct[] = [
  {
    // A real, scrapeable listing: use it to verify the http driver end to end.
    name: 'Crucial T710 SSD 1TB CT1000T710SSD8',
    sku: 'SKU-CRUCIAL-T710-1TB',
    targetUrl: 'https://shop.example.com/products/crucial-t710-1tb',
    competitorUrl: 'https://www.vario.bg/crucial-t710-ssd-1tb-ct1000t710ssd8',
    currency: 'BGN',
    targetPrice: 400.0,
    checkIntervalMinutes: 60,
  },
  {
    name: 'Sony WH-1000XM5 Wireless Headphones',
    sku: 'SKU-SONY-WH1000XM5',
    targetUrl: 'https://shop.example.com/products/sony-wh-1000xm5',
    competitorUrl: 'https://competitor-a.example.com/audio/sony-wh-1000xm5',
    currency: 'EUR',
    currentPrice: 329.0,
    targetPrice: 299.0,
    checkIntervalMinutes: 60,
  },
  {
    name: 'Apple AirPods Pro (2nd generation)',
    sku: 'SKU-APPLE-AIRPODSPRO2',
    targetUrl: 'https://shop.example.com/products/airpods-pro-2',
    competitorUrl: 'https://competitor-a.example.com/audio/airpods-pro-2',
    currency: 'EUR',
    currentPrice: 249.0,
    targetPrice: 229.0,
    checkIntervalMinutes: 30,
  },
  {
    name: 'Samsung Galaxy S24 Ultra 256GB',
    sku: 'SKU-SAMSUNG-S24U-256',
    targetUrl: 'https://shop.example.com/products/galaxy-s24-ultra',
    competitorUrl: 'https://competitor-b.example.com/phones/galaxy-s24-ultra',
    currency: 'EUR',
    currentPrice: 1299.0,
    targetPrice: 1249.0,
    checkIntervalMinutes: 15,
  },
  {
    name: 'Dyson V15 Detect Absolute',
    sku: 'SKU-DYSON-V15-ABS',
    targetUrl: 'https://shop.example.com/products/dyson-v15-detect',
    competitorUrl: 'https://competitor-b.example.com/home/dyson-v15-detect',
    currency: 'EUR',
    currentPrice: 749.0,
    targetPrice: 699.0,
    checkIntervalMinutes: 120,
  },
  {
    name: 'LG OLED evo C4 65"',
    sku: 'SKU-LG-OLED-C4-65',
    targetUrl: 'https://shop.example.com/products/lg-oled-c4-65',
    competitorUrl: 'https://competitor-c.example.com/tv/lg-oled-c4-65',
    currency: 'EUR',
    currentPrice: 1899.0,
    targetPrice: 1799.0,
    checkIntervalMinutes: 60,
  },
  {
    name: 'Logitech MX Master 3S',
    sku: 'SKU-LOGI-MXM3S',
    targetUrl: 'https://shop.example.com/products/mx-master-3s',
    competitorUrl: 'https://competitor-c.example.com/accessories/mx-master-3s',
    currency: 'EUR',
    currentPrice: 109.99,
    targetPrice: 99.0,
    checkIntervalMinutes: 240,
  },
  {
    name: 'Nintendo Switch OLED',
    sku: 'SKU-NINTENDO-SW-OLED',
    targetUrl: 'https://shop.example.com/products/switch-oled',
    competitorUrl: 'https://competitor-a.example.com/gaming/switch-oled',
    currency: 'EUR',
    currentPrice: 349.99,
    targetPrice: 319.0,
    checkIntervalMinutes: 60,
  },
  {
    name: 'Kindle Paperwhite Signature Edition',
    sku: 'SKU-AMZN-KPW-SIG',
    targetUrl: 'https://shop.example.com/products/kindle-paperwhite-signature',
    competitorUrl: 'https://competitor-b.example.com/ereaders/kindle-paperwhite',
    currency: 'EUR',
    currentPrice: 199.99,
    // No target price: this one is tracked for information only.
    checkIntervalMinutes: 720,
  },
];

async function seed(): Promise<void> {
  const logger = new Logger('Seed');
  const reset = process.argv.includes('--reset');

  await dataSource.initialize();
  logger.log(`Connected to ${dataSource.options.database as string}`);

  try {
    const products = dataSource.getRepository(Product);
    const competitors = dataSource.getRepository(Competitor);
    const history = dataSource.getRepository(PriceHistory);

    if (reset) {
      // price_history rows disappear with their product (ON DELETE CASCADE).
      const { affected } = await products.delete({});
      logger.warn(`--reset: deleted ${affected ?? 0} product(s) and their history.`);
    }

    let created = 0;
    let updated = 0;

    for (const demo of DEMO_PRODUCTS) {
      const existing = await products.findOne({ where: { sku: demo.sku } });

      if (existing) {
        // Only the catalog definition is re-applied. Observed prices belong to
        // the scraper: overwriting `currentPrice` here would silently throw
        // away real tracking data every time the seed is re-run.
        products.merge(existing, {
          name: demo.name,
          targetUrl: demo.targetUrl,
          competitorUrl: demo.competitorUrl,
          currency: demo.currency,
          targetPrice: demo.targetPrice ?? null,
          checkIntervalMinutes: demo.checkIntervalMinutes,
        });
        await products.save(existing);
        updated += 1;
        continue;
      }

      const product = await products.save(
        products.create({
          ...demo,
          previousPrice: null,
          lowestPrice: demo.currentPrice ?? null,
          highestPrice: demo.currentPrice ?? null,
          lastUpdated: new Date(),
          scrapeStatus: ScrapeStatus.Pending,
          isActive: true,
        }),
      );

      // Every product needs its primary listing: the scraper iterates
      // competitors, so a product without one is silently never checked.
      const host = new URL(product.competitorUrl).host;
      const competitor = await competitors.save(
        competitors.create({
          productId: product.id,
          name: retailerNameForHost(host),
          url: product.competitorUrl,
          host,
          currency: product.currency,
          currentPrice: product.currentPrice,
          isPrimary: true,
          isActive: true,
          scrapeStatus: ScrapeStatus.Pending,
        }),
      );

      product.cheapestCompetitorId = competitor.id;
      product.competitorCount = 1;
      await products.save(product);

      // Seed the first history point so charts start from a known price.
      if (product.currentPrice !== null) {
        await history.insert({
          productId: product.id,
          competitorId: competitor.id,
          price: product.currentPrice,
          previousPrice: null,
          changePercent: null,
          currency: product.currency,
          source: 'seed',
        });
      }

      created += 1;
    }

    const total = await products.count();
    logger.log(`Seed complete: ${created} created, ${updated} updated, ${total} product(s) total.`);
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((error: unknown) => {
  new Logger('Seed').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
