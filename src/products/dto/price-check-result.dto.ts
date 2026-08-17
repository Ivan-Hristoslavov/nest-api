import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ScrapeStatus } from '../enums/scrape-status.enum';

/** Result of applying one price observation to a competitor listing. */
export class PriceCheckResultDto {
  @ApiProperty({ description: 'Product that was checked.', format: 'uuid' })
  productId!: string;

  @ApiProperty({ description: 'Product name, for readable logs and dashboards.' })
  productName!: string;

  @ApiProperty({ description: 'Competitor listing that was checked.', format: 'uuid' })
  competitorId!: string;

  @ApiProperty({ description: 'Competitor name.', example: 'Competitor A' })
  competitorName!: string;

  @ApiProperty({
    description: 'Outcome of the check.',
    enum: ScrapeStatus,
    enumName: 'ScrapeStatus',
  })
  status!: ScrapeStatus;

  @ApiPropertyOptional({
    description: 'Price at this listing before the check.',
    type: Number,
    example: 309.0,
    nullable: true,
  })
  previousPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Price at this listing after the check.',
    type: Number,
    example: 289.99,
    nullable: true,
  })
  currentPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Signed relative change in percent. Null on the first observation.',
    type: Number,
    example: -6.15,
    nullable: true,
  })
  changePercent!: number | null;

  @ApiProperty({ description: 'Whether the observed price differs from the stored one.' })
  priceChanged!: boolean;

  @ApiProperty({
    description: 'Whether the change exceeded SCRAPER_ALERT_THRESHOLD_PERCENT.',
    example: false,
  })
  significantChange!: boolean;

  @ApiProperty({
    description: "Whether the price is below the product's configured target price.",
    example: false,
  })
  undercutsTargetPrice!: boolean;

  @ApiProperty({
    description: 'Whether this is the lowest price ever recorded for the product.',
    example: false,
  })
  allTimeLow!: boolean;

  @ApiPropertyOptional({
    description: 'Availability reported by the page, when it reported any.',
    nullable: true,
    example: true,
  })
  inStock!: boolean | null;

  @ApiPropertyOptional({
    description: 'Extraction strategy that produced the price (json-ld, selector, meta, ...).',
    nullable: true,
    example: 'json-ld',
  })
  strategy!: string | null;

  @ApiPropertyOptional({
    description: 'Failure reason when status is "failed".',
    nullable: true,
    example: null,
  })
  error!: string | null;

  @ApiProperty({ description: 'Server time of the check (ISO-8601).', format: 'date-time' })
  checkedAt!: string;
}
