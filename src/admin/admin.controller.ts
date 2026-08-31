import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { BillingEvent } from '../billing/entities/billing-event.entity';
import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { OptimiserStats, OptimiserStatsService } from '../pricing/optimiser-stats.service';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { ScrapeRunResultDto } from '../scraper/dto/scrape-run-result.dto';
import { AdminService, WINDOW_CHOICES } from './admin.service';
import { DecisionsAdminService } from './decisions-admin.service';
import {
  AdminDecisionsPageDto,
  CustomerPurchasingDto,
  DecisionAnalyticsDto,
} from './dto/decisions-admin.dto';
import { AdminAlertDto, ScrapeReportDto } from './dto/operations.dto';
import { OperationsService } from './operations.service';
import {
  OutreachDraftDto,
  PreviewOutreachDto,
  SendOutreachDto,
  UpdateOutreachDto,
} from './dto/outreach.dto';
import { AdminOverviewDto } from './dto/overview.dto';
import { SearchDebugDto, SearchDebugQueryDto } from './dto/search-debug.dto';
import { DiscoveryService } from '../discovery/discovery.service';
import { SearchMetricsService, SearchQualityStats } from '../discovery/search-metrics.service';
import { OptionalOwner } from '../common/decorators/owner.decorator';
import { ShopUsageDto } from './dto/shop-usage.dto';
import { ApiOutreach } from './entities/api-outreach.entity';
import { OutreachService } from './outreach.service';

/**
 * The operator's view across every customer.
 *
 * Separate from the tenant-scoped controllers on purpose: everything they
 * expose is filtered by owner, and the questions here — how many accounts,
 * which sites we hit, did the webhooks land — are exactly the ones that have
 * no owner. Keeping them in their own controller means the operator surface
 * is one file to audit rather than a flag spread across nine.
 */
@ApiTags('Admin')
@ApiKeyAuth()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly optimiserStats: OptimiserStatsService,
    private readonly admin: AdminService,
    private readonly outreach: OutreachService,
    private readonly operations: OperationsService,
    private readonly decisions: DecisionsAdminService,
    private readonly discovery: DiscoveryService,
    private readonly searchMetrics: SearchMetricsService,
  ) {}

  @Get('search/quality')
  @ApiOperation({
    summary: 'Is search any good this afternoon',
    description:
      'The measurable half of "does search work": how often a query produces a strong match, how often it produces nothing, how much of the work arithmetic settles without a model, how often a supplier had to be asked a second, wider question, and how long all of it takes.\n\nHeld in memory over the last few hundred searches, so a deploy resets it. Nothing here identifies a customer or names an article.',
  })
  @ApiOkResponse({ description: 'Search quality over the recent window.', type: Object })
  searchQuality(): SearchQualityStats {
    return this.searchMetrics.stats();
  }

  @Get('search/debug')
  @ApiOperation({
    summary: 'Why did this search do that',
    description:
      'One search, traced end to end: the query as typed, what the engine read out of it, the spellings each supplier was asked, what each supplier answered, and then — for every candidate — the relation, the confidence, which attributes agreed, which were never mentioned and which clashed.\n\nThis is the support tool. A customer says "it did not find the pipe I buy every week"; this says whether the supplier answered, whether the title was read correctly, and which attribute decided against it.\n\nRuns live and without the cache by default, and without a model unless asked — a trace of a cached answer is a trace of an afternoon ago, and paying for a model to reproduce a complaint is rarely the point.',
  })
  @ApiOkResponse({ description: 'Every stage of the search, in order.', type: SearchDebugDto })
  async debugSearch(
    @OptionalOwner() callerId: string | null,
    @Query() query: SearchDebugQueryDto,
  ): Promise<SearchDebugDto> {
    // An operator key belongs to nobody, so there is no supplier list to
    // search unless the request names one. Said plainly rather than answering
    // with an empty trace, which reads as "search found nothing" and sends the
    // support conversation down the wrong path entirely.
    const ownerId = query.ownerId ?? callerId;

    if (!ownerId) {
      throw new BadRequestException(
        "An operator key has no supplier list of its own. Pass ownerId to trace a search on a customer's suppliers.",
      );
    }

    const result = await this.discovery.compare(ownerId, query.q, {
      useAi: query.ai === true,
      useCache: query.useCache === true,
      scope: query.scope,
      trace: true,
    });

    return result.trace as unknown as SearchDebugDto;
  }

  @Get('overview')
  @ApiOperation({
    summary: 'Everything the operator panel opens on',
    description:
      'Customer counts, workload totals, webhook health, scrape health, and thirty days of signups and billing events — assembled in one response so the screen arrives whole.',
  })
  @ApiQuery({ name: 'days', required: false, enum: [...WINDOW_CHOICES] })
  @ApiOkResponse({ type: AdminOverviewDto })
  overview(@Query('days') days?: string): Promise<AdminOverviewDto> {
    const parsed = Number.parseInt(days ?? '', 10);

    // Chosen from a fixed set rather than clamped to a range: an arbitrary
    // number of days is a query somebody can make expensive from the outside,
    // and three ranges is what the screen actually offers.
    const window = WINDOW_CHOICES.find((choice) => choice === parsed);

    return this.admin.overview(window);
  }

  @Get('shops')
  @ApiOperation({
    summary: 'Supplier sites in use, across all customers',
    description:
      'One row per host, with how many customers configured it and what it last did. A selector that broke on a host three customers share is three complaints; this is where that shows.',
  })
  @ApiOkResponse({ type: ShopUsageDto, isArray: true })
  shops(): Promise<ShopUsageDto[]> {
    return this.admin.shopUsage();
  }

  @Get('events')
  @ApiOperation({
    summary: 'Billing webhooks received',
    description:
      'The raw events, newest first — the first place to look when a customer says they paid and got nothing. `unprocessed=true` narrows it to exactly those.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'unprocessed', required: false, example: false })
  @ApiOkResponse({ type: BillingEvent, isArray: true })
  events(
    @Query('limit') limit?: string,
    @Query('unprocessed') unprocessed?: string,
  ): Promise<BillingEvent[]> {
    const parsed = Number.parseInt(limit ?? '50', 10);
    const capped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;

    return this.admin.recentEvents(capped, unprocessed === 'true');
  }

  /* --- Asking a supplier for a feed -------------------------------------
   *
   * Two steps on purpose. Composing and sending are one action everywhere
   * else in this API because nobody reads a receipt before it goes; this is
   * the one letter written to a stranger in their own language on our behalf,
   * and it should not leave without a person having read it.
   */

  @Get('outreach')
  @ApiOperation({
    summary: 'Suppliers we have written to',
    description: 'One record per host, newest first, with whatever came back.',
  })
  @ApiOkResponse({ type: ApiOutreach, isArray: true })
  outreachList(): Promise<ApiOutreach[]> {
    return this.outreach.findAll();
  }

  @Post('outreach/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compose the letter without sending it',
    description:
      'Returns the subject and body in the language the domain suggests, along with how many customers already track the site. Nothing is stored and nothing is sent.',
  })
  @ApiOkResponse({ type: OutreachDraftDto })
  @ApiNotFoundResponse({ description: 'No customer has added this site.', type: ErrorResponseDto })
  outreachPreview(@Body() dto: PreviewOutreachDto): Promise<OutreachDraftDto> {
    return this.outreach.draft(dto.host, dto.locale);
  }

  @Post('outreach')
  @ApiOperation({
    summary: 'Send the letter',
    description:
      "Sends exactly the subject and body given — the operator's edits, not a freshly rendered template — and records what went out. Refuses a host that has already been written to.",
  })
  @ApiCreatedResponse({ type: ApiOutreach })
  @ApiConflictResponse({
    description: 'This host has already been approached.',
    type: ErrorResponseDto,
  })
  outreachSend(@Body() dto: SendOutreachDto): Promise<ApiOutreach> {
    return this.outreach.send(dto);
  }

  @Patch('outreach/:id')
  @ApiOperation({
    summary: 'Record what came back',
    description: 'Moves a letter to replied, granted or declined, with a note in your own words.',
  })
  @ApiOkResponse({ type: ApiOutreach })
  @ApiNotFoundResponse({ description: 'No such record.', type: ErrorResponseDto })
  outreachUpdate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateOutreachDto,
  ): Promise<ApiOutreach> {
    return this.outreach.update(id, dto);
  }

  /* --- Operations -------------------------------------------------------
   *
   * The two screens that answer "is the machine working", as opposed to "is
   * the business working". Both read across every customer, which is why they
   * live here and not on the tenant-scoped controllers.
   */

  /**
   * How the order optimiser has been behaving.
   *
   * Counters only — no customer, no article, no price. What an operator needs
   * is whether plans are being found and how long that takes, not what anybody
   * is buying.
   *
   * Held in memory over the last few hundred runs, so a deploy resets it. That
   * is the right trade for an operational gauge: a table would write a row on
   * the hot path of every basket to answer a question nobody asks after the
   * afternoon it was written.
   */

  /* --- Purchase decisions ------------------------------------------------
   *
   * What customers decided, and whether the machine that advised them is
   * working. Read across every account, which is exactly why these routes live
   * behind `AdminGuard` in this controller rather than beside the customer's
   * own decision endpoints — the tenant-scoped service there has no method
   * that could return another account's row, and it keeps that property by
   * never growing one.
   *
   * None of these returns a snapshot. The shape of a decision answers every
   * operational question; the contents would say what a customer buys.
   */

  @Get('purchase-decisions')
  @ApiOperation({
    summary: 'Decisions kept, across every customer',
    description:
      'Newest first, with the customer, the size of the basket, the baseline, what was chosen, what it saved, how hard the optimiser worked, and whether it turned into orders.\n\nThe snapshot is not included: the shape of a decision answers the operational questions, and the contents would show what a customer buys.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'ownerId', required: false, description: 'Narrow to one customer.' })
  @ApiOkResponse({ type: AdminDecisionsPageDto })
  purchaseDecisions(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('ownerId') ownerId?: string,
  ): Promise<AdminDecisionsPageDto> {
    return this.decisions.list(
      clamp(limit, 50, 1, 200),
      clamp(offset, 0, 0, 100_000),
      ownerId || undefined,
    );
  }

  @Get('purchase-decisions/analytics')
  @ApiOperation({
    summary: 'Is the optimiser earning its keep',
    description:
      'Counted over decisions customers chose to keep, which is the honest denominator — a comparison somebody ran and walked away from says nothing about whether the advice was worth taking. `GET /admin/optimiser` counts every run, including the ones that found nothing.\n\nPotential and realized savings are reported separately and are never added together.',
  })
  @ApiQuery({ name: 'days', required: false, enum: [...WINDOW_CHOICES] })
  @ApiOkResponse({ type: DecisionAnalyticsDto })
  decisionAnalytics(@Query('days') days?: string): Promise<DecisionAnalyticsDto> {
    const parsed = Number.parseInt(days ?? '', 10);
    const window = WINDOW_CHOICES.find((choice) => choice === parsed) ?? 30;

    return this.decisions.analytics(window);
  }

  @Get('customers/:ownerId/purchasing')
  @ApiOperation({
    summary: 'One customer’s purchasing activity',
    description:
      'The founder’s question rather than the buyer’s: is this account getting enough out of the product to keep paying for it?\n\nDecisions kept, orders placed off them, orders confirmed, the suppliers they keep landing on, and both savings figures — potential and realized, side by side and never summed together.',
  })
  @ApiQuery({ name: 'days', required: false, enum: [...WINDOW_CHOICES] })
  @ApiOkResponse({ type: CustomerPurchasingDto })
  customerPurchasing(
    @Param('ownerId', ParseUUIDPipe) ownerId: string,
    @Query('days') days?: string,
  ): Promise<CustomerPurchasingDto> {
    const parsed = Number.parseInt(days ?? '', 10);
    const window = WINDOW_CHOICES.find((choice) => choice === parsed) ?? 30;

    return this.decisions.customerPurchasing(ownerId, window);
  }

  @Get('optimiser')
  @ApiOperation({
    summary: 'Order optimiser health',
    description:
      'Duration, how many suppliers were considered and chosen, how often no placeable plan was found, and how often the search space had to be capped. In-memory over the last 200 runs.',
  })
  @ApiOkResponse({ description: 'Optimiser counters.' })
  optimiser(): OptimiserStats {
    return this.optimiserStats.snapshot();
  }

  @Get('scrape')
  @ApiOperation({
    summary: 'How the price sweep is doing',
    description:
      'Scheduler state, failures grouped by the site they happen on, and listings nobody has managed to re-price for over a day.',
  })
  @ApiOkResponse({ type: ScrapeReportDto })
  scrape(): Promise<ScrapeReportDto> {
    return this.operations.scrapeReport();
  }

  @Post('scrape/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Run a sweep now',
    description:
      'The same work the cron does, started by hand. Returns an empty summary rather than starting a second sweep if one is already running.',
  })
  @ApiOkResponse({ type: ScrapeRunResultDto })
  runSweep(): Promise<ScrapeRunResultDto> {
    return this.operations.runSweep();
  }

  @Get('alerts')
  @ApiOperation({
    summary: 'Recent alerts, across every customer',
    description:
      'With the product and the customer they belong to, and whether they reached a channel. `undelivered=true` narrows it to the ones that did not.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 100 })
  @ApiQuery({ name: 'undelivered', required: false, example: false })
  @ApiOkResponse({ type: AdminAlertDto, isArray: true })
  alerts(
    @Query('limit') limit?: string,
    @Query('undelivered') undelivered?: string,
  ): Promise<AdminAlertDto[]> {
    const parsed = Number.parseInt(limit ?? '100', 10);
    const capped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 300) : 100;

    return this.operations.recentAlerts(capped, undelivered === 'true');
  }
}

/**
 * A query-string number, bounded.
 *
 * Bounded rather than trusted: `limit` reaches an ORDER BY over a table that
 * grows with every decision every customer keeps, and an unbounded one is a
 * query anybody with an operator key can make expensive by accident.
 */
function clamp(value: string | undefined, fallback: number, low: number, high: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, low), high) : fallback;
}
