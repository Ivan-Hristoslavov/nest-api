import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { Owner } from '../common/decorators/owner.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { PriceCheckResultDto } from '../products/dto/price-check-result.dto';
import { CompetitorsService } from '../products/competitors.service';
import { ProductsService } from '../products/products.service';
import {
  OwnerScraperStatusDto,
  ScrapeRunResultDto,
  ScraperStatusDto,
} from './dto/scrape-run-result.dto';
import { ScraperService } from './scraper.service';

@ApiTags('Scraper')
@ApiKeyAuth()
@Controller('scraper')
export class ScraperController {
  constructor(
    private readonly scraperService: ScraperService,
    private readonly productsService: ProductsService,
    private readonly competitorsService: CompetitorsService,
  ) {}

  /**
   * The deployment's scraper state. **Operator keys only.**
   *
   * `lastRun.results` holds one row per listing checked by the last sweep, and
   * that sweep walks every tenant's queue — product names, supplier names and
   * prices belonging to accounts other than the caller's. There is no way to
   * hand that to a customer key without publishing one buyer's supplier list
   * to another, so this route is operator-only and
   * {@link getOwnStatus `GET /scraper/status/mine`} is what a customer asks
   * instead.
   */
  @Get('status')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Scraper status (operator key required)',
    description:
      'Active driver, scheduler configuration, whether a sweep is in flight, how many listings are due across the deployment, and the summary of the last completed sweep.\n\n**Operator key only.** The last sweep spans every account, so its per-listing results name other customers\u2019 products and suppliers. Customers use `GET /scraper/status/mine`.',
  })
  @ApiOkResponse({ description: 'Scraper status.', type: ScraperStatusDto })
  @ApiForbiddenResponse({ description: 'Customer key presented.', type: ErrorResponseDto })
  getStatus(): Promise<ScraperStatusDto> {
    return this.scraperService.getStatus();
  }

  /**
   * The same question, answered for one account.
   *
   * Everything here is either a fact about the caller's own listings or a
   * deployment setting that is not a secret (whether checking runs, and on
   * what schedule). Nothing can name another tenant.
   */
  @Get('status/mine')
  @ApiOperation({
    summary: 'Scraper status for your account',
    description:
      'How many of **your** listings are due for a check, whether a refresh of your own listings is running, and whether scheduled checking is on at all.',
  })
  @ApiOkResponse({ description: 'Your scraper status.', type: OwnerScraperStatusDto })
  getOwnStatus(@Owner() ownerId: string): Promise<OwnerScraperStatusDto> {
    return this.scraperService.getOwnerStatus(ownerId);
  }

  /**
   * Sweeps every tenant's due listings. **Operator keys only.**
   *
   * Two reasons this cannot be a customer route. It spends the platform's
   * request budget against suppliers the caller has no relationship with —
   * and the summary it returns is the same cross-tenant payload as
   * `GET /scraper/status`. Customers refresh their own listings with
   * {@link runOwn `POST /scraper/run/mine`}.
   */
  @Post('run')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Trigger a deployment-wide price sweep (operator key required)',
    description:
      'Runs one sweep over every account\u2019s listings that are due for a check, in addition to the cron schedule. If a sweep is already running the request returns an empty summary rather than starting a second one.\n\n**Operator key only.** Customers use `POST /scraper/run/mine`.',
  })
  @ApiAcceptedResponse({ description: 'Sweep finished.', type: ScrapeRunResultDto })
  @ApiForbiddenResponse({ description: 'Customer key presented.', type: ErrorResponseDto })
  run(): Promise<ScrapeRunResultDto> {
    return this.scraperService.runSweep('manual');
  }

  /**
   * Re-checks the caller's own due listings.
   *
   * The customer-facing refresh. Bounded by the same batch size as the
   * scheduled sweep, and one at a time per account — a second press joins the
   * first rather than doubling the requests made to that account's suppliers.
   */
  @Post('run/mine')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Re-check your own listings now',
    description:
      'Checks the listings **of your account** that are due, ignoring the cron schedule. Results cover only your own products.\n\nIf a refresh for your account is already running, this joins it instead of starting a second one.',
  })
  @ApiAcceptedResponse({ description: 'Refresh finished.', type: ScrapeRunResultDto })
  runOwn(@Owner() ownerId: string): Promise<ScrapeRunResultDto> {
    return this.scraperService.runOwnerSweep(ownerId);
  }

  @Post('trigger/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Scrape one product now (real fetch)',
    description: [
      'Fetches every active competitor listing of the product **immediately**, ignoring the check interval, and writes the results to the database.',
      '',
      'With `SCRAPER_DRIVER=http` this performs a real HTTP request to each competitor URL, parses the page and updates `current_price` and `last_updated`. Use it to verify a new listing end to end from Swagger.',
      '',
      'Never fails because a retailer did: a 403, a 404, a timeout or a changed page layout are recorded on the listing and reported in the response, with `status: "failed"` and the reason in `error`.',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'Product identifier.',
    example: '6b0d9b4a-4a4e-4d51-9e2c-1f2f6f7f9a10',
  })
  @ApiOkResponse({
    description: 'One result per competitor listing that was checked.',
    type: PriceCheckResultDto,
    isArray: true,
  })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  async trigger(
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<PriceCheckResultDto[]> {
    // Resolves first, which makes an unknown id a clean 404 rather than an
    // empty array — and refuses another customer's product, which would
    // otherwise be a way to make us fetch pages on their behalf.
    await this.productsService.findOne(ownerId, id);
    return this.scraperService.scrapeProductById(id);
  }

  @Post('competitors/:competitorId/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-check one competitor listing now',
    description: 'Fetches a single listing, ignoring the check interval.',
  })
  @ApiParam({ name: 'competitorId', format: 'uuid', description: 'Competitor identifier.' })
  @ApiOkResponse({ description: 'Check completed.', type: PriceCheckResultDto })
  @ApiNotFoundResponse({ description: 'No competitor with this id.', type: ErrorResponseDto })
  async refresh(
    @Owner() ownerId: string,
    @Param('competitorId', new ParseUUIDPipe({ version: '4' })) competitorId: string,
  ): Promise<PriceCheckResultDto> {
    // Proved before the fetch. Otherwise any key could make us go and read a
    // page on behalf of another account's listing, and write the result to it.
    await this.competitorsService.findOne(ownerId, competitorId);

    return this.scraperService.scrapeCompetitorById(competitorId);
  }
}
