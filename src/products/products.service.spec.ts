import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { ScrapeStatus } from './enums/scrape-status.enum';
import { ProductsService } from './products.service';

type MockRepository<T extends object = never> = Partial<Record<keyof Repository<T>, jest.Mock>>;

const createMockRepository = <T extends object>(): MockRepository<T> => ({
  create: jest.fn(),
  save: jest.fn(),
  insert: jest.fn(),
  findOne: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
  findAndCount: jest.fn(),
  createQueryBuilder: jest.fn(),
});

const buildProduct = (overrides: Partial<Product> = {}): Product => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Sony WH-1000XM5',
  sku: null,
  targetUrl: 'https://shop.example.com/p/1',
  competitorUrl: 'https://competitor.example.com/p/1',
  currency: 'EUR',
  currentPrice: 100,
  previousPrice: null,
  targetPrice: null,
  lowestPrice: 100,
  highestPrice: 100,
  lastUpdated: null,
  lastCheckedAt: null,
  scrapeStatus: ScrapeStatus.Pending,
  lastError: null,
  failureCount: 0,
  isActive: true,
  checkIntervalMinutes: 60,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('ProductsService', () => {
  let service: ProductsService;
  let productsRepository: MockRepository<Product>;
  let priceHistoryRepository: MockRepository<PriceHistory>;
  let transactionalProducts: MockRepository<Product>;
  let transactionalHistory: MockRepository<PriceHistory>;

  beforeEach(async () => {
    productsRepository = createMockRepository<Product>();
    priceHistoryRepository = createMockRepository<PriceHistory>();
    transactionalProducts = createMockRepository<Product>();
    transactionalHistory = createMockRepository<PriceHistory>();

    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === Product ? transactionalProducts : transactionalHistory,
      ),
    } as unknown as EntityManager;

    const dataSource = {
      transaction: jest.fn((runInTransaction: (m: EntityManager) => Promise<unknown>) =>
        runInTransaction(manager),
      ),
    } as unknown as DataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: productsRepository },
        { provide: getRepositoryToken(PriceHistory), useValue: priceHistoryRepository },
        { provide: DataSource, useValue: dataSource },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({ alertThresholdPercent: 5 }),
          },
        },
      ],
    }).compile();

    service = module.get(ProductsService);
  });

  describe('findOne', () => {
    it('returns the product when it exists', async () => {
      const product = buildProduct();
      productsRepository.findOne!.mockResolvedValue(product);

      await expect(service.findOne(product.id)).resolves.toBe(product);
    });

    it('throws NotFoundException for an unknown id', async () => {
      productsRepository.findOne!.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when nothing was deleted', async () => {
      productsRepository.delete!.mockResolvedValue({ affected: 0 });

      await expect(service.remove('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('resolves when a row was deleted', async () => {
      productsRepository.delete!.mockResolvedValue({ affected: 1 });

      await expect(service.remove('id')).resolves.toBeUndefined();
    });
  });

  describe('applyPriceObservation', () => {
    beforeEach(() => {
      transactionalProducts.save!.mockImplementation((entity: Product) => Promise.resolve(entity));
      transactionalHistory.insert!.mockResolvedValue({});
    });

    it('records a price drop, updates the extremes and appends history', async () => {
      const product = buildProduct({ currentPrice: 100, lowestPrice: 100, highestPrice: 100 });
      transactionalProducts.findOne!.mockResolvedValue(product);

      const result = await service.applyPriceObservation(product.id, 90, 'competitor.example.com');

      expect(result.previousPrice).toBe(100);
      expect(result.currentPrice).toBe(90);
      expect(result.changePercent).toBe(-10);
      expect(result.priceChanged).toBe(true);
      expect(result.significantChange).toBe(true);
      expect(result.status).toBe(ScrapeStatus.Success);
      expect(product.lowestPrice).toBe(90);
      expect(product.highestPrice).toBe(100);
      expect(transactionalHistory.insert).toHaveBeenCalledTimes(1);
    });

    it('does not append history when the price is unchanged', async () => {
      const product = buildProduct({ currentPrice: 100 });
      transactionalProducts.findOne!.mockResolvedValue(product);

      const result = await service.applyPriceObservation(product.id, 100, 'competitor.example.com');

      expect(result.priceChanged).toBe(false);
      expect(result.changePercent).toBe(0);
      expect(transactionalHistory.insert).not.toHaveBeenCalled();
      // The check still counts: lastCheckedAt moves, lastUpdated does not.
      expect(product.lastCheckedAt).toBeInstanceOf(Date);
      expect(product.lastUpdated).toBeNull();
    });

    it('flags an undercut of the configured target price', async () => {
      const product = buildProduct({ currentPrice: 100, targetPrice: 95 });
      transactionalProducts.findOne!.mockResolvedValue(product);

      const result = await service.applyPriceObservation(product.id, 94, 'competitor.example.com');

      expect(result.undercutsTargetPrice).toBe(true);
    });

    it('clears the failure state after a successful check', async () => {
      const product = buildProduct({
        currentPrice: 100,
        failureCount: 3,
        scrapeStatus: ScrapeStatus.Failed,
        lastError: 'boom',
      });
      transactionalProducts.findOne!.mockResolvedValue(product);

      await service.applyPriceObservation(product.id, 101, 'competitor.example.com');

      expect(product.failureCount).toBe(0);
      expect(product.lastError).toBeNull();
      expect(product.scrapeStatus).toBe(ScrapeStatus.Success);
    });

    it('handles the first ever observation without a previous price', async () => {
      const product = buildProduct({ currentPrice: null, lowestPrice: null, highestPrice: null });
      transactionalProducts.findOne!.mockResolvedValue(product);

      const result = await service.applyPriceObservation(product.id, 42.5, 'manual');

      expect(result.changePercent).toBeNull();
      expect(result.priceChanged).toBe(true);
      expect(product.lowestPrice).toBe(42.5);
      expect(product.highestPrice).toBe(42.5);
    });

    it('throws NotFoundException for an unknown product', async () => {
      transactionalProducts.findOne!.mockResolvedValue(null);

      await expect(service.applyPriceObservation('missing', 10, 'manual')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('markScrapeFailure', () => {
    it('increments the failure counter and stores the reason', async () => {
      const product = buildProduct({ failureCount: 1 });
      productsRepository.findOne!.mockResolvedValue(product);
      productsRepository.save!.mockImplementation((entity: Product) => Promise.resolve(entity));

      const result = await service.markScrapeFailure(product.id, 'HTTP 503');

      expect(result.status).toBe(ScrapeStatus.Failed);
      expect(product.failureCount).toBe(2);
      expect(product.lastError).toBe('HTTP 503');
      expect(product.isActive).toBe(true);
    });

    it('deactivates the product after ten consecutive failures', async () => {
      const product = buildProduct({ failureCount: 9 });
      productsRepository.findOne!.mockResolvedValue(product);
      productsRepository.save!.mockImplementation((entity: Product) => Promise.resolve(entity));

      await service.markScrapeFailure(product.id, 'HTTP 503');

      expect(product.failureCount).toBe(10);
      expect(product.isActive).toBe(false);
    });
  });
});
