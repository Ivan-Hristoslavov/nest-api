import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { PriceCheckResultDto } from '../products/dto/price-check-result.dto';
import { ProductsService } from '../products/products.service';
import { ScrapeRunResultDto, ScraperStatusDto } from './dto/scrape-run-result.dto';
import { ScraperService } from './scraper.service';

@ApiTags('Scraper')
@ApiKeyAuth()
@Controller('scraper')
export class ScraperController {
  constructor(
    private readonly scraperService: ScraperService,
    private readonly productsService: ProductsService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'Scraper status',
    description:
      'Active driver, scheduler configuration, whether a sweep is in flight, how many listings are due, and the summary of the last completed sweep.',
  })
  @ApiOkResponse({ description: 'Scraper status.', type: ScraperStatusDto })
  getStatus(): Promise<ScraperStatusDto> {
    return this.scraperService.getStatus();
  }

  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Trigger a price sweep now',
    description:
      'Runs one sweep over the listings that are due for a check, in addition to the cron schedule. If a sweep is already running the request returns an empty summary rather than starting a second one.',
  })
  @ApiAcceptedResponse({ description: 'Sweep finished.', type: ScrapeRunResultDto })
  run(): Promise<ScrapeRunResultDto> {
    return this.scraperService.runSweep('manual');
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
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<PriceCheckResultDto[]> {
    // Resolve first so an unknown id is a clean 404 rather than an empty array.
    await this.productsService.findOne(id);
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
  refresh(
    @Param('competitorId', new ParseUUIDPipe({ version: '4' })) competitorId: string,
  ): Promise<PriceCheckResultDto> {
    return this.scraperService.scrapeCompetitorById(competitorId);
  }
}
