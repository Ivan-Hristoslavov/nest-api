import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { HostRateLimiterService } from '../http/host-rate-limiter.service';
import { RobotsService } from '../http/robots.service';
import { PriceParserService } from '../parsers/price-parser.service';
import { HttpPriceFetcherService } from './http-price-fetcher.service';
import { FetchTarget } from './price-source.interface';

/**
 * The thing that decides whether a supplier tolerates us or blocks us.
 *
 * Five hundred customers watching the same cable at the same shop was five
 * hundred requests an hour for one page, because the sweep walks listing rows
 * and every customer owns their own. The request count scaled with *customers*
 * rather than with *articles* — and the more popular an article became, the
 * worse it got, which is exactly backwards.
 */
describe('one page, one request, however many customers', () => {
  let service: HttpPriceFetcherService;
  let fetched: string[];

  const scraper = {
    enabled: true,
    cron: '0 * * * *',
    batchSize: 25,
    concurrency: 5,
    timeoutMs: 5000,
    minDelayMs: 0,
    alertThresholdPercent: 5,
    driver: 'http',
    userAgent: 'StoclifyBot/1.0',
    respectRobots: false,
    maxRetries: 0,
    retryBaseDelayMs: 10,
    hostDailyBudget: 0,
    sharedFetchMs: 60_000,
  };

  const target = (over: Partial<FetchTarget> = {}): FetchTarget => ({
    url: 'https://shop.example/cable-3x25',
    host: 'shop.example',
    lastPrice: null,
    currency: 'EUR',
    ...over,
  });

  beforeEach(async () => {
    fetched = [];

    const moduleRef = await Test.createTestingModule({
      providers: [
        HttpPriceFetcherService,
        HostRateLimiterService,
        { provide: PriceParserService, useValue: { parse: () => null } },
        { provide: RobotsService, useValue: { isAllowed: () => true, crawlDelayMs: () => null } },
        { provide: ConfigService, useValue: { get: () => scraper } },
      ],
    }).compile();

    service = moduleRef.get(HttpPriceFetcherService);

    // Replaces the network, not the sharing: this is what counts trips to the
    // shop, which is the whole question.
    (service as unknown as { fetchAndParse: (t: FetchTarget) => Promise<unknown> }).fetchAndParse =
      (t: FetchTarget) => {
        fetched.push(t.url);
        return Promise.resolve({
          price: 4.68,
          currency: 'EUR',
          inStock: true,
          strategy: 'json-ld',
          source: t.host,
          durationMs: 12,
        });
      };
  });

  it('asks the shop once when several customers watch the same page', async () => {
    const results = await Promise.all([
      service.fetch(target()),
      service.fetch(target()),
      service.fetch(target()),
    ]);

    expect(fetched).toEqual(['https://shop.example/cable-3x25']);
    // Every caller still gets the answer; only the trip is pooled.
    results.forEach((result) => expect(result).toMatchObject({ price: 4.68 }));
  });

  it('reuses the answer for a customer who arrives after the first finished', async () => {
    await service.fetch(target());
    await service.fetch(target());

    expect(fetched).toHaveLength(1);
  });

  it('does not hand one customer another customer’s selector', async () => {
    // Two listings on the same URL, read differently — one the retail price,
    // one the trade price. Sharing on the address alone would give the second
    // customer the first one's number, presented with total confidence.
    await service.fetch(target({ selector: '.retail-price' }));
    await service.fetch(target({ selector: '.trade-price' }));

    expect(fetched).toHaveLength(2);
  });

  it('forgets a failure at once rather than remembering a shop as down', async () => {
    (service as unknown as { fetchAndParse: () => Promise<unknown> }).fetchAndParse = () => {
      fetched.push('attempt');
      return Promise.reject(new Error('connection reset'));
    };

    await expect(service.fetch(target())).rejects.toThrow('connection reset');
    await expect(service.fetch(target())).rejects.toThrow('connection reset');

    // A shop that was briefly unreachable must be tried again, not written off
    // for the length of the sharing window.
    expect(fetched).toHaveLength(2);
  });

  it('stops entirely once the day’s budget for that shop is gone', async () => {
    const limited = { ...scraper, hostDailyBudget: 2, sharedFetchMs: 0 };

    const moduleRef = await Test.createTestingModule({
      providers: [
        HttpPriceFetcherService,
        HostRateLimiterService,
        { provide: PriceParserService, useValue: { parse: () => null } },
        { provide: RobotsService, useValue: { isAllowed: () => true, crawlDelayMs: () => null } },
        { provide: ConfigService, useValue: { get: () => limited } },
      ],
    }).compile();

    const budgeted = moduleRef.get(HttpPriceFetcherService);
    let trips = 0;

    (budgeted as unknown as { fetchAndParse: () => Promise<unknown> }).fetchAndParse = () => {
      trips += 1;
      return Promise.resolve({
        price: 1,
        currency: 'EUR',
        inStock: true,
        strategy: 's',
        source: 'h',
        durationMs: 1,
      });
    };

    await budgeted.fetch(target());
    await budgeted.fetch(target());
    await expect(budgeted.fetch(target())).rejects.toThrow(/лимит/);

    expect(trips).toBe(2);
  });
});
