import { ApiProperty } from '@nestjs/swagger';

/**
 * One supplier site, counted across every customer that configured it.
 *
 * Grouped by host rather than listed per row: the same wholesaler appears once
 * per customer in `shops`, and an operator asking "which sites are we hitting"
 * wants the site, not one line per subscriber of it. `owners` is what makes a
 * site worth fixing — a broken selector on a host three customers share is
 * three complaints, not one.
 */
export class ShopUsageDto {
  @ApiProperty({ example: 'partner.example.com' })
  host!: string;

  @ApiProperty({
    example: 'Партньор ООД',
    description: 'Name given by the first customer to add it.',
  })
  name!: string;

  @ApiProperty({ example: 3, description: 'How many customers have this site configured.' })
  owners!: number;

  @ApiProperty({ example: 2, description: 'How many of those have it switched on.' })
  active!: number;

  @ApiProperty({
    example: true,
    description: 'False for a supplier whose price list is uploaded by hand.',
  })
  hasWebsite!: boolean;

  @ApiProperty({ example: 'tiles', description: 'How its own search is driven.' })
  searchMethod!: string;

  @ApiProperty({ example: 41, description: 'Manually uploaded prices held for this site.' })
  manualPrices!: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastSearchedAt!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'robots.txt disallows /search' })
  blockedReason!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'HTTP 403' })
  lastError!: string | null;
}
