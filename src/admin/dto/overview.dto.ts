import { ApiProperty } from '@nestjs/swagger';

/** One day of a series. The key is a date, not a timestamp: the charts are
 *  daily and a timestamp would invite the reader to expect finer grain. */
export class DailyPointDto {
  @ApiProperty({ example: '2026-08-24', description: 'Day, in the server timezone.' })
  day!: string;

  @ApiProperty({ example: 3 })
  count!: number;
}

export class BillingDayDto {
  @ApiProperty({ example: '2026-08-24' })
  day!: string;

  @ApiProperty({ example: 4, description: 'Webhooks received that day.' })
  received!: number;

  @ApiProperty({ example: 4, description: 'Of those, the ones that were acted on.' })
  processed!: number;

  @ApiProperty({ example: 0, description: 'Of those, the ones that changed nothing.' })
  unprocessed!: number;
}

export class CustomerCountsDto {
  @ApiProperty({ example: 12 }) total!: number;
  @ApiProperty({ example: 5 }) active!: number;
  @ApiProperty({ example: 3 }) pending!: number;
  @ApiProperty({ example: 3 }) expired!: number;
  @ApiProperty({ example: 1 }) suspended!: number;

  @ApiProperty({
    description: 'How many accounts sit on each plan.',
    example: { free: 8, starter: 2, pro: 2, business: 0 },
  })
  byPlan!: Record<string, number>;

  @ApiProperty({ example: 4, description: 'Accounts created inside the chosen window.' })
  newInWindow!: number;

  @ApiProperty({ example: 2, description: 'Accounts inside a running free trial.' })
  onTrial!: number;
}

export class WorkloadDto {
  @ApiProperty({ example: 240 }) products!: number;
  @ApiProperty({ example: 830 }) competitors!: number;
  @ApiProperty({ example: 17 }) shops!: number;
  @ApiProperty({ example: 46 }) alerts!: number;
}

export class ScrapeHealthDto {
  @ApiProperty({ example: 780, description: 'Listings whose last check succeeded.' })
  ok!: number;

  @ApiProperty({ example: 12, description: 'Listings whose last check failed.' })
  failed!: number;

  @ApiProperty({ example: 30, description: 'Active listings not checked for over 24 hours.' })
  stale!: number;
}

export class EventTotalsDto {
  @ApiProperty({ example: 84 }) total!: number;
  @ApiProperty({ example: 80 }) processed!: number;

  @ApiProperty({
    example: 4,
    description:
      'Events that arrived and were not acted on. This is the number behind "they paid and got nothing".',
  })
  unprocessed!: number;

  @ApiProperty({
    example: 1,
    description:
      'Events carrying a note. A note is written both when handling failed and when the event was deliberately ignored, so this counts explanations, not faults.',
  })
  noted!: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastReceivedAt!: string | null;
}

/**
 * Everything the operator screen puts on one page.
 *
 * Assembled server-side rather than by six browser requests: the panel opens
 * on it, and six round trips over a cold connection is the difference between
 * a screen that is there and a screen that assembles itself while you watch.
 */
export class AdminOverviewDto {
  @ApiProperty({ example: 30, description: 'Length of the window these series cover.' })
  days!: number;

  @ApiProperty({ type: CustomerCountsDto }) customers!: CustomerCountsDto;
  @ApiProperty({ type: WorkloadDto }) workload!: WorkloadDto;
  @ApiProperty({ type: EventTotalsDto }) events!: EventTotalsDto;
  @ApiProperty({ type: ScrapeHealthDto }) scrape!: ScrapeHealthDto;

  @ApiProperty({
    type: DailyPointDto,
    isArray: true,
    description: 'Signups per day across the window.',
  })
  signups!: DailyPointDto[];

  @ApiProperty({
    type: BillingDayDto,
    isArray: true,
    description: 'Billing webhooks per day across the window.',
  })
  billing!: BillingDayDto[];
}
