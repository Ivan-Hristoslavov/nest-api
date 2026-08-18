import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ApiPaginatedResponse } from '../common/swagger/api-paginated-response.decorator';
import { BulkImportDto, BulkImportResultDto } from './dto/bulk-import.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { PriceCheckResultDto } from './dto/price-check-result.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { RecordPriceDto } from './dto/record-price.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { CompetitorsService } from './competitors.service';
import { ProductFacets, ProductStats, ProductsService } from './products.service';

@ApiTags('Products')
@ApiKeyAuth()
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly competitorsService: CompetitorsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Track a new product',
    description:
      'Registers a product for competitor price tracking. The scheduled scraper picks it up on its next sweep.',
  })
  @ApiCreatedResponse({ description: 'Product created.', type: Product })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'A product with this SKU already exists.',
    type: ErrorResponseDto,
  })
  create(@Body() createProductDto: CreateProductDto): Promise<Product> {
    return this.productsService.create(createProductDto);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import up to 500 products at once',
    description: [
      'Adds many products and all their shop links in a single request — the only practical way to onboard a real catalogue.',
      '',
      '**Row isolation.** Every row is written in its own transaction, so one bad link cannot roll back the rest. The response names the failing row and the reason.',
      '',
      '**Idempotent by SKU.** Re-importing an updated export is the normal case: matching products are updated and new shop links merged in.',
      '',
      '**Dry run.** Send `dryRun: true` first to see what a large file would do before it does it.',
      '',
      'Prices are not fetched here — the scheduler picks the new listings up on its next sweep, so one import does not fire a thousand requests at every shop at once.',
    ].join('\n'),
  })
  @ApiOkResponse({ description: 'Per-row outcome.', type: BulkImportResultDto })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  bulkImport(@Body() dto: BulkImportDto): Promise<BulkImportResultDto> {
    return this.productsService.bulkImport(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List tracked products',
    description: 'Returns a filtered, sorted and paginated list of tracked products.',
  })
  @ApiPaginatedResponse(Product, 'Page of tracked products.')
  @ApiBadRequestResponse({ description: 'Invalid query parameters.', type: ErrorResponseDto })
  findAll(@Query() query: QueryProductsDto): Promise<PaginatedResponseDto<Product>> {
    return this.productsService.findAll(query);
  }

  // Declared before ':id' so the literal path is not swallowed by the uuid route.
  @Get('stats')
  @ApiOperation({
    summary: 'Tracking overview',
    description: 'Aggregate counters across all tracked products, for dashboards and monitoring.',
  })
  @ApiOkResponse({
    description: 'Aggregate statistics.',
    schema: {
      type: 'object',
      properties: {
        total: { type: 'number', example: 137 },
        active: { type: 'number', example: 130 },
        inactive: { type: 'number', example: 7 },
        neverScraped: { type: 'number', example: 3 },
        failing: { type: 'number', example: 2 },
        undercut: { type: 'number', example: 11 },
        competitors: { type: 'number', example: 312 },
        averagePrice: { type: 'number', nullable: true, example: 241.37 },
        lastScrapeAt: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          example: '2026-08-17T09:00:03.221Z',
        },
      },
    },
  })
  getStats(): Promise<ProductStats> {
    return this.productsService.getStats();
  }

  // Also before ':id', for the same reason as 'stats'.
  @Get('facets')
  @ApiOperation({
    summary: 'Brands, manufacturers and categories in the catalogue',
    description:
      'Every distinct value with its product count, so the dashboard filters can be built from the data instead of a hard-coded list.',
  })
  @ApiOkResponse({
    description: 'Distinct values, most common first.',
    schema: {
      type: 'object',
      properties: {
        brands: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', example: 'Samsung' },
              count: { type: 'number', example: 12 },
            },
          },
        },
        manufacturers: { type: 'array', items: { type: 'object' } },
        categories: { type: 'array', items: { type: 'object' } },
      },
    },
  })
  getFacets(): Promise<ProductFacets> {
    return this.productsService.getFacets();
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get one tracked product',
    description: 'Includes every competitor listing tracked for the product.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product identifier.' })
  @ApiOkResponse({ description: 'The requested product.', type: Product })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<Product> {
    return this.productsService.findOne(id, true);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a tracked product',
    description: 'Partial update. Only the supplied fields are modified.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product identifier.' })
  @ApiOkResponse({ description: 'Updated product.', type: Product })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() updateProductDto: UpdateProductDto,
  ): Promise<Product> {
    return this.productsService.update(id, updateProductDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Stop tracking a product',
    description: 'Permanently deletes the product and, by cascade, its price history.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product identifier.' })
  @ApiNoContentResponse({ description: 'Product deleted.' })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<void> {
    return this.productsService.remove(id);
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'Price history of a product',
    description: 'Chronological price observations, newest first. Only price changes are recorded.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product identifier.' })
  @ApiPaginatedResponse(PriceHistory, 'Page of price observations.')
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  findPriceHistory(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() pagination: PaginationQueryDto,
  ): Promise<PaginatedResponseDto<PriceHistory>> {
    return this.productsService.findPriceHistory(id, pagination);
  }

  @Post(':id/prices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a price observation manually',
    description:
      'Applies an externally obtained price to the *primary* competitor listing, exactly as the scraper would. Use `POST /products/{id}/competitors/{competitorId}/prices` to target a specific rival.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product identifier.' })
  @ApiOkResponse({ description: 'Observation applied.', type: PriceCheckResultDto })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  async recordPrice(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() recordPriceDto: RecordPriceDto,
  ): Promise<PriceCheckResultDto> {
    const primary = await this.productsService.findPrimaryCompetitor(id);

    return this.competitorsService.applyPriceObservation(primary.id, {
      price: recordPriceDto.price,
      source: recordPriceDto.source ?? 'manual',
      strategy: 'manual',
    });
  }
}
