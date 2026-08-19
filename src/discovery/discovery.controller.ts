import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { Owner } from '../common/decorators/owner.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { DiscoveryService } from './discovery.service';
import {
  CompareQueryDto,
  ComparisonDto,
  DetectSearchDto,
  DetectedShopDto,
  SearchQueryDto,
  ShopSearchResultDto,
} from './dto/discovery.dto';
import { BasketResultDto, PriceBasketDto } from './dto/basket.dto';
import { SearchDetectorService } from './search-detector.service';

@ApiTags('Discovery')
@ApiKeyAuth()
@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly detector: SearchDetectorService,
  ) {}

  @Get('shops')
  @ApiOperation({
    summary: 'Shops that can be searched',
    description:
      "Retailers with a server-rendered search page. Shops whose search runs client-side cannot be queried this way and are absent rather than listed as broken.\n\n`searchable` is false when the shop's own robots.txt disallows its search path — vario.bg is the current example. Such a shop can still be *tracked*: paste a product link and the scraper will follow it, because the product pages themselves are allowed.",
  })
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          host: { type: 'string', example: 'vario.bg' },
          name: { type: 'string', example: 'Vario' },
          searchable: { type: 'boolean', example: false },
          reason: {
            type: 'string',
            nullable: true,
            example: 'robots.txt на магазина забранява търсене',
          },
        },
      },
    },
  })
  listShops(
    @Owner() ownerId: string,
  ): Promise<Array<{ host: string; name: string; searchable: boolean; reason: string | null }>> {
    return this.discoveryService.listProviders(ownerId);
  }

  @Get('available')
  @ApiOperation({
    summary: 'Shops we already know how to search, that you have not added',
    description:
      'A shelf of verified configurations. Adding one of these makes it searchable immediately — the selectors were checked against the live site — but none of them takes part in a search until you add it.\n\nThat separation is deliberate: a buyer comparing three negotiated suppliers does not want a retailer they hold no account with quietly setting the benchmark.',
  })
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          host: { type: 'string', example: 'emag.bg' },
          name: { type: 'string', example: 'eMAG' },
        },
      },
    },
  })
  listAvailable(
    @Owner() ownerId: string,
  ): Promise<Array<{ host: string; name: string; reason: string | null }>> {
    return this.discoveryService.listAvailable(ownerId);
  }

  @Post('detect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Work out how to search a shop from one example',
    description:
      'The user searches the shop by hand, pastes the resulting address and says what they typed. Everything else — the URL template, the result tiles, the title and price selectors — is inferred from that one page and returned **with sample rows**, so the guess can be checked before it is saved.\n\nNothing is stored. Save the returned template and selectors on the shop with `PATCH /shops/{id}`, and the shop joins the live search — no code change, no deploy.',
  })
  @ApiOkResponse({
    description: 'What was inferred, with samples to judge it by.',
    type: DetectedShopDto,
  })
  @ApiBadRequestResponse({
    description: 'The page could not be read as a list of products.',
    type: ErrorResponseDto,
  })
  async detect(@Body() dto: DetectSearchDto): Promise<DetectedShopDto> {
    try {
      return await this.detector.detect(dto.searchUrl, dto.sampleQuery);
    } catch (error) {
      // The detector speaks in sentences meant for the user ("възможно е
      // магазинът да зарежда резултатите с JavaScript…"). A 400 carries them
      // to the UI; a 500 would bury them in a stack trace.
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  @Get('compare')
  @ApiOperation({
    summary: 'Who sells this cheapest — asked live, right now',
    description:
      'The request this system exists to serve. Every configured shop\'s own search is queried in parallel, and what comes back is ranked by **what you actually pay**: the listed price less your negotiated discount at that shop, converted to one currency. A shop with the higher shelf price can therefore rank first, which is the entire point.\n\nResults are grouped by kind of article, because "кабел" matches bare cable at 0.14 € and a cable drum at 19 €, and one price range across the two is a misreading waiting to happen.\n\nNothing is stored and nothing is crawled: one request per shop per question, never one per article. A supplier with eight thousand items costs exactly what one with eighty costs.',
  })
  @ApiOkResponse({ description: 'Ranked offers, plus what each shop did.', type: ComparisonDto })
  compare(@Owner() ownerId: string, @Query() query: CompareQueryDto): Promise<ComparisonDto> {
    return this.discoveryService.compare(ownerId, query.q, {
      hosts: query.hosts,
      currency: query.currency,
      inStockOnly: query.inStockOnly,
      limit: query.limit,
      useAi: query.ai,
    });
  }

  @Post('basket')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Price a whole order across your suppliers',
    description:
      'The question a buyer actually has. Not "what does this cable cost" but "where do I place this order" — and those have different answers, because no supplier is cheapest on everything.\n\nReturns three figures: what the order costs from each supplier alone, what it costs split across them line by line, and the difference. The last one is the reason to use this, and it is not something five price lists in a spreadsheet give up easily.\n\nA supplier who cannot fill every line is still ranked, with the count of what they cover — "cheapest, but missing three items" is a real answer, and hiding it recommends an order that cannot be placed.\n\nAnswers are reused for six hours by default, which is what makes a forty-line order take seconds rather than eleven minutes. Pass `useCache: false` when the order is about to go out and the figures must be current.',
  })
  @ApiOkResponse({ description: 'The order, priced.', type: BasketResultDto })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  priceBasket(@Owner() ownerId: string, @Body() dto: PriceBasketDto): Promise<BasketResultDto> {
    return this.discoveryService.priceBasket(
      ownerId,
      dto.lines.map((line) => ({ query: line.query, quantity: line.quantity ?? 1 })),
      { currency: dto.currency, useCache: dto.useCache },
    );
  }

  @Get('search')
  @ApiOperation({
    summary: 'Find a product across every shop',
    description:
      'Searches all configured retailers in parallel and returns their product URLs, ready to be tracked — so a product is added by name instead of by pasting a link per shop.\n\nOne shop failing never fails the search: each reports its own outcome.',
  })
  @ApiOkResponse({ description: 'One entry per shop.', type: ShopSearchResultDto, isArray: true })
  search(@Owner() ownerId: string, @Query() query: SearchQueryDto): Promise<ShopSearchResultDto[]> {
    return this.discoveryService.search(ownerId, query.q, query.hosts);
  }
}
