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
  listShops(): Promise<
    Array<{ host: string; name: string; searchable: boolean; reason: string | null }>
  > {
    return this.discoveryService.listProviders();
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
  compare(@Query() query: CompareQueryDto): Promise<ComparisonDto> {
    return this.discoveryService.compare(query.q, {
      hosts: query.hosts,
      currency: query.currency,
      inStockOnly: query.inStockOnly,
      limit: query.limit,
    });
  }

  @Get('search')
  @ApiOperation({
    summary: 'Find a product across every shop',
    description:
      'Searches all configured retailers in parallel and returns their product URLs, ready to be tracked — so a product is added by name instead of by pasting a link per shop.\n\nOne shop failing never fails the search: each reports its own outcome.',
  })
  @ApiOkResponse({ description: 'One entry per shop.', type: ShopSearchResultDto, isArray: true })
  search(@Query() query: SearchQueryDto): Promise<ShopSearchResultDto[]> {
    return this.discoveryService.search(query.q, query.hosts);
  }
}
