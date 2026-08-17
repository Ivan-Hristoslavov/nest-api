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
import { ScrapeRunResultDto, ScraperStatusDto } from './dto/scrape-run-result.dto';
import { ScraperService } from './scraper.service';

@ApiTags('Scraper')
@ApiKeyAuth()
@Controller('scraper')
export class ScraperController {
  constructor(private readonly scraperService: ScraperService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Scraper status',
    description:
      'Current scheduler configuration, whether a sweep is in flight, how many products are due, and the summary of the last completed sweep.',
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
      'Runs one sweep over the products that are due for a check, in addition to the cron schedule. If a sweep is already running the request returns an empty summary instead of starting a second one.',
  })
  @ApiAcceptedResponse({ description: 'Sweep finished.', type: ScrapeRunResultDto })
  run(): Promise<ScrapeRunResultDto> {
    return this.scraperService.runSweep('manual');
  }

  @Post('products/:id/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-check one product now',
    description: 'Fetches the competitor price for a single product, ignoring its check interval.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product identifier.' })
  @ApiOkResponse({ description: 'Check completed.', type: PriceCheckResultDto })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  refresh(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<PriceCheckResultDto> {
    return this.scraperService.scrapeProductById(id);
  }
}
