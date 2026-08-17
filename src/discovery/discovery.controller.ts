import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { DiscoveryService } from './discovery.service';
import { SearchQueryDto, ShopSearchResultDto } from './dto/discovery.dto';

@ApiTags('Discovery')
@ApiKeyAuth()
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Get('shops')
  @ApiOperation({
    summary: 'Shops that can be searched',
    description:
      'Retailers with a server-rendered search page. Shops whose search runs client-side cannot be queried this way and are absent rather than listed as broken.',
  })
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: { host: { type: 'string' }, name: { type: 'string' } },
      },
    },
  })
  listShops(): Array<{ host: string; name: string }> {
    return this.discoveryService.listProviders();
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
