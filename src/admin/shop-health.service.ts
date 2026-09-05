import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { In, Repository } from 'typeorm';

import { dataRows, escapeHtml, noticeBox, paragraph, renderEmail } from '../billing/email-layout';
import { MailService } from '../billing/mail.service';
import { Configuration, MailConfig, ShopHealthConfig } from '../config/configuration';
import { DiscoveryService } from '../discovery/discovery.service';
import { ShopSearchResultDto } from '../discovery/dto/discovery.dto';
import { SearchCache } from '../discovery/entities/search-cache.entity';
import { Shop, ShopHealthStatus } from '../shops/entities/shop.entity';
import { ShopHealthDto, ShopHealthReportDto } from './dto/operations.dto';

export const SHOP_HEALTH_CRON_JOB = 'shop-health';

/**
 * Queries a shop in this market should answer, whatever it sells.
 *
 * The check needs two questions that a working search answers differently.
 * Where the shop has been searched before, the first one is a query it is
 * known to have answered — see {@link ShopHealthService.queriesFor} — and one
 * of these is the second. A shop that has never been searched gets the first
 * two.
 */
export const GENERIC_PROBES = ['кабел', 'лампа', 'винт'];

/** Hosts probed at once. Two requests each, so this is six connections open. */
const CONCURRENCY = 3;

interface Probe {
  query: string;
  result: ShopSearchResultDto;
}

export interface Verdict {
  status: ShopHealthStatus;
  detail: string;
}

/**
 * What two probes say about a search.
 *
 * Kept pure so the reasoning can be tested without a network. The order of
 * the tests is the order of certainty: a shop that could not be asked is an
 * error whatever else is true; one that answered nothing to two different
 * questions is empty; one that answered both with the same products has a
 * search that no longer reads its query — which is the failure that looks
 * most like success, and the one this check exists for.
 */
export function classify(first: Probe, second: Probe): Verdict {
  const failed = [first, second].filter((probe) => !probe.result.ok);

  if (failed.length === 2) {
    return {
      status: 'error',
      detail: `Нито една заявка не мина: ${first.result.error ?? 'непозната грешка'}`,
    };
  }

  const urlsOf = (probe: Probe) => new Set(probe.result.products.map((product) => product.url));
  const a = urlsOf(first);
  const b = urlsOf(second);

  if (a.size === 0 && b.size === 0) {
    return {
      status: 'empty',
      detail:
        failed.length === 1
          ? `„${first.query}" и „${second.query}" не върнаха резултат (едната заявка е с грешка: ${failed[0].result.error ?? '—'})`
          : `Нито „${first.query}", нито „${second.query}" върна резултат`,
    };
  }

  const identical = a.size === b.size && [...a].every((url) => b.has(url));

  if (identical && a.size > 0) {
    return {
      status: 'ignores_query',
      detail: `„${first.query}" и „${second.query}" върнаха едни и същи ${a.size} резултата — търсачката не чете заявката`,
    };
  }

  return {
    status: 'ok',
    detail: `„${first.query}": ${a.size} резултата, „${second.query}": ${b.size}`,
  };
}

/**
 * Checks, once a day, that every supplier's search still searches.
 *
 * The failures that matter here are the quiet ones. A shop whose search page
 * starts answering every query with the same twenty tiles raises no error —
 * the search "works", the comparison fills with wrong products, and the
 * customer blames their query. Elmark and Technopolis were both discovered
 * that way, by hand, months after they had broken. This runs the discovery
 * the customer would have run and reads the answer the way a person would:
 * did it answer, did it answer *something*, and did two different questions
 * get two different answers.
 *
 * The verdict is written on each shop row so the operator screen can show it,
 * and a host that broke since the last check is emailed to the operator. One
 * that was already broken is not — the point is to be woken once.
 */
@Injectable()
export class ShopHealthService implements OnModuleInit {
  private readonly logger = new Logger(ShopHealthService.name);

  private readonly config: ShopHealthConfig;
  private readonly mailConfig: MailConfig;

  private current: Promise<ShopHealthReportDto> | null = null;

  constructor(
    @InjectRepository(Shop) private readonly shops: Repository<Shop>,
    @InjectRepository(SearchCache) private readonly cache: Repository<SearchCache>,
    private readonly discovery: DiscoveryService,
    private readonly mail: MailService,
    private readonly schedulerRegistry: SchedulerRegistry,
    configService: ConfigService<Configuration, true>,
  ) {
    this.config = configService.get('shopHealth', { infer: true });
    this.mailConfig = configService.get('mail', { infer: true });
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.warn('Supplier search health check is disabled (SHOP_HEALTH_ENABLED=false).');
      return;
    }

    const job = new CronJob(this.config.cron, () => {
      void this.run('schedule');
    });

    this.schedulerRegistry.addCronJob(SHOP_HEALTH_CRON_JOB, job);
    job.start();

    this.logger.log(`Supplier search health check registered with cron "${this.config.cron}".`);
  }

  /** The last verdict per host, for the operator screen. No network. */
  async report(): Promise<ShopHealthReportDto> {
    // The same set the check covers, `isActive` included. A shop nobody
    // searches has no health to report, and listing one leaves a row that
    // reads "unchecked" for ever — a fault to chase that is not there.
    const shops = await this.shops.find({
      where: { hasWebsite: true, searchMethod: In(['live', 'sitemap']), isActive: true },
      order: { host: 'ASC' },
    });

    return {
      enabled: this.config.enabled,
      cron: this.config.cron,
      running: this.current !== null,
      hosts: this.summarise(shops),
    };
  }

  /**
   * Runs the check now. Safe to call while one is running — the caller joins
   * it rather than doubling every request to every supplier.
   */
  run(trigger: 'schedule' | 'manual'): Promise<ShopHealthReportDto> {
    if (this.current) return this.current;

    this.current = this.execute(trigger).finally(() => {
      this.current = null;
    });

    return this.current;
  }

  private async execute(trigger: 'schedule' | 'manual'): Promise<ShopHealthReportDto> {
    const startedAt = Date.now();
    const shops = await this.shops.find({
      where: { hasWebsite: true, searchMethod: In(['live', 'sitemap']), isActive: true },
    });

    // One probe per distinct way of searching, not per row. Two customers
    // buying from the same wholesaler have two rows and one search page, and
    // asking it twice tells us nothing the first answer did not.
    const groups = new Map<string, Shop[]>();
    for (const shop of shops) {
      const key = `${normaliseHost(shop.host)}|${shop.searchMethod}|${shop.searchUrlTemplate ?? ''}`;
      groups.set(key, [...(groups.get(key) ?? []), shop]);
    }

    const newlyBroken: ShopHealthDto[] = [];
    const stillBroken: ShopHealthDto[] = [];
    const queue = [...groups.values()];

    const worker = async () => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        const representative = group[0];
        const verdict = await this.check(representative);
        const wasHealthy = group.some(
          (shop) => shop.healthStatus === 'ok' || shop.healthStatus === null,
        );

        await this.shops.update(
          { id: In(group.map((shop) => shop.id)) },
          {
            healthStatus: verdict.status,
            healthDetail: verdict.detail,
            healthCheckedAt: new Date(),
          },
        );

        for (const shop of group) {
          shop.healthStatus = verdict.status;
          shop.healthDetail = verdict.detail;
          shop.healthCheckedAt = new Date();
        }

        if (verdict.status !== 'ok') {
          const row = this.summarise(group)[0];
          (wasHealthy ? newlyBroken : stillBroken).push(row);
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const hosts = this.summarise(shops);
    const broken = hosts.filter((host) => host.status !== 'ok').length;

    this.logger.log(
      `Supplier search check (${trigger}): ${groups.size} searches probed, ${broken} not answering, ` +
        `${newlyBroken.length} newly, in ${Math.round((Date.now() - startedAt) / 1000)}s.`,
    );

    if (newlyBroken.length > 0) {
      await this.notify(newlyBroken, stillBroken);
    }

    return { enabled: this.config.enabled, cron: this.config.cron, running: false, hosts };
  }

  private async check(shop: Shop): Promise<Verdict> {
    const [first, second] = await this.queriesFor(shop);

    try {
      const a = await this.discovery.probeSearch(shop, first);
      const b = await this.discovery.probeSearch(shop, second);

      return classify({ query: first, result: a }, { query: second, result: b });
    } catch (error) {
      // The search path reports its own failures as `ok: false`; anything that
      // escapes it is ours, and still a shop nobody can search right now.
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'error', detail: `Проверката не завърши: ${reason}` };
    }
  }

  /**
   * Two questions for this shop: one it is known to have answered, if any, and
   * a different generic one.
   *
   * The cache holds every successful search with results, which makes it a
   * record of what each shop demonstrably stocks. Probing an electrical
   * wholesaler with "лампа" and reading the empty page as a broken search is
   * the mistake this avoids; a query that returned products last week and
   * returns none today is evidence in a way a guess never is.
   */
  private async queriesFor(shop: Shop): Promise<[string, string]> {
    const known = await this.cache
      .createQueryBuilder('cache')
      .where('cache.shop_id = :shopId', { shopId: shop.id })
      .andWhere("jsonb_array_length(cache.products) > 0")
      .orderBy('cache.fetched_at', 'DESC')
      .getOne()
      .catch(() => null);

    const first = known?.query ?? GENERIC_PROBES[0];
    const second = GENERIC_PROBES.find((probe) => probe !== first) ?? GENERIC_PROBES[1];

    return [first, second];
  }

  private summarise(shops: Shop[]): ShopHealthDto[] {
    const byHost = new Map<string, Shop[]>();
    for (const shop of shops) {
      const host = normaliseHost(shop.host);
      byHost.set(host, [...(byHost.get(host) ?? []), shop]);
    }

    return [...byHost.entries()]
      .map(([host, rows]) => {
        // The worst verdict across the rows wins: the operator is looking for
        // what to fix, and a host that is fine for one customer and broken
        // for another is broken.
        const worst = rows.reduce<Shop>(
          (acc, shop) => (rank(shop.healthStatus) > rank(acc.healthStatus) ? shop : acc),
          rows[0],
        );

        return {
          host,
          name: worst.name,
          method: worst.searchMethod,
          status: worst.healthStatus,
          detail: worst.healthDetail,
          checkedAt: worst.healthCheckedAt ? worst.healthCheckedAt.toISOString() : null,
          accounts: new Set(rows.map((shop) => shop.ownerId)).size,
        };
      })
      .sort((a, b) => rank(b.status) - rank(a.status) || a.host.localeCompare(b.host));
  }

  private async notify(newlyBroken: ShopHealthDto[], stillBroken: ShopHealthDto[]): Promise<void> {
    const to = this.mailConfig.operatorEmail;

    if (!to) {
      this.logger.warn(
        `${newlyBroken.length} supplier search(es) stopped answering and nobody is configured to hear it. Set OPERATOR_EMAIL.`,
      );
      return;
    }

    const subject =
      newlyBroken.length === 1
        ? `Търсачката на ${newlyBroken[0].host} спря да отговаря`
        : `${newlyBroken.length} търсачки на доставчици спряха да отговарят`;

    const describe = (row: ShopHealthDto): [string, string] => [
      `${row.host} (${row.accounts} ${row.accounts === 1 ? 'клиент' : 'клиента'})`,
      `${STATUS_LABEL[row.status ?? 'error']} — ${row.detail ?? ''}`,
    ];

    const { html, text } = renderEmail({
      title: subject,
      preheader: 'Клиентите с тези доставчици получават сравнение без тях.',
      heading: subject,
      appUrl: this.mailConfig.appUrl,
      supportEmail: this.mailConfig.supportEmail,
      body: [
        paragraph(
          'Дневната проверка зададе два различни въпроса на всяка търсачка. Тези отговориха така, че сравнението вече не може да разчита на тях:',
        ),
        dataRows(newlyBroken.map(describe)),
        ...(stillBroken.length > 0
          ? [
              paragraph(`Продължават да не отговарят от предишни проверки: ${stillBroken.length}.`),
              dataRows(stillBroken.map(describe)),
            ]
          : []),
        noticeBox(
          `Отворете <strong>${escapeHtml(this.mailConfig.appUrl)}</strong> → Операторски панел → Обиколка, за да видите всички търсачки и да пуснете проверката отново.`,
          'info',
        ),
      ],
      footnotes: [
        'Това писмо се праща само когато търсачка спре — не всеки ден, докато е спряла.',
      ],
    });

    const sent = await this.mail.deliver(to, subject, html, text);

    if (!sent) {
      this.logger.warn(`Could not email the operator about ${newlyBroken.length} broken search(es).`);
    }
  }
}

const STATUS_LABEL: Record<ShopHealthStatus, string> = {
  ok: 'отговаря',
  empty: 'без резултати',
  ignores_query: 'не чете заявката',
  error: 'грешка',
};

/** Severity, for sorting the operator's list with the fixes on top. */
function rank(status: ShopHealthStatus | null): number {
  switch (status) {
    case 'error':
      return 4;
    case 'ignores_query':
      return 3;
    case 'empty':
      return 2;
    case null:
      return 1;
    default:
      return 0;
  }
}

function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}
