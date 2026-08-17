import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ScrapeStatus } from '../enums/scrape-status.enum';

/** Result of applying one price observation to a product. */
export class PriceCheckResultDto {
  @ApiProperty({ description: 'Product that was checked.', format: 'uuid' })
  productId!: string;

  @ApiProperty({ description: 'Product name, for readable logs and dashboards.' })
  productName!: string;

  @ApiProperty({
    description: 'Outcome of the check.',
    enum: ScrapeStatus,
    enumName: 'ScrapeStatus',
  })
  status!: ScrapeStatus;

  @ApiPropertyOptional({
    description: 'Price before this check.',
    type: Number,
    example: 309.0,
    nullable: true,
  })
  previousPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Price after this check.',
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
    description: 'Whether the competitor price is below our configured target price.',
    example: false,
  })
  undercutsTargetPrice!: boolean;

  @ApiPropertyOptional({
    description: 'Failure reason when status is "failed".',
    nullable: true,
    example: null,
  })
  error!: string | null;

  @ApiProperty({ description: 'Server time of the check (ISO-8601).', format: 'date-time' })
  checkedAt!: string;
}
