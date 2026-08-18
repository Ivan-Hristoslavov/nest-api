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
import { Owner } from '../common/decorators/owner.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CompetitorsService } from './competitors.service';
import { CreateCompetitorDto } from './dto/create-competitor.dto';
import { PriceCheckResultDto } from './dto/price-check-result.dto';
import { RecordPriceDto } from './dto/record-price.dto';
import { UpdateCompetitorDto } from './dto/update-competitor.dto';
import { Competitor } from './entities/competitor.entity';

@ApiTags('Competitors')
@ApiKeyAuth()
@Controller('products/:productId/competitors')
export class CompetitorsController {
  constructor(private readonly competitorsService: CompetitorsService) {}

  @Get()
  @ApiOperation({
    summary: 'List the competitor listings of a product',
    description: 'Primary listing first, then cheapest to most expensive.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiOkResponse({ description: 'Competitor listings.', type: Competitor, isArray: true })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  findAll(
    @Owner() ownerId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
  ): Promise<Competitor[]> {
    return this.competitorsService.findAllForProduct(ownerId, productId);
  }

  @Post()
  @ApiOperation({
    summary: 'Track another competitor for this product',
    description:
      'Adds a rival listing. The product price becomes the cheapest across all its active listings.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiCreatedResponse({ description: 'Competitor added.', type: Competitor })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'This URL is already tracked for the product.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'No product with this id.', type: ErrorResponseDto })
  create(
    @Owner() ownerId: string,
    @Param('productId', new ParseUUIDPipe({ version: '4' })) productId: string,
    @Body() dto: CreateCompetitorDto,
  ): Promise<Competitor> {
    return this.competitorsService.create(ownerId, productId, dto);
  }

  @Patch(':competitorId')
  @ApiOperation({ summary: 'Update a competitor listing' })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'competitorId', format: 'uuid' })
  @ApiOkResponse({ description: 'Updated listing.', type: Competitor })
  @ApiNotFoundResponse({ description: 'No competitor with this id.', type: ErrorResponseDto })
  update(
    @Owner() ownerId: string,
    @Param('competitorId', new ParseUUIDPipe({ version: '4' })) competitorId: string,
    @Body() dto: UpdateCompetitorDto,
  ): Promise<Competitor> {
    return this.competitorsService.update(ownerId, competitorId, dto);
  }

  @Delete(':competitorId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Stop tracking a competitor listing',
    description: 'The primary listing cannot be deleted — promote another one first.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'competitorId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Listing deleted.' })
  @ApiBadRequestResponse({
    description: 'Attempted to delete the primary listing.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: 'No competitor with this id.', type: ErrorResponseDto })
  remove(
    @Owner() ownerId: string,
    @Param('competitorId', new ParseUUIDPipe({ version: '4' })) competitorId: string,
  ): Promise<void> {
    return this.competitorsService.remove(ownerId, competitorId);
  }

  @Patch(':competitorId/promote')
  @ApiOperation({
    summary: 'Make this listing the primary one',
    description: "Demotes the current primary and repoints the product's `competitorUrl`.",
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'competitorId', format: 'uuid' })
  @ApiOkResponse({ description: 'The promoted listing.', type: Competitor })
  @ApiNotFoundResponse({ description: 'No competitor with this id.', type: ErrorResponseDto })
  promote(
    @Owner() ownerId: string,
    @Param('competitorId', new ParseUUIDPipe({ version: '4' })) competitorId: string,
  ): Promise<Competitor> {
    return this.competitorsService.promoteToPrimary(ownerId, competitorId);
  }

  @Post(':competitorId/prices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a price for this listing manually',
    description:
      'Applies an externally obtained price exactly as the scraper would: updates the listing, appends to the price history, recomputes the product and raises any alerts.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiParam({ name: 'competitorId', format: 'uuid' })
  @ApiOkResponse({ description: 'Observation applied.', type: PriceCheckResultDto })
  @ApiNotFoundResponse({ description: 'No competitor with this id.', type: ErrorResponseDto })
  async recordPrice(
    @Owner() ownerId: string,
    @Param('competitorId', new ParseUUIDPipe({ version: '4' })) competitorId: string,
    @Body() dto: RecordPriceDto,
  ): Promise<PriceCheckResultDto> {
    // `applyPriceObservation` takes a bare id and is also called by the
    // background sweep, so entitlement is proved here before it is reached.
    // Without this, a caller could write prices onto another account's listing.
    await this.competitorsService.findOne(ownerId, competitorId);

    return this.competitorsService.applyPriceObservation(competitorId, {
      price: dto.price,
      source: dto.source ?? 'manual',
      strategy: 'manual',
    });
  }
}
