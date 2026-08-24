import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Shop } from '../shops/entities/shop.entity';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';

/**
 * The order email goes to an address the customer typed, from our server,
 * carrying a note they wrote. That is the shape of a mail relay, and the only
 * thing in front of it was a per-minute request limit — which says nothing
 * about how much mail one account can push through in a day.
 */
describe('the daily limit on order emails', () => {
  let service: OrdersService;
  let count: jest.Mock;

  beforeEach(async () => {
    count = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getRepositoryToken(Order), useValue: { count } },
        { provide: getRepositoryToken(Shop), useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(OrdersService);
  });

  it('lets an ordinary day through', async () => {
    count.mockResolvedValue(7);

    await expect(service.assertWithinDailySendLimit('u1')).resolves.toBeUndefined();
  });

  it('refuses once the day’s allowance is gone', async () => {
    count.mockResolvedValue(50);

    await expect(service.assertWithinDailySendLimit('u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('says the order is kept, because it is', async () => {
    count.mockResolvedValue(80);

    await expect(service.assertWithinDailySendLimit('u1')).rejects.toThrow(/остава запазена/);
  });

  it('counts only this account, and only the last 24 hours', async () => {
    count.mockResolvedValue(0);

    await service.assertWithinDailySendLimit('u1');

    const where = count.mock.calls[0][0].where;
    expect(where.ownerId).toBe('u1');
    // `MoreThan(date)` — the value carries the boundary the query compares to.
    expect(where.sentAt.value.getTime()).toBeGreaterThan(Date.now() - 25 * 60 * 60 * 1000);
    expect(where.sentAt.value.getTime()).toBeLessThanOrEqual(Date.now() - 23 * 60 * 60 * 1000);
  });
});
