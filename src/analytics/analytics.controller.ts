import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { MarketOverviewDto, ProductAnalyticsDto } from './dto/product-analytics.dto';

@ApiTags('Analytics')
@ApiKeyAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Portfolio overview',
    description:
      'How the catalog sits against the market right now: where we win on price, where we are undercut, and the largest moves of the last seven days.',
  })
  @ApiOkResponse({ description: 'Market overview.', type: MarketOverviewDto })
  overview(): Promise<MarketOverviewDto> {
    return this.analyticsService.overview();
  }

  @Get('products/:id')
  @ApiOperation({
    summary: 'Price analytics for one product',
    description:
      'Min, max, average, volatility and trend over the requested window, a per-retailer breakdown showing who sets the market price, and the full observation series ready to plot.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product identifier.' })
  @ApiOkResponse({ description: 'Product analytics.', type: ProductAnalyticsDto })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  forProduct(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: AnalyticsQueryDto,
  ): Promise<ProductAnalyticsDto> {
    return this.analyticsService.forProduct(id, query.days);
  }
}
