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
import { CreateProductDto } from './dto/create-product.dto';
import { PriceCheckResultDto } from './dto/price-check-result.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { RecordPriceDto } from './dto/record-price.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { PriceHistory } from './entities/price-history.entity';
import { Product } from './entities/product.entity';
import { CompetitorsService } from './competitors.service';
import { ProductStats, ProductsService } from './products.service';

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
