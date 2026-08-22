import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { User } from '../billing/entities/user.entity';
import { Shop } from '../shops/entities/shop.entity';
import { Order, OrderStatus } from './entities/order.entity';
import { OrdersService } from './orders.service';

/**
 * An order is the one thing here somebody acts on with their own money, so the
 * arithmetic has to be right, the numbering has to not collide, and what was
 * sent has to stay exactly what was sent.
 */
describe('drafting an order', () => {
  let service: OrdersService;
  let saved: Order | null;
  let highestNumber: number | null;

  const owner = { id: 'u1', email: 'kupuvach@example.com', name: 'Електро Иванов' } as User;

  const shop = {
    id: 's1',
    ownerId: 'u1',
    name: 'Електро Склад',
    orderEmail: 'orders@electro.example',
    currency: 'EUR',
  } as Shop;

  beforeEach(async () => {
    saved = null;
    highestNumber = null;

    const manager = {
      query: jest.fn((sql: string) =>
        sql.includes('MAX(number)')
          ? Promise.resolve([{ max: highestNumber }])
          : Promise.resolve([]),
      ),
      create: jest.fn((_entity: unknown, input: unknown) => input),
      getRepository: () => ({
        create: (input: Order) => input,
        save: (order: Order) => {
          saved = order;
          return Promise.resolve(order);
        },
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getRepositoryToken(Order), useValue: { find: jest.fn(), findOne: jest.fn() } },
        {
          provide: getRepositoryToken(Shop),
          useValue: { findOne: jest.fn().mockResolvedValue(shop) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(OrdersService);
  });

  it('totals the lines to the cent', async () => {
    await service.create(owner, {
      shopId: 's1',
      lines: [
        { query: 'Кабел СВТ 3x2.5', quantity: 100, unitPrice: 4.12 },
        { query: 'LED крушка E27 12W', quantity: 20, unitPrice: 2.29 },
      ],
    });

    expect(saved).not.toBeNull();
    expect(saved!.lines[0].lineTotal).toBe(412);
    expect(saved!.lines[1].lineTotal).toBe(45.8);
    // 412 + 45.8, without the floating-point tail that would print 457.79999.
    expect(saved!.total).toBe(457.8);
  });

  it('numbers the first order 1 and the next one after the highest', async () => {
    await service.create(owner, {
      shopId: 's1',
      lines: [{ query: 'x', quantity: 1, unitPrice: 1 }],
    });
    expect(saved!.number).toBe(1);

    highestNumber = 7;
    await service.create(owner, {
      shopId: 's1',
      lines: [{ query: 'x', quantity: 1, unitPrice: 1 }],
    });
    expect(saved!.number).toBe(8);
  });

  it('copies the supplier’s name and address rather than pointing at them', async () => {
    await service.create(owner, {
      shopId: 's1',
      lines: [{ query: 'x', quantity: 1, unitPrice: 1 }],
    });

    // An order is a record of something that happened. Renaming the supplier
    // next year must not rewrite what last year's order said.
    expect(saved!.shopName).toBe('Електро Склад');
    expect(saved!.shopEmail).toBe('orders@electro.example');
  });

  it('starts as a draft, sent by nobody yet', async () => {
    await service.create(owner, {
      shopId: 's1',
      lines: [{ query: 'x', quantity: 1, unitPrice: 1 }],
    });

    expect(saved!.status).toBe(OrderStatus.Draft);
    expect(saved!.sentAt).toBeUndefined();
  });

  it('refuses an order with no lines', async () => {
    await expect(service.create(owner, { shopId: 's1', lines: [] })).rejects.toThrow(/редове/);
  });
});

describe('what happens to an order after it goes out', () => {
  const build = async (stored: Partial<Order>) => {
    const order = {
      id: 'o1',
      ownerId: 'u1',
      status: OrderStatus.Draft,
      // Bound explicitly: the fixture is a plain object, and the method
      // reads `this.status` off whichever order it is called on.
      isEditable(this: Order) {
        return this.status === OrderStatus.Draft;
      },
      ...stored,
    } as Order;

    const orders = {
      findOne: jest.fn().mockResolvedValue(order),
      save: jest.fn((input: Order) => Promise.resolve(input)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getRepositoryToken(Order), useValue: orders },
        { provide: getRepositoryToken(Shop), useValue: { findOne: jest.fn() } },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
      ],
    }).compile();

    return { service: moduleRef.get(OrdersService), orders, order };
  };

  it('will not let the buyer set a status the system already knows', async () => {
    const { service } = await build({});

    // Draft and sent are facts about what happened, not opinions.
    await expect(service.setStatus('u1', 'o1', OrderStatus.Sent)).rejects.toThrow(/на ръка/);
  });

  it('accepts confirmed, because only the buyer can know it', async () => {
    const { service } = await build({});

    const updated = await service.setStatus('u1', 'o1', OrderStatus.Confirmed);
    expect(updated.status).toBe(OrderStatus.Confirmed);
  });

  it('refuses to delete an order the supplier has already received', async () => {
    const { service } = await build({ status: OrderStatus.Sent });

    await expect(service.remove('u1', 'o1')).rejects.toThrow(/не се изтрива/);
  });

  it('deletes a draft, which nobody has seen', async () => {
    const { service, orders } = await build({ status: OrderStatus.Draft });

    await service.remove('u1', 'o1');
    expect(orders.delete).toHaveBeenCalledWith({ id: 'o1', ownerId: 'u1' });
  });
});
