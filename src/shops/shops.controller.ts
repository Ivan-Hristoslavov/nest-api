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
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { ShopProbeService } from '../discovery/shop-probe.service';
import { CreateShopDto, UpdateShopDto } from './dto/shops.dto';
import { Shop } from './entities/shop.entity';
import { ShopsService } from './shops.service';

@ApiTags('Shops')
@ApiKeyAuth()
@Controller('shops')
export class ShopsController {
  constructor(
    private readonly shops: ShopsService,
    private readonly probe: ShopProbeService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Your suppliers',
    description:
      'Who you buy from, what discount you have negotiated with each, and whether their search can be queried live.',
  })
  @ApiOkResponse({ type: Shop, isArray: true })
  list(): Promise<Shop[]> {
    return this.shops.findAll();
  }

  @Post()
  @ApiOperation({
    summary: 'Add a supplier, and work out how to search it',
    description:
      'Registers the shop and then decides for itself how its products can be found, best route first:\n\n1. **Its own search**, where that is available — one request per question and current stock.\n2. **Its sitemap**, where the search is forbidden but the pages are listed. tmt-elkom.com publishes `Disallow: /search?` yet advertises 7553 addresses, and "СВТ" appears in 135 of them; reading eight beats telling the customer their supplier stocks nothing.\n3. **Neither**, said plainly, so nobody keeps re-testing a storefront that renders its search in JavaScript and publishes no sitemap.\n\nThe probe costs a handful of requests once. Pass `probe=false` to skip it and configure the shop by hand.',
  })
  @ApiQuery({
    name: 'probe',
    required: false,
    description: 'Set false to register the shop without working out how to search it.',
  })
  @ApiCreatedResponse({ type: Shop })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  async create(@Body() dto: CreateShopDto, @Query('probe') probe?: string): Promise<Shop> {
    const shop = await this.shops.create(dto);

    // Already configured by hand, or explicitly not wanted.
    if (probe === 'false' || dto.searchUrlTemplate) return shop;

    const result = await this.probe.probe(shop.host);

    return this.shops.applyProbe(shop.id, result);
  }

  @Post(':id/probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Work out again how this shop can be searched',
    description:
      'For a shop that has been rebuilt since it was added — a storefront that has moved to a new platform may have gained a usable search, or lost one.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: Shop })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  async reprobe(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<Shop> {
    const shop = await this.shops.findOne(id);
    const result = await this.probe.probe(shop.host);

    return this.shops.applyProbe(shop.id, result);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a supplier',
    description:
      'Chiefly for the discount — it decides which shop the comparison calls cheapest — and for the search configuration.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: Shop })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateShopDto,
  ): Promise<Shop> {
    return this.shops.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a supplier' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Shop deleted.' })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<void> {
    return this.shops.remove(id);
  }
}
