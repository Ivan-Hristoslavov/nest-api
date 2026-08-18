import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { User } from '../billing/entities/user.entity';
import { Competitor } from './entities/competitor.entity';
import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';
import { QueryProductsDto } from './dto/query-products.dto';

/**
 * Proof that customer data is scoped.
 *
 * This is the test worth having: a scoping miss does not fail loudly, it
 * quietly returns another customer's rows — including the negotiated supplier
 * discounts the whole comparison turns on. So rather than trusting that every
 * query carries the filter, these assert it against the query the repository
 * actually receives.
 */
describe('tenant scoping in ProductsService', () => {
  let service: ProductsService;
  let products: jest.Mocked<Partial<Repository<Product>>>;
  let queryBuilder: Record<string, jest.Mock>;

  const ownerId = 'acc-1';

  beforeEach(async () => {
    queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getRawOne: jest.fn().mockResolvedValue({}),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    products = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: products },
        { provide: getRepositoryToken(Competitor), useValue: {} },
        { provide: getRepositoryToken(PriceHistory), useValue: {} },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(ProductsService);
  });

  it('filters the product list by the calling account', async () => {
    await service.findAll(ownerId, { limit: 20, offset: 0 } as QueryProductsDto);

    expect(queryBuilder.where).toHaveBeenCalledWith('product.owner_id = :ownerId', { ownerId });
  });

  it('looks a single product up by id AND owner', async () => {
    await expect(service.findOne(ownerId, 'prod-1')).rejects.toThrow(NotFoundException);

    expect(products.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prod-1', ownerId } }),
    );
  });

  it("reports another account's product as missing rather than forbidden", async () => {
    // The row exists, but not for this caller: the repository returns nothing
    // because the owner is part of the query. Answering 403 instead would
    // confirm the product exists, which is itself a way to enumerate what a
    // competitor tracks.
    await expect(service.findOne(ownerId, 'someone-elses')).rejects.toThrow(NotFoundException);
  });

  it('scopes deletion, so a stray id cannot remove another account’s row', async () => {
    await expect(service.remove(ownerId, 'prod-1')).rejects.toThrow(NotFoundException);

    expect(products.delete).toHaveBeenCalledWith({ id: 'prod-1', ownerId });
  });

  it('counts only this account when enforcing the plan limit', async () => {
    const owner = { id: ownerId, productLimit: 5 } as User;

    await service.assertWithinLimit(owner);

    expect(products.count).toHaveBeenCalledWith({ where: { ownerId } });
  });

  it('refuses to exceed the plan, naming the plan’s number', async () => {
    (products.count as jest.Mock).mockResolvedValue(5);
    const owner = { id: ownerId, productLimit: 5 } as User;

    await expect(service.assertWithinLimit(owner)).rejects.toThrow(/5 следени продукта/);
  });

  it('checks a bulk import against the whole batch, not one row', async () => {
    (products.count as jest.Mock).mockResolvedValue(3);
    const owner = { id: ownerId, productLimit: 5 } as User;

    // 3 used + 4 more = 7, past a limit of 5. Checking row by row would let
    // the first two through and fail half way, leaving a partial catalogue.
    await expect(service.assertWithinLimit(owner, 4)).rejects.toThrow(/следите 3/);
    await expect(service.assertWithinLimit(owner, 2)).resolves.toBeUndefined();
  });

  it('scopes the statistics, or the dashboard would count everybody', async () => {
    await service.getStats(ownerId);

    expect(queryBuilder.where).toHaveBeenCalledWith('product.owner_id = :ownerId', { ownerId });
  });

  it('scopes the facet lists, which would otherwise leak brand names', async () => {
    await service.getFacets(ownerId);

    expect(queryBuilder.where).toHaveBeenCalledWith('product.owner_id = :ownerId', { ownerId });
  });
});
