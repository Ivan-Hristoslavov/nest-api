import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Observable, Subject } from 'rxjs';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { Owner } from '../common/decorators/owner.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { DiscoveryService } from './discovery.service';
import {
  CompareQueryDto,
  ComparisonDto,
  DetectSearchDto,
  DetectedShopDto,
  PreviewUrlDto,
  SearchHistoryQueryDto,
  SearchQueryDto,
  ShopSearchResultDto,
  UrlPreviewDto,
} from './dto/discovery.dto';
import { BasketResultDto, PriceBasketDto } from './dto/basket.dto';
import { parseRequest } from './request-parser';
import { SearchDetectorService } from './search-detector.service';
import { SearchHistoryService } from './search-history.service';

@ApiTags('Discovery')
@ApiKeyAuth()
@Controller('discovery')
export class DiscoveryController {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly detector: SearchDetectorService,
    private readonly history: SearchHistoryService,
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
  async detect(
    // Scoped to an account even though nothing is stored: this route makes the
    // server fetch a URL the caller chose, and an unattributable outbound
    // request is one nobody can rate-limit, meter or trace back. The address
    // itself is checked twice — `IsPublicHttpUrl` on the DTO for a fast, clear
    // refusal, and the agent's own lookup on every connection, redirects
    // included.
    @Owner() _ownerId: string,
    @Body() dto: DetectSearchDto,
  ): Promise<DetectedShopDto> {
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
      scope: query.scope,
    });
  }

  /**
   * The same comparison, reported while it happens.
   *
   * Server-sent events rather than one response at the end, because the work
   * takes seconds and is genuinely staged: the query is understood instantly,
   * suppliers answer one at a time over several seconds, matching runs last.
   * A spinner covering all of that is indistinguishable from a hang, and hides
   * the most persuasive thing the product does — showing that it read "12W
   * E27" as a specification before it went looking.
   *
   * Read it with `fetch`, not `EventSource`: the latter cannot send an
   * Authorization header, and this endpoint is scoped to an account like every
   * other.
   */
  @Sse('compare/stream')
  @ApiOperation({
    summary: 'Compare, streamed stage by stage',
    description:
      'Emits `understood` immediately, then one `shop` event per supplier as it answers, then `matching`, then `ai` when a model was consulted, and finally `result` with the same payload as GET /compare. Authenticate with the usual header — read the stream with fetch, since EventSource cannot send one.',
  })
  compareStream(
    @Owner() ownerId: string,
    @Query() query: CompareQueryDto,
  ): Observable<{ data: string }> {
    const events = new Subject<{ data: string }>();
    const emit = (payload: unknown): void => {
      events.next({ data: JSON.stringify(payload) });
    };

    void this.discoveryService
      .compare(ownerId, query.q, {
        hosts: query.hosts,
        currency: query.currency,
        inStockOnly: query.inStockOnly,
        limit: query.limit,
        useAi: query.ai,
        scope: query.scope,
        onProgress: emit,
      })
      .then((result) => emit({ type: 'result', ...result }))
      .catch((error: unknown) => {
        // Errors travel as a final event rather than as a dead connection: a
        // stream that simply stops leaves the interface unable to tell a
        // failure from a slow supplier.
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : 'Търсенето не успя.',
        });
      })
      .finally(() => {
        emit({ type: 'done' });
        events.complete();
      });

    return events.asObservable();
  }

  @Post('basket')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Price a whole order across your suppliers',
    description:
      'The question a buyer actually has. Not "what does this cable cost" but "where do I place this order" — and those have different answers, because no supplier is cheapest on everything.\n\n**`plan` is the answer.** It is the cheapest combination of suppliers that can *actually be placed*: delivery is charged once per supplier, minimum orders are hard constraints, and a supplier who would refuse their share makes the whole plan impossible rather than merely dearer. It comes with the single-supplier baseline it is measured against, the alternatives worth considering, and sentences explaining why it won.\n\n`suppliers` and `split` describe what things *cost* and are kept for existing clients. `split` in particular is a greedy figure that ignores delivery and minimum orders, so it can overstate the benefit — prefer `plan.savings`.\n\nPass `maxSuppliers` to cap the split, or `excludeShopIds` to leave a supplier out. Answers are reused for six hours by default; pass `useCache: false` when the order is about to go out.',
  })
  @ApiOkResponse({ description: 'The order, priced.', type: BasketResultDto })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  priceBasket(@Owner() ownerId: string, @Body() dto: PriceBasketDto): Promise<BasketResultDto> {
    // Structured lines win where a caller sent them — an integration knows its
    // own quantities. A person pasting a list gets the same treatment through
    // one parser rather than through a syntax they would have to be taught.
    const lines = dto.lines?.length
      ? dto.lines.map((line) => ({ query: line.query, quantity: line.quantity ?? 1 }))
      : parseRequest(dto.text ?? '').map((line) => ({
          query: line.query,
          quantity: line.quantity,
        }));

    if (lines.length === 0) {
      throw new BadRequestException(
        'Напишете поне един артикул — по един на ред, с количество след запетая, ако има.',
      );
    }

    return this.discoveryService.priceBasket(ownerId, lines, {
      currency: dto.currency,
      useCache: dto.useCache,
      maxSuppliers: dto.maxSuppliers,
      excludeShopIds: dto.excludeShopIds,
    });
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What is at this address',
    description:
      'Reads one product page and says what it found — name, price, currency, availability, image — using the same extractor that will later be checking it, so what you confirm is what the monitor will see. Nothing is saved.\n\nThe fallback for a shop the search cannot reach: one that forbids crawling, publishes no catalogue, or that the matcher missed. A page that cannot be read is reported rather than refused — the address may still be the right product.',
  })
  @ApiOkResponse({ description: 'What the page turned out to say.', type: UrlPreviewDto })
  @ApiBadRequestResponse({ description: 'Not a public http(s) address.', type: ErrorResponseDto })
  preview(
    // Scoped to an account though nothing is stored: this makes the server
    // fetch an address the caller chose, and an unattributable outbound
    // request is one nobody can rate-limit or trace back.
    @Owner() _ownerId: string,
    @Body() dto: PreviewUrlDto,
  ): Promise<UrlPreviewDto> {
    return this.discoveryService.previewUrl(dto.url);
  }

  @Get('searches')
  @ApiOperation({
    summary: 'Questions you have asked before',
    description:
      'Your own searches, most recently asked first. **No supplier is contacted.** Each row carries what the last run concluded and when it ran, so the list can be drawn without opening anything.\n\nAsking the same question again does not add a row — it adds a snapshot to the row that exists and moves it to the top.',
  })
  @ApiOkResponse({ description: 'One row per question.', type: Object, isArray: true })
  listSearches(@Owner() ownerId: string, @Query() query: SearchHistoryQueryDto) {
    return this.history.list(ownerId, query.limit ?? 25);
  }

  @Get('searches/:id')
  @ApiOperation({
    summary: 'Reopen a search, exactly as it answered',
    description:
      'The comparison as it was, down to the prices, the availability and which shops failed. **No supplier is contacted** — this is what a browser refresh and a click in the history both use, and it costs one indexed read instead of a dozen requests to other people\u2019s servers.\n\n`fresh` is false once the answer is over an hour old; `fetchedAt` says when the shops were actually asked. Neither ever deletes anything: an old search opening onto old prices with the date on them is the point.',
  })
  @ApiOkResponse({ description: 'The question, the saved answer, and its age.', type: Object })
  @ApiNotFoundResponse({ description: 'No such search on this account.', type: ErrorResponseDto })
  restoreSearch(@Owner() ownerId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.history.restore(ownerId, id);
  }

  @Post('searches/:id/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask the suppliers again',
    description:
      'Runs the same question afresh and writes a **new** snapshot. The previous one is untouched and stays reachable — that is what lets a buyer see that an article was 149.99 € on Sunday and 159.99 € on Monday.\n\nClicking twice does not search twice: a second request joins the run already in progress and receives the same answer. If the run fails, nothing is written and the last saved answer remains what the search shows.',
  })
  @ApiOkResponse({ description: 'The new comparison, and the id it was filed under.', type: ComparisonDto })
  @ApiNotFoundResponse({ description: 'No such search on this account.', type: ErrorResponseDto })
  async refreshSearch(@Owner() ownerId: string, @Param('id', ParseUUIDPipe) id: string) {
    const search = await this.history.find(ownerId, id);

    return this.history.once(ownerId, search.query, search.scope, () =>
      this.discoveryService.compare(ownerId, search.query, {
        scope: search.scope,
        // The button says the results are being obtained again. Serving one
        // shop's reply from a cache written minutes ago would make that untrue
        // for that shop, and the buyer pressed this because they did not trust
        // what was on screen.
        useCache: false,
      }),
    );
  }

  @Delete('searches/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Forget a search and everything it remembered',
    description: 'Removes the question and its snapshots. Nothing else is affected.',
  })
  @ApiNotFoundResponse({ description: 'No such search on this account.', type: ErrorResponseDto })
  async removeSearch(@Owner() ownerId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.history.remove(ownerId, id);
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
