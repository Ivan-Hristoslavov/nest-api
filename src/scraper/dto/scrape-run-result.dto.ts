import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PriceCheckResultDto } from '../../products/dto/price-check-result.dto';

export class ScrapeRunResultDto {
  @ApiProperty({
    description: 'Identifier of this sweep, for correlating log lines.',
    example: 'sweep_2026-08-17T09:00:00.000Z',
  })
  runId!: string;

  @ApiProperty({ description: 'Competitor listings picked up by this sweep.', example: 25 })
  processed!: number;

  @ApiProperty({ description: 'Listings successfully re-priced.', example: 24 })
  succeeded!: number;

  @ApiProperty({ description: 'Listings whose fetch failed.', example: 1 })
  failed!: number;

  @ApiProperty({ description: 'Listings whose price actually moved.', example: 9 })
  changed!: number;

  @ApiProperty({
    description: 'Price moves beyond SCRAPER_ALERT_THRESHOLD_PERCENT.',
    example: 2,
  })
  significantChanges!: number;

  @ApiProperty({
    description: 'Listings now priced below the product target price.',
    example: 1,
  })
  undercuts!: number;

  @ApiProperty({ description: 'Total sweep duration in milliseconds.', example: 3412 })
  durationMs!: number;

  @ApiProperty({ description: 'Sweep start time (ISO-8601).', format: 'date-time' })
  startedAt!: string;

  @ApiProperty({
    description: 'Per-listing outcome.',
    type: PriceCheckResultDto,
    isArray: true,
  })
  results!: PriceCheckResultDto[];
}

export class ScraperStatusDto {
  @ApiProperty({ description: 'Whether the scheduled sweep is enabled.', example: true })
  enabled!: boolean;

  @ApiProperty({
    description: 'Active price source: "http" fetches real pages, "simulation" generates movement.',
    example: 'http',
  })
  driver!: string;

  @ApiProperty({ description: 'Cron expression driving the sweep.', example: '0 * * * *' })
  cron!: string;

  @ApiProperty({ description: 'Whether a sweep is executing right now.', example: false })
  running!: boolean;

  @ApiProperty({ description: 'Maximum listings per sweep.', example: 25 })
  batchSize!: number;

  @ApiProperty({ description: 'Parallel fetches within a sweep.', example: 5 })
  concurrency!: number;

  @ApiProperty({ description: 'Whether robots.txt is honoured.', example: true })
  respectRobots!: boolean;

  @ApiProperty({ description: 'Competitor listings currently due for a check.', example: 12 })
  dueNow!: number;

  @ApiPropertyOptional({
    description: 'Finish time of the last completed sweep (ISO-8601), null if none yet.',
    format: 'date-time',
    nullable: true,
    example: '2026-08-17T09:00:03.221Z',
  })
  lastRunAt!: string | null;

  @ApiPropertyOptional({
    description: 'Summary of the last completed sweep, null if none yet.',
    nullable: true,
    type: () => ScrapeRunResultDto,
  })
  lastRun!: ScrapeRunResultDto | null;
}

/**
 * What one account may know about the scraper.
 *
 * Deliberately much smaller than {@link ScraperStatusDto}. That one carries
 * `lastRun`, whose per-listing results name products and suppliers from every
 * tenant the sweep touched — which is exactly what must not reach a customer
 * key. This carries only facts about the caller's own listings, plus the two
 * deployment settings that are not secret: whether checking runs at all, and
 * on what schedule.
 */
export class OwnerScraperStatusDto {
  @ApiProperty({ description: 'Whether the scheduled sweep is enabled at all.', example: true })
  enabled!: boolean;

  @ApiProperty({ description: 'Cron expression driving the sweep.', example: '0 * * * *' })
  cron!: string;

  @ApiProperty({
    description: 'How many of **your** listings are due for a check right now.',
    example: 12,
  })
  dueNow!: number;

  @ApiProperty({
    description: 'Whether a refresh of your own listings is running right now.',
    example: false,
  })
  running!: boolean;
}
