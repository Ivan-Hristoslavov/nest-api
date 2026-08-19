import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { User } from '../billing/entities/user.entity';
import { Competitor } from './entities/competitor.entity';
import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';

/**
 * Deleting a product takes its price history with it, and those observations
 * cannot be collected again — the pages that carried them have moved on. The
 * dashboard asks before doing that; a script calling the API does not, so the
 * refusal has to live in the service.
 */
describe('destructive deletes', () => {
  const ownerId = 'acc-1';

  async function build(historyCount: number) {
    const products = {
      findOne: jest.fn().mockResolvedValue({ id: 'p1', name: 'СВТ 3x1.5' }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
    };
    const history = { count: jest.fn().mockResolvedValue(historyCount) };
    const competitors = { count: jest.fn().mockResolvedValue(3) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: products },
        { provide: getRepositoryToken(PriceHistory), useValue: history },
        { provide: getRepositoryToken(Competitor), useValue: competitors },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
      ],
    }).compile();

    return { service: moduleRef.get(ProductsService), products };
  }

  it('refuses to destroy price history unless asked for it explicitly', async () => {
    const { service, products } = await build(340);

    await expect(service.remove(ownerId, 'p1')).rejects.toBeInstanceOf(ConflictException);
    expect(products.delete).not.toHaveBeenCalled();
  });

  it('says how much would be lost, so the answer is informed', async () => {
    const { service } = await build(340);

    await expect(service.remove(ownerId, 'p1')).rejects.toThrow(/340/);
  });

  it('deletes without ceremony when there is nothing to lose', async () => {
    const { service, products } = await build(0);

    await expect(service.remove(ownerId, 'p1')).resolves.toBeUndefined();
    expect(products.delete).toHaveBeenCalledWith({ id: 'p1', ownerId });
  });

  it('goes ahead when the caller passes purge', async () => {
    const { service, products } = await build(340);

    await expect(service.remove(ownerId, 'p1', true)).resolves.toBeUndefined();
    expect(products.delete).toHaveBeenCalledWith({ id: 'p1', ownerId });
  });
});
