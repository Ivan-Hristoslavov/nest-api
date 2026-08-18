import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Competitor } from '../products/entities/competitor.entity';
import { PriceHistory } from '../products/entities/price-history.entity';
import { Product } from '../products/entities/product.entity';
import { Shop } from '../shops/entities/shop.entity';
import { StatsService } from './stats.service';

/**
 * These numbers are printed on the page that asks strangers for money, so the
 * two ways they can lie are worth pinning: a success rate invented out of an
 * empty database, and a rate that counts listings nobody has checked yet.
 */
describe('StatsService', () => {
  /** counts[n] answers the nth `count()` call, in the order the service makes them. */
  function build(counts: number[], lastCheckedAt: Date | null = null) {
    const shops = { count: jest.fn() };
    const products = { count: jest.fn() };
    const competitors = { count: jest.fn(), findOne: jest.fn() };
    const history = { count: jest.fn() };

    // shops, offlineShops, products, listings, priceMovements, checked, succeeded
    shops.count.mockResolvedValueOnce(counts[0]).mockResolvedValueOnce(counts[1]);
    products.count.mockResolvedValue(counts[2]);
    history.count.mockResolvedValue(counts[4]);
    competitors.count
      .mockResolvedValueOnce(counts[3])
      .mockResolvedValueOnce(counts[5])
      .mockResolvedValueOnce(counts[6]);
    competitors.findOne.mockResolvedValue(lastCheckedAt ? { id: 'c1', lastCheckedAt } : null);

    return Test.createTestingModule({
      providers: [
        StatsService,
        { provide: getRepositoryToken(Shop), useValue: shops },
        { provide: getRepositoryToken(Product), useValue: products },
        { provide: getRepositoryToken(Competitor), useValue: competitors },
        { provide: getRepositoryToken(PriceHistory), useValue: history },
      ],
    })
      .compile()
      .then((moduleRef) => ({
        service: moduleRef.get(StatsService),
        repositories: { shops, products, competitors, history },
      }));
  }

  it('reports no success rate at all rather than 0% or 100% on an empty database', async () => {
    const { service } = await build([0, 0, 0, 0, 0, 0, 0]);

    const stats = await service.snapshot();

    expect(stats.successRate).toBeNull();
    expect(stats.lastCheckAt).toBeNull();
    expect(stats.shops).toBe(0);
  });

  it('measures the rate over checked listings only, so a queue is not a failure', async () => {
    // 40 active listings, but only 25 have been checked; 24 of those succeeded.
    const { service } = await build([3, 1, 12, 40, 87, 25, 24], new Date('2026-08-18T09:00:00Z'));

    const stats = await service.snapshot();

    expect(stats.successRate).toBe(96);
    expect(stats.listings).toBe(40);
    expect(stats.priceMovements).toBe(87);
    expect(stats.lastCheckAt).toBe('2026-08-18T09:00:00.000Z');
  });

  it('counts once per minute, not once per visitor', async () => {
    const { service, repositories } = await build([2, 0, 5, 9, 3, 9, 9]);

    await service.snapshot();
    await service.snapshot();

    expect(repositories.products.count).toHaveBeenCalledTimes(1);
  });
});
