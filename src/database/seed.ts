import { Logger } from '@nestjs/common';

import { Competitor } from '../products/entities/competitor.entity';
import { Product } from '../products/entities/product.entity';
import { ScrapeStatus } from '../products/enums/scrape-status.enum';
import { retailerNameForHost } from '../scraper/parsers/site-profiles';
import dataSource from './data-source';

/**
 * Seeds a catalog of **real, verified listings**.
 *
 * Every URL below was fetched and parsed successfully while writing this file.
 * That matters more than it sounds: a demo catalog of invented URLs teaches you
 * nothing about whether the scraper works, and quietly trains you to ignore the
 * "failed" column.
 *
 *   npm run seed            # add or update the catalog
 *   npm run seed -- --reset # delete every product first, then seed
 *
 * Classified-ad links (mobile.bg) expire when the car sells. That is realistic
 * rather than a flaw — it is exactly the "listing disappeared" case the failure
 * handling exists for.
 */
interface SeedListing {
  url: string;
  /** Overrides the name derived from the host — useful when several ads share a site. */
  name?: string;
  currency?: string;
}

interface SeedProduct {
  name: string;
  sku: string;
  /** What we sell it for, used for the margin columns. */
  ourPrice?: number;
  /** Alert threshold. */
  targetPrice?: number;
  currency: string;
  checkIntervalMinutes: number;
  listings: SeedListing[];
}

const CATALOG: SeedProduct[] = [
  {
    // Four independent sellers of the same model. The spread between them —
    // 22 900 to 25 000 € — is the entire point of the product.
    name: 'Mercedes-Benz GLE 350d 4MATIC (W166)',
    sku: 'CAR-MB-GLE350D-W166',
    currency: 'EUR',
    ourPrice: 27_500,
    targetPrice: 25_000,
    checkIntervalMinutes: 720,
    listings: [
      {
        url: 'https://www.mobile.bg/obiava-21776402016653788-mercedes-benz-gle-350-amg-line-4matic-distronic-panorama-9g-kamera-360',
        name: 'Mobile.bg — AMG Line 4MATIC, панорама',
      },
      {
        url: 'https://www.mobile.bg/obiava-21776668467774983-mercedes-benz-gle-350-amg-germany-pano-distr-camera-car-play-airmat-lizi',
        name: 'Mobile.bg — AMG Germany, Airmatic',
      },
      {
        url: 'https://www.mobile.bg/obiava-21770217897939380-mercedes-benz-gle-350-d-9g-full-s-vklyuchen-dds',
        name: 'Mobile.bg — 9G Full, с ДДС',
      },
      {
        url: 'https://www.mobile.bg/obiava-21770469029291949-mercedes-benz-gle-350-amg-germany-distr-camera-car-play-podgrev-ambi-liz',
        name: 'Mobile.bg — AMG Germany, Distronic',
      },
    ],
  },
  {
    name: 'Смартфон Apple iPhone 17 Pro 256GB Deep Blue',
    sku: 'PHONE-APPLE-IP17P-256-DB',
    currency: 'EUR',
    ourPrice: 1_349,
    targetPrice: 1_200,
    checkIntervalMinutes: 120,
    listings: [
      {
        url: 'https://www.emag.bg/smartfon-apple-iphone-17-pro-256gb-5g-deep-blue-mg8j4zd-a/pd/DH99FV3BM/',
        name: 'eMAG',
      },
      { url: 'https://istyle.bg/products/iphone-17-pro-mg8j4zd-a', name: 'iSTYLE' },
    ],
  },
  {
    name: 'Смартфон Apple iPhone 17 Pro 256GB Silver',
    sku: 'PHONE-APPLE-IP17P-256-SL',
    currency: 'EUR',
    ourPrice: 1_349,
    targetPrice: 1_200,
    checkIntervalMinutes: 120,
    listings: [
      {
        url: 'https://www.emag.bg/smartfon-apple-iphone-17-pro-256gb-5g-silver-mg8k4zd-a/pd/DK99FV3BM/',
        name: 'eMAG',
      },
    ],
  },
  {
    // Two shops quoting two different currencies for the same television —
    // eMAG in EUR, Vario in BGN. Normalised at the fixed peg before comparison.
    name: 'Телевизор Samsung QLED QE55Q7F2AUXXH 55"',
    sku: 'TV-SAMSUNG-55Q7F2',
    currency: 'EUR',
    ourPrice: 399,
    targetPrice: 340,
    checkIntervalMinutes: 240,
    listings: [
      {
        url: 'https://www.emag.bg/televizor-samsung-qled-55q7f2-55-138-sm-smart-4k-ultra-hd-klas-g-qe55q7f2auxxh/pd/DT3GRT3BM/',
        name: 'eMAG',
      },
      { url: 'https://www.vario.bg/samsung-qe55q7f2auxxh', name: 'Vario', currency: 'BGN' },
    ],
  },
  {
    name: 'Смарт часовник Huawei Watch GT6 41mm Milanese',
    sku: 'WATCH-HUAWEI-GT6-41',
    currency: 'EUR',
    ourPrice: 259,
    targetPrice: 230,
    checkIntervalMinutes: 240,
    listings: [
      {
        url: 'https://www.technomarket.bg/chasovnitzi/huawei-watch-gt6-gold-milanese-41-mm-09235284',
        name: 'Технómarket',
      },
    ],
  },
  {
    name: 'SSD Crucial T710 1TB PCIe 5.0',
    sku: 'SSD-CRUCIAL-T710-1TB',
    currency: 'EUR',
    ourPrice: 245,
    targetPrice: 210,
    checkIntervalMinutes: 240,
    listings: [
      {
        url: 'https://www.vario.bg/crucial-t710-ssd-1tb-ct1000t710ssd8',
        name: 'Vario',
        currency: 'BGN',
      },
    ],
  },
];

function hostOf(url: string): string {
  return new URL(url).host;
}

async function seed(): Promise<void> {
  const logger = new Logger('Seed');
  const reset = process.argv.includes('--reset');

  await dataSource.initialize();
  logger.log(`Connected to ${dataSource.options.database as string}`);

  try {
    const products = dataSource.getRepository(Product);
    const competitors = dataSource.getRepository(Competitor);

    if (reset) {
      // Alerts and price history disappear with their product (ON DELETE
      // CASCADE). TypeORM refuses `delete({})` as a guard against wiping a
      // table by accident, so the intent is stated explicitly.
      const { affected } = await products.createQueryBuilder().delete().where('1 = 1').execute();
      logger.warn(`--reset: изтрити ${affected ?? 0} продукта с всичките им данни.`);
    }

    let created = 0;
    let updated = 0;
    let listingsAdded = 0;

    for (const entry of CATALOG) {
      let product = await products.findOne({ where: { sku: entry.sku } });

      if (product) {
        // Only the definition is refreshed. Observed prices belong to the
        // scraper — overwriting them here would throw away real tracking data.
        products.merge(product, {
          name: entry.name,
          ourPrice: entry.ourPrice ?? null,
          targetPrice: entry.targetPrice ?? null,
          checkIntervalMinutes: entry.checkIntervalMinutes,
        });
        product = await products.save(product);
        updated += 1;
      } else {
        const primary = entry.listings[0];

        product = await products.save(
          products.create({
            name: entry.name,
            sku: entry.sku,
            targetUrl: `https://moiat-magazin.bg/p/${entry.sku.toLowerCase()}`,
            competitorUrl: primary.url,
            currency: entry.currency,
            ourPrice: entry.ourPrice ?? null,
            targetPrice: entry.targetPrice ?? null,
            checkIntervalMinutes: entry.checkIntervalMinutes,
            scrapeStatus: ScrapeStatus.Pending,
            isActive: true,
          }),
        );
        created += 1;
      }

      for (const [index, listing] of entry.listings.entries()) {
        const host = hostOf(listing.url);
        const existing = await competitors.findOne({
          where: { productId: product.id, url: listing.url },
        });

        if (existing) continue;

        await competitors.save(
          competitors.create({
            productId: product.id,
            name: listing.name ?? retailerNameForHost(host),
            url: listing.url,
            host,
            currency: listing.currency ?? entry.currency,
            isPrimary: index === 0,
            isActive: true,
            scrapeStatus: ScrapeStatus.Pending,
          }),
        );
        listingsAdded += 1;
      }

      const count = await competitors.count({ where: { productId: product.id, isActive: true } });
      product.competitorCount = count;
      await products.save(product);
    }

    const total = await products.count();
    logger.log(
      `Готово: ${created} нови продукта, ${updated} обновени, ${listingsAdded} нови склада, ${total} общо.`,
    );
    logger.log('Пуснете POST /api/v1/scraper/run, за да се прочетат реалните цени.');
  } finally {
    await dataSource.destroy();
  }
}

seed().catch((error: unknown) => {
  new Logger('Seed').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
