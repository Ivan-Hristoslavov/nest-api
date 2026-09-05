import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  BadRequestException,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiConflictResponse,
  ApiConsumes,
  ApiBody,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { Owner } from '../common/decorators/owner.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { PurgeQueryDto } from '../common/dto/purge-query.dto';
import { ShopProbeService } from '../discovery/shop-probe.service';
import {
  ImportManualPricesDto,
  ImportResultDto,
  ManualPriceDto,
  UploadPriceListResultDto,
} from './dto/manual-prices.dto';
import { parsePriceList } from './price-list-parser';
import { CreateShopDto, UpdateShopDto } from './dto/shops.dto';
import { ManualPrice } from './entities/manual-price.entity';
import { Shop } from './entities/shop.entity';
import { ManualPricesService } from './manual-prices.service';
import { ShopsService } from './shops.service';

@ApiTags('Shops')
@ApiKeyAuth()
@Controller('shops')
export class ShopsController {
  constructor(
    private readonly shops: ShopsService,
    private readonly probe: ShopProbeService,
    private readonly manualPrices: ManualPricesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Your suppliers',
    description:
      'Who you buy from, what discount you have negotiated with each, and whether their search can be queried live.',
  })
  @ApiOkResponse({ type: Shop, isArray: true })
  list(@Owner() ownerId: string): Promise<Shop[]> {
    return this.shops.findAll(ownerId);
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
  async create(
    @Owner() ownerId: string,
    @Body() dto: CreateShopDto,
    @Query('probe') probe?: string,
  ): Promise<Shop> {
    const shop = await this.shops.create(ownerId, dto);

    // Already configured by hand, explicitly not wanted, or a supplier with no
    // website at all — probing one of those means fetching a robots.txt that
    // does not exist to learn what we were already told.
    if (probe === 'false' || dto.searchUrlTemplate || dto.hasWebsite === false) return shop;

    const result = await this.probe.probe(shop.host);

    return this.shops.applyProbe(ownerId, shop.id, result);
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
  async reprobe(
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<Shop> {
    const shop = await this.shops.findOne(ownerId, id);
    const result = await this.probe.probe(shop.host);

    return this.shops.applyProbe(ownerId, shop.id, result);
  }

  @Get(':id/prices')
  @ApiOperation({
    summary: 'Prices you entered for a supplier with no website',
    description:
      'The local warehouse that publishes nothing but is often the cheapest. These figures join the same ranked comparison as the scraped ones, carrying the same discount — the difference is that nothing re-reads them, so each row states when it was last confirmed.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ManualPrice, isArray: true })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  listPrices(
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ManualPrice[]> {
    return this.manualPrices.findForShop(ownerId, id);
  }

  @Post(':id/prices')
  @ApiOperation({
    summary: 'Record one price for a supplier with no website',
    description:
      "Replaces the figure already held for this article, keyed on the supplier's article number where there is one and on the name otherwise.",
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiCreatedResponse({ type: ManualPrice })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  addPrice(
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ManualPriceDto,
  ): Promise<ManualPrice> {
    return this.manualPrices.upsert(ownerId, id, dto);
  }

  @Post(':id/prices/import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Import a whole price list',
    description:
      'How these suppliers actually send prices: a spreadsheet by email, once a quarter. Typing four hundred rows by hand is how a good idea stops being used in week two.\n\nRe-importing updates rather than duplicates, so the same list can be sent again when the supplier revises it.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ImportResultDto })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  importPrices(
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ImportManualPricesDto,
  ): Promise<ImportResultDto> {
    return this.manualPrices.importList(ownerId, id, dto.prices);
  }

  @Post(':id/prices/upload')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      // Five megabytes is a price list with tens of thousands of rows; the
      // import itself is capped at five thousand, so anything larger is not
      // a price list.
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOperation({
    summary: 'Upload a price list as the supplier sent it',
    description:
      'The Excel sheet or CSV a supplier emails, taken as it is. Headers in Bulgarian or English or none at all; prices written „1 234,56" or „1.42 лв"; windows-1251 or UTF-8 — the columns are worked out from the headings where there are any and from the values where there are not, and what was read is reported back.\n\nWith `dryRun=true` nothing is written: the response says which column was taken for what and shows the first rows as they would be stored. Without it the rows are imported exactly like `POST /shops/{id}/prices/import` — re-uploading updates rather than duplicates.\n\nRows without a readable price are skipped and listed, not refused: a list with three „по запитване" lines is still a list.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiQuery({ name: 'dryRun', required: false, example: true })
  @ApiOkResponse({ type: UploadPriceListResultDto })
  @ApiBadRequestResponse({ description: 'No file, or one that holds no price list.', type: ErrorResponseDto })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  async uploadPriceList(
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @UploadedFile() file: UploadedPriceList | undefined,
    @Query('dryRun') dryRun?: string,
  ): Promise<UploadPriceListResultDto> {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Прикачете файл — Excel или CSV — в полето „file".');
    }

    const shop = await this.shops.findOne(ownerId, id);
    const parsed = parsePriceList(file.buffer, file.originalname ?? '');
    const currency = parsed.currency ?? shop.currency;

    if (parsed.rows.length === 0) {
      throw new BadRequestException(
        parsed.problems[0] ?? 'Във файла не намерих нито един ред с наименование и цена.',
      );
    }

    if (parsed.rows.length > 5000) {
      throw new BadRequestException(
        `Файлът има ${parsed.rows.length} реда с цени; наведнъж се качват до 5000.`,
      );
    }

    const rows = parsed.rows.map((row) => ({ ...row, currency: row.currency ?? currency }));

    const read = {
      rows: rows.length,
      skipped: parsed.skipped,
      problems: parsed.problems,
      columns: parsed.columns,
      encoding: parsed.encoding,
      delimiter: parsed.delimiter,
      headerRow: parsed.headerRow,
      currency,
      sample: rows.slice(0, 8) as ManualPriceDto[],
    };

    if (dryRun === 'true' || dryRun === '1') {
      return { read, result: null };
    }

    const result = await this.manualPrices.importList(ownerId, id, rows);

    return { read, result };
  }

  @Delete(':id/prices/:priceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove one hand-entered price' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'priceId', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Removed.' })
  removePrice(
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('priceId', new ParseUUIDPipe({ version: '4' })) priceId: string,
  ): Promise<void> {
    return this.manualPrices.remove(ownerId, id, priceId);
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
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateShopDto,
  ): Promise<Shop> {
    return this.shops.update(ownerId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a supplier',
    description:
      'A supplier carrying hand-entered prices is refused unless `purge=true` is passed: that list was typed off a price sheet and cannot be read back from anywhere.',
  })
  @ApiConflictResponse({
    description: 'The supplier has manual prices and `purge=true` was not passed.',
    type: ErrorResponseDto,
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Shop deleted.' })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  remove(
    @Owner() ownerId: string,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: PurgeQueryDto,
  ): Promise<void> {
    return this.shops.remove(ownerId, id, query.purge);
  }
}

/**
 * What multer hands over. Declared here rather than as `Express.Multer.File`
 * so the controller does not depend on a type package for one field of one
 * request.
 */
interface UploadedPriceList {
  buffer: Buffer;
  originalname?: string;
  size?: number;
}
