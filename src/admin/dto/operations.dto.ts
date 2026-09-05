import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ScraperStatusDto } from '../../scraper/dto/scrape-run-result.dto';

/**
 * Listings that failed, grouped by the site they failed on.
 *
 * Per host rather than per listing because that is the shape of the fix: a
 * retailer that changed its markup breaks every listing on it at once, and
 * forty rows saying the same thing about the same domain is a wall that hides
 * the one host with a genuinely different problem.
 */
export class ScrapeFailureDto {
  @ApiProperty({ example: 'shop.example.com' })
  host!: string;

  @ApiProperty({ example: 12, description: 'Failing listings on this host.' })
  listings!: number;

  @ApiProperty({ example: 34, description: 'Consecutive failures summed across them.' })
  attempts!: number;

  @ApiPropertyOptional({ nullable: true, example: 'HTTP 403' })
  lastError!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lastCheckedAt!: string | null;
}

export class StaleListingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Кабел NYM 3x1.5' }) product!: string;
  @ApiProperty({ example: 'Елмарк' }) competitor!: string;
  @ApiProperty({ example: 'shop.example.com' }) host!: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lastUpdated!: string | null;
}

export class ScrapeReportDto {
  @ApiProperty({ type: ScraperStatusDto })
  status!: ScraperStatusDto;

  @ApiProperty({ type: ScrapeFailureDto, isArray: true })
  failures!: ScrapeFailureDto[];

  @ApiProperty({
    type: StaleListingDto,
    isArray: true,
    description: 'Active listings nobody has managed to re-price for over a day.',
  })
  stale!: StaleListingDto[];
}

/** One supplier host, as the daily search check last found it. */
export class ShopHealthDto {
  @ApiProperty({ example: 'elmarkstore.eu' }) host!: string;
  @ApiProperty({ example: 'Elmark Store' }) name!: string;
  @ApiProperty({ enum: ['live', 'sitemap', 'manual', 'none'], example: 'live' }) method!: string;

  @ApiPropertyOptional({
    enum: ['ok', 'empty', 'ignores_query', 'error'],
    nullable: true,
    description: 'Null until the first check has run.',
  })
  status!: 'ok' | 'empty' | 'ignores_query' | 'error' | null;

  @ApiPropertyOptional({ nullable: true, example: '„кабел" и „лампа" върнаха едни и същи 20 резултата' })
  detail!: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  checkedAt!: string | null;

  @ApiProperty({ example: 3, description: 'Customers with this supplier on their list.' })
  accounts!: number;
}

export class ShopHealthReportDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ example: '0 6 * * *' }) cron!: string;
  @ApiProperty({ description: 'Whether a check is running right now.' }) running!: boolean;

  @ApiProperty({
    type: ShopHealthDto,
    isArray: true,
    description: 'Every searchable supplier across every account, worst first.',
  })
  hosts!: ShopHealthDto[];
}

/** One alert, with enough around it to be read without a second query. */
export class AdminAlertDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'price_drop' }) type!: string;
  @ApiProperty({ example: 'warning' }) severity!: string;
  @ApiProperty() message!: string;

  @ApiProperty({ example: 'Кабел NYM 3x1.5' }) product!: string;

  @ApiPropertyOptional({ nullable: true, example: 'ivan@example.com' })
  owner!: string | null;

  @ApiProperty({ example: 'delivered', description: 'Whether it reached a channel.' })
  deliveryStatus!: string;

  @ApiPropertyOptional({ nullable: true }) deliveryError!: string | null;

  @ApiProperty({ description: 'Acknowledged alerts are still listed, greyed.', example: false })
  acknowledged!: boolean;

  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}
