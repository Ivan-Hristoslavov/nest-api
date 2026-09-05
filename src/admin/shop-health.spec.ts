import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { MailService } from '../billing/mail.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { ShopSearchResultDto } from '../discovery/dto/discovery.dto';
import { SearchCache } from '../discovery/entities/search-cache.entity';
import { Shop } from '../shops/entities/shop.entity';
import { GENERIC_PROBES, ShopHealthService, classify } from './shop-health.service';

/**
 * The check exists for the failure that raises no error: a search page that
 * answers every question with the same products. These pin down how two
 * answers are read, and that the operator hears about a host once — when it
 * breaks — rather than every morning it stays broken.
 */

function answer(urls: string[], ok = true, error: string | null = null): ShopSearchResultDto {
  return {
    host: 'shop.bg',
    name: 'Shop',
    searchUrl: '',
    ok,
    error,
    durationMs: 1,
    products: urls.map((url) => ({
      title: url,
      url,
      price: 1,
      currency: 'EUR',
      host: 'shop.bg',
      shopName: 'Shop',
      availability: 'unknown',
    })),
  };
}

describe('reading two probes', () => {
  it('is fine when different questions get different answers', () => {
    const verdict = classify(
      { query: 'кабел', result: answer(['/a', '/b']) },
      { query: 'лампа', result: answer(['/c']) },
    );

    expect(verdict.status).toBe('ok');
  });

  it('calls out a search that gives every question the same answer', () => {
    // Elmark, 2026-08: twenty tiles, whatever you type. No error anywhere.
    const same = ['/1', '/2', '/3'];
    const verdict = classify(
      { query: 'кабел', result: answer(same) },
      { query: 'лампа', result: answer([...same].reverse()) },
    );

    expect(verdict.status).toBe('ignores_query');
    expect(verdict.detail).toContain('едни и същи 3');
  });

  it('is empty when nothing comes back to either question', () => {
    const verdict = classify(
      { query: 'кабел', result: answer([]) },
      { query: 'лампа', result: answer([]) },
    );

    expect(verdict.status).toBe('empty');
  });

  it('is an error only when the shop could not be asked at all', () => {
    const refused = answer([], false, 'HTTP 503');

    expect(
      classify({ query: 'кабел', result: refused }, { query: 'лампа', result: refused }).status,
    ).toBe('error');

    // One failure and one real answer is a shop that answers.
    expect(
      classify({ query: 'кабел', result: refused }, { query: 'лампа', result: answer(['/x']) })
        .status,
    ).toBe('ok');
  });
});

describe('the daily check', () => {
  const shop = (overrides: Partial<Shop>): Shop =>
    ({
      id: 'shop-1',
      ownerId: 'owner-1',
      host: 'elmarkstore.eu',
      name: 'Elmark',
      hasWebsite: true,
      isActive: true,
      searchMethod: 'live',
      searchUrlTemplate: 'https://elmarkstore.eu/search?q={q}',
      healthStatus: null,
      healthDetail: null,
      healthCheckedAt: null,
      ...overrides,
    }) as Shop;

  async function build(options: {
    shops: Shop[];
    answers: Record<string, ShopSearchResultDto>;
    known?: string | null;
    operatorEmail?: string;
  }) {
    const shops = {
      find: jest.fn().mockResolvedValue(options.shops),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const cache = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(options.known ? { query: options.known } : null),
      }),
    };
    const discovery = {
      probeSearch: jest.fn((_shop: Shop, query: string) =>
        Promise.resolve(options.answers[query] ?? answer([])),
      ),
    };
    const mail = { deliver: jest.fn().mockResolvedValue(true) };
    const scheduler = { addCronJob: jest.fn() };
    const config = {
      get: jest.fn((section: string) =>
        section === 'shopHealth'
          ? { enabled: false, cron: '0 6 * * *' }
          : {
              appUrl: 'https://stoclify.bg',
              supportEmail: 'support@stoclify.bg',
              operatorEmail: options.operatorEmail,
            },
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ShopHealthService,
        { provide: getRepositoryToken(Shop), useValue: shops },
        { provide: getRepositoryToken(SearchCache), useValue: cache },
        { provide: DiscoveryService, useValue: discovery },
        { provide: MailService, useValue: mail },
        { provide: SchedulerRegistry, useValue: scheduler },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    return { service: moduleRef.get(ShopHealthService), shops, discovery, mail };
  }

  it('asks a question the shop has answered before, then a different one', async () => {
    const { service, discovery } = await build({
      shops: [shop({})],
      known: 'кабел nym 3x1.5',
      answers: { 'кабел nym 3x1.5': answer(['/a']), [GENERIC_PROBES[0]]: answer(['/b']) },
    });

    await service.run('manual');

    const asked = discovery.probeSearch.mock.calls.map((call) => call[1]);
    expect(asked[0]).toBe('кабел nym 3x1.5');
    expect(asked[1]).not.toBe('кабел nym 3x1.5');
  });

  it('writes the verdict on every row that shares the search, and emails the operator once', async () => {
    const same = answer(['/1', '/2']);
    const { service, shops, mail } = await build({
      shops: [shop({ id: 'shop-1', ownerId: 'a' }), shop({ id: 'shop-2', ownerId: 'b' })],
      answers: { [GENERIC_PROBES[0]]: same, [GENERIC_PROBES[1]]: same },
      operatorEmail: 'ops@stoclify.bg',
    });

    const report = await service.run('manual');

    expect(shops.update).toHaveBeenCalledTimes(1);
    expect(shops.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ healthStatus: 'ignores_query' }),
    );

    expect(report.hosts).toHaveLength(1);
    expect(report.hosts[0]).toMatchObject({
      host: 'elmarkstore.eu',
      status: 'ignores_query',
      accounts: 2,
    });

    expect(mail.deliver).toHaveBeenCalledTimes(1);
    expect(mail.deliver).toHaveBeenCalledWith(
      'ops@stoclify.bg',
      expect.stringContaining('elmarkstore.eu'),
      expect.any(String),
      expect.any(String),
    );
  });

  it('does not email again for a host that was already broken yesterday', async () => {
    const { service, mail } = await build({
      shops: [shop({ healthStatus: 'empty' })],
      answers: {},
      operatorEmail: 'ops@stoclify.bg',
    });

    await service.run('manual');

    expect(mail.deliver).not.toHaveBeenCalled();
  });

  it('emails when a host that was fine stops answering', async () => {
    const { service, mail } = await build({
      shops: [shop({ healthStatus: 'ok' })],
      answers: {},
      operatorEmail: 'ops@stoclify.bg',
    });

    await service.run('manual');

    expect(mail.deliver).toHaveBeenCalledTimes(1);
  });

  it('says nothing to anybody when nobody is configured to hear it', async () => {
    const { service, mail } = await build({
      shops: [shop({ healthStatus: 'ok' })],
      answers: {},
    });

    const report = await service.run('manual');

    expect(mail.deliver).not.toHaveBeenCalled();
    expect(report.hosts[0].status).toBe('empty');
  });

  it('joins a check already running instead of starting a second', async () => {
    const { service, discovery } = await build({
      shops: [shop({})],
      answers: { [GENERIC_PROBES[0]]: answer(['/a']), [GENERIC_PROBES[1]]: answer(['/b']) },
    });

    const [first, second] = await Promise.all([service.run('manual'), service.run('schedule')]);

    expect(first).toBe(second);
    expect(discovery.probeSearch).toHaveBeenCalledTimes(2);
  });
});
