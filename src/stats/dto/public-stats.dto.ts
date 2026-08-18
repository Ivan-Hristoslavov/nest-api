import { ApiProperty } from '@nestjs/swagger';

/**
 * The numbers the public landing page is allowed to print.
 *
 * Every field is counted from the database at request time. Nothing here is a
 * marketing figure: a visitor who reads "37 доставчика" and then finds four in
 * the product has been told something false, and the first thing they will
 * doubt afterwards is the prices.
 */
export class PublicStatsDto {
  @ApiProperty({ description: 'Active suppliers configured across all accounts.', example: 4 })
  shops!: number;

  @ApiProperty({
    description: 'Suppliers that have no website and are compared from an uploaded price list.',
    example: 1,
  })
  offlineShops!: number;

  @ApiProperty({ description: 'Products under watch across all accounts.', example: 128 })
  products!: number;

  @ApiProperty({ description: 'Active supplier listings being re-checked.', example: 412 })
  listings!: number;

  @ApiProperty({
    description: 'Recorded price movements. A sweep that finds no change writes nothing.',
    example: 1893,
  })
  priceMovements!: number;

  @ApiProperty({
    description:
      'Share of checked listings whose last check returned a usable price, 0–100. Null until something has been checked.',
    example: 96.4,
    nullable: true,
  })
  successRate!: number | null;

  @ApiProperty({
    description: 'When the most recent listing was checked.',
    example: '2026-08-18T09:12:44.000Z',
    nullable: true,
  })
  lastCheckAt!: string | null;
}
