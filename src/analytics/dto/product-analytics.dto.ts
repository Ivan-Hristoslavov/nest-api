import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ScrapeStatus } from '../../products/enums/scrape-status.enum';

export type PriceTrend = 'rising' | 'falling' | 'flat' | 'unknown';

export class PricePointDto {
  @ApiProperty({ format: 'date-time' })
  recordedAt!: string;

  @ApiProperty({ type: Number, example: 289.99 })
  price!: number;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  competitorId!: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: -6.15 })
  changePercent!: number | null;
}

export class CompetitorBreakdownDto {
  @ApiProperty({ format: 'uuid' })
  competitorId!: string;

  @ApiProperty({ example: 'Vario' })
  name!: string;

  @ApiProperty({ example: 'vario.bg' })
  host!: string;

  @ApiProperty({ format: 'uri' })
  url!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 428.0 })
  currentPrice!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  previousPrice!: number | null;

  @ApiProperty({ example: 'BGN' })
  currency!: string;

  @ApiPropertyOptional({ nullable: true, example: true })
  inStock!: boolean | null;

  @ApiProperty({ description: 'Whether this listing sets the market price.', example: true })
  isCheapest!: boolean;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  lastCheckedAt!: string | null;

  @ApiProperty({ enum: ScrapeStatus, enumName: 'ScrapeStatus' })
  scrapeStatus!: ScrapeStatus;

  @ApiPropertyOptional({
    description: 'How far above the cheapest listing this one sits, in percent.',
    type: Number,
    nullable: true,
    example: 4.2,
  })
  premiumPercent!: number | null;
}

export class ProductAnalyticsDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ example: 'BGN' })
  currency!: string;

  @ApiProperty({ description: 'Length of the analysed window, in days.', example: 30 })
  periodDays!: number;

  @ApiProperty({ format: 'date-time' })
  from!: string;

  @ApiProperty({ format: 'date-time' })
  to!: string;

  @ApiProperty({ description: 'Price observations inside the window.', example: 42 })
  dataPoints!: number;

  @ApiPropertyOptional({
    description: 'Cheapest active competitor price right now.',
    type: Number,
    nullable: true,
  })
  currentPrice!: number | null;

  @ApiPropertyOptional({ description: 'Our own price.', type: Number, nullable: true })
  ourPrice!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  targetPrice!: number | null;

  @ApiPropertyOptional({ description: 'Lowest price in the window.', type: Number, nullable: true })
  minPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Highest price in the window.',
    type: Number,
    nullable: true,
  })
  maxPrice!: number | null;

  @ApiPropertyOptional({ description: 'Mean price in the window.', type: Number, nullable: true })
  averagePrice!: number | null;

  @ApiPropertyOptional({
    description: 'Standard deviation as a percentage of the mean — how jumpy this market is.',
    type: Number,
    nullable: true,
    example: 3.87,
  })
  volatilityPercent!: number | null;

  @ApiPropertyOptional({
    description: 'Change from the first to the last observation in the window.',
    type: Number,
    nullable: true,
    example: -8.4,
  })
  changePercent!: number | null;

  @ApiProperty({
    description: 'Direction of travel over the window.',
    enum: ['rising', 'falling', 'flat', 'unknown'],
    example: 'falling',
  })
  trend!: PriceTrend;

  @ApiProperty({ description: 'How many times the price moved in the window.', example: 12 })
  changeCount!: number;

  @ApiPropertyOptional({ description: 'Lowest price ever recorded.', type: Number, nullable: true })
  allTimeLow!: number | null;

  @ApiPropertyOptional({
    description: 'Highest price ever recorded.',
    type: Number,
    nullable: true,
  })
  allTimeHigh!: number | null;

  @ApiProperty({ description: 'Whether the market is below our target price.', example: true })
  undercutsTargetPrice!: boolean;

  @ApiPropertyOptional({
    description: 'Our price relative to the market, in percent. Positive means we are dearer.',
    type: Number,
    nullable: true,
    example: 3.5,
  })
  marginPercent!: number | null;

  @ApiProperty({
    description: 'Per-retailer breakdown, cheapest first.',
    type: CompetitorBreakdownDto,
    isArray: true,
  })
  competitors!: CompetitorBreakdownDto[];

  @ApiProperty({
    description: 'Observations in the window, oldest first — ready to plot.',
    type: PricePointDto,
    isArray: true,
  })
  series!: PricePointDto[];
}

export class BiggestMoverDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ type: Number })
  price!: number;

  @ApiProperty({ type: Number, example: -12.4 })
  changePercent!: number;

  @ApiProperty({ format: 'date-time' })
  recordedAt!: string;
}

export class MarketOverviewDto {
  @ApiProperty({ example: 137 })
  trackedProducts!: number;

  @ApiProperty({ example: 130 })
  activeProducts!: number;

  @ApiProperty({ example: 412 })
  trackedListings!: number;

  @ApiProperty({ example: 400 })
  activeListings!: number;

  @ApiProperty({ example: 12 })
  failingListings!: number;

  @ApiProperty({ description: 'Distinct retailer hostnames tracked.', example: 8 })
  retailers!: number;

  @ApiProperty({ description: 'Products where the market is below our target.', example: 11 })
  undercutProducts!: number;

  @ApiProperty({
    description: 'Products where our price is at or below the cheapest competitor.',
    example: 84,
  })
  productsWeWin!: number;

  @ApiProperty({ description: 'Products where a competitor is cheaper than us.', example: 46 })
  productsWeLose!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 241.37 })
  averageMarketPrice!: number | null;

  @ApiPropertyOptional({
    description: 'Mean of (our price − market price) across the catalog.',
    type: Number,
    nullable: true,
    example: 4.12,
  })
  averagePriceGap!: number | null;

  @ApiProperty({
    description: 'Largest price moves in the last seven days.',
    type: BiggestMoverDto,
    isArray: true,
  })
  biggestMovers!: BiggestMoverDto[];
}
