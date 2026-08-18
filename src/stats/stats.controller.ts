import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators/public.decorator';
import { PublicStatsDto } from './dto/public-stats.dto';
import { StatsService } from './stats.service';

@ApiTags('Stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Counters the landing page prints',
    description:
      'Unauthenticated because the marketing page is read by people who have no key. Aggregate only: how many suppliers and products exist in total, never whose they are.',
  })
  @ApiOkResponse({ type: PublicStatsDto })
  snapshot(): Promise<PublicStatsDto> {
    return this.stats.snapshot();
  }
}
