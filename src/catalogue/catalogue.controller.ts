import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
import { CatalogueService } from './catalogue.service';
import {
  CrawlResultDto,
  CreateShopDto,
  IndexNowDto,
  OfferHitDto,
  SearchOffersDto,
  ShopCheckDto,
  ShopWithCheckDto,
  SuggestionDto,
  UpdateShopDto,
} from './dto/catalogue.dto';
import { Shop } from './entities/shop.entity';

@ApiTags('Catalogue')
@ApiKeyAuth()
@Controller('catalogue')
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get('search')
  @ApiOperation({
    summary: 'Find an article across every indexed shop',
    description:
      "Full-text search over our own copy of the shops' catalogues, cheapest first.\n\nThe ordering is by what *you* pay: the listed price less your negotiated discount for that shop, converted to one currency. A shop with a higher shelf price can therefore rank above one with a lower one, which is the point.\n\nEach hit carries `lastSeenAt`, because a price read three weeks ago is not today's price and should not pretend to be.",
  })
  @ApiOkResponse({
    description: 'Matching offers, cheapest first.',
    type: OfferHitDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid query.', type: ErrorResponseDto })
  search(@Query() query: SearchOffersDto): Promise<OfferHitDto[]> {
    return this.catalogue.search(query);
  }

  @Get('suggest')
  @ApiOperation({
    summary: 'Find articles the index has not read yet',
    description:
      "Matches the query against the shops' sitemaps, whose URL slugs contain the product names. Instant and free — no page is fetched.\n\nThis is what makes the whole catalogue findable before it is crawled: the sitemap knows every article on day one, and only the price is missing. Feed the results to `POST /catalogue/index-now` to get it.",
  })
  @ApiQuery({ name: 'q', description: 'What to look for.', example: 'argus' })
  @ApiOkResponse({ description: 'Candidate pages.', type: SuggestionDto, isArray: true })
  suggest(@Query('q') q?: string): Promise<SuggestionDto[]> {
    return this.catalogue.suggest(q ?? '');
  }

  @Post('index-now')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fetch and index specific pages immediately',
    description:
      'For the article a user just asked about. Bounded to ten pages because this runs while somebody watches a spinner; the background crawl is for volume.',
  })
  @ApiOkResponse({
    description: 'The pages that yielded a price.',
    type: OfferHitDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  indexNow(@Body() dto: IndexNowDto): Promise<OfferHitDto[]> {
    return this.catalogue.indexNow(dto.urls);
  }

  @Get('shops')
  @ApiOperation({ summary: 'Shops whose catalogue is indexed' })
  @ApiOkResponse({ type: Shop, isArray: true })
  listShops(): Promise<Shop[]> {
    return this.catalogue.findShops();
  }

  @Post('shops')
  @ApiOperation({
    summary: 'Add a supplier',
    description:
      'Registers a shop and works out its sitemap from its own robots.txt when one is not supplied. Nothing is crawled yet — call `POST /catalogue/shops/{id}/crawl` for that.',
  })
  @ApiCreatedResponse({ type: ShopWithCheckDto })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  async addShop(@Body() dto: CreateShopDto): Promise<{ shop: Shop; check: ShopCheckDto }> {
    // Checked before it is saved, and the verdict comes back with it: a shop
    // that cannot be read should say so in the same breath, not after an hour
    // of crawling that was never going to find anything.
    const check = await this.catalogue.verify(dto.host);
    const shop = await this.catalogue.addShop({
      ...dto,
      sitemapUrl: check.sitemapUrl ?? undefined,
    });

    return { shop, check };
  }

  @Get('shops/check')
  @ApiOperation({
    summary: 'Can this shop be indexed?',
    description:
      'Answers before anything is saved: does robots.txt allow us, is there a sitemap, and — the question that actually decides it — does a real product page give up a price.\n\nPlenty of shops pass the first two checks and then render their prices with JavaScript. Finding that out after an hour of crawling is finding it out too late.',
  })
  @ApiQuery({ name: 'host', example: 'tmt-elkom.com' })
  @ApiOkResponse({ description: 'The verdict, with the page it was based on.', type: ShopCheckDto })
  checkShop(@Query('host') host: string): Promise<ShopCheckDto> {
    return this.catalogue.verify(host ?? '');
  }

  @Patch('shops/:id')
  @ApiOperation({
    summary: 'Update a supplier',
    description: 'Chiefly for the discount — it decides which shop the comparison calls cheapest.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: Shop })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  updateShop(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateShopDto,
  ): Promise<Shop> {
    return this.catalogue.updateShop(id, dto);
  }

  @Delete('shops/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a supplier and its indexed offers' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Shop deleted.' })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  removeShop(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<void> {
    return this.catalogue.removeShop(id);
  }

  @Post('shops/:id/crawl')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Index the next batch of a shop's catalogue",
    description:
      "Reads the shop's sitemap and fetches a bounded batch of product pages, obeying robots.txt and the same per-host delay as a price check.\n\n**Deliberately incremental.** A catalogue of several thousand pages takes hours at a polite crawl rate — far longer than any HTTP request should live. Each call does `limit` pages and reports how many remain; call it again, from a cron or a button, until `remaining` reaches zero.\n\nUnseen pages are taken first, then the stalest known ones: complete before fresh.",
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Pages to fetch in this batch. Keep it modest — each one is a real HTTP request.',
    example: 50,
  })
  @ApiOkResponse({ description: 'What this batch did.', type: CrawlResultDto })
  @ApiNotFoundResponse({ description: 'No shop, or no sitemap for it.', type: ErrorResponseDto })
  @ApiQuery({
    name: 'match',
    required: false,
    description:
      'Only crawl URLs containing this text. Narrows a night-long catalogue crawl to the corner you actually need — `lampa-led` on a 7500-page sitemap is 114 pages.',
    example: 'lampa-led',
  })
  crawl(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('match') match?: string,
  ): Promise<CrawlResultDto> {
    return this.catalogue.crawl(id, Math.min(Math.max(limit ?? 50, 1), 500), match);
  }
}
