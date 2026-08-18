import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../common/transformers/numeric-column.transformer';

/**
 * A supplier we can ask.
 *
 * Distinct from `competitors`, which are individual listings of a product
 * already being tracked. A shop is the whole storefront, and what we keep of
 * it is not its catalogue but the *way in*: how to phrase a search URL and
 * where the answers sit on the page.
 *
 * Nothing of theirs is copied. "Къде е най-евтината крушка 20W" is answered by
 * asking every shop's own search at the moment the question is asked — one
 * request per shop, current prices, no index to go stale and no catalogue to
 * walk. A supplier with eight thousand articles costs exactly as much to serve
 * as one with eighty.
 *
 * The discount is the reason this beats reading the shops by hand: the ranking
 * is by what *this customer* pays, and a higher shelf price can win.
 */
@Entity('shops')
// Unique per owner, not globally: two customers may both buy from the same
// wholesaler, on entirely different terms.
@Index('idx_shops_owner_host', ['ownerId', 'host'], { unique: true })
export class Shop {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The account this supplier belongs to.
   *
   * The discount on this row is the customer's negotiated rate — a commercial
   * secret, and the number the whole comparison turns on. Sharing shop rows
   * between accounts would publish it.
   */
  @ApiProperty({ format: 'uuid', description: 'Owning account.' })
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @ApiProperty({ description: 'Hostname, without `www.`', example: 'tmt-elkom.com' })
  @Column({ type: 'varchar', length: 255 })
  host!: string;

  @ApiPropertyOptional({
    description:
      'Search URL with `{q}` where the query goes, e.g. `https://shop.bg/search?q={q}`. Set this and the shop becomes live-searchable without a code change — which is the point: a supplier list that only a developer can extend is a supplier list that stays at three.',
    example: 'https://www.tmt-elkom.com/search?q={q}',
    nullable: true,
  })
  @Column({ name: 'search_url_template', type: 'text', nullable: true })
  searchUrlTemplate!: string | null;

  @ApiPropertyOptional({
    description:
      'CSS selector for the links in the search results. Left empty, the generic one is tried: any anchor whose href looks like a product page.',
    example: '.products.list li a.image',
    nullable: true,
  })
  @Column({ name: 'search_result_selector', type: 'varchar', length: 255, nullable: true })
  searchResultSelector!: string | null;

  @ApiPropertyOptional({
    description: 'CSS selector for the price inside a result tile.',
    example: '.price',
    nullable: true,
  })
  @Column({ name: 'search_price_selector', type: 'varchar', length: 255, nullable: true })
  searchPriceSelector!: string | null;

  @ApiProperty({
    description:
      'False for a supplier with no website at all — the local warehouse that emails a price list. Nothing is fetched for them; their prices are the ones you entered by hand, and they still join the same comparison.',
    example: true,
  })
  @Column({ name: 'has_website', type: 'boolean', default: true })
  hasWebsite!: boolean;

  @ApiProperty({
    description:
      'How this shop gets searched. `live` asks its own search engine — one request per question, current stock. `sitemap` matches the query against its published addresses and reads only the pages that matched, for a shop that forbids its search but lists its pages. `none` means neither is available; its products are still tracked by link.',
    enum: ['live', 'sitemap', 'manual', 'none'],
    example: 'live',
  })
  @Column({ name: 'search_method', type: 'varchar', length: 16, default: 'none' })
  searchMethod!: 'live' | 'sitemap' | 'manual' | 'none';

  @ApiPropertyOptional({
    description: 'What the probe found when the shop was added, in words the operator can act on.',
    nullable: true,
  })
  @Column({ name: 'search_summary', type: 'text', nullable: true })
  searchSummary!: string | null;

  @ApiPropertyOptional({
    description:
      'CSS selector for one result tile — the box holding a product’s name, price and link. Without it the title and price selectors are searched in whatever element happens to surround the link, which is how a real price goes missing.',
    example: 'form.item.product',
    nullable: true,
  })
  @Column({ name: 'search_tile_selector', type: 'varchar', length: 255, nullable: true })
  searchTileSelector!: string | null;

  @ApiPropertyOptional({
    description:
      'CSS selector for the product name inside a result tile. Left empty, the link text is used.',
    example: '.product-name',
    nullable: true,
  })
  @Column({ name: 'search_title_selector', type: 'varchar', length: 255, nullable: true })
  searchTitleSelector!: string | null;

  @ApiPropertyOptional({
    description:
      'Share of sample rows the detector could read completely, 0–1. Stored so a shop configured from a weak guess can be told apart from one verified against real results.',
    type: Number,
    nullable: true,
    example: 0.9,
  })
  @Column({
    name: 'search_confidence',
    type: 'numeric',
    precision: 4,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  searchConfidence!: number | null;

  @ApiPropertyOptional({
    description:
      'Why this shop cannot be searched live, when it cannot. Filled in by the check so the reason survives instead of being rediscovered.',
    nullable: true,
    example: 'търсачката не приема заявка през GET',
  })
  @Column({ name: 'search_blocked_reason', type: 'varchar', length: 255, nullable: true })
  searchBlockedReason!: string | null;

  @ApiPropertyOptional({
    description: 'When this shop last answered a search, successfully or not.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @Column({ name: 'last_searched_at', type: 'timestamptz', nullable: true })
  lastSearchedAt!: Date | null;

  @ApiPropertyOptional({
    description: 'What went wrong the last time this shop was searched.',
    nullable: true,
  })
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @ApiProperty({ description: 'Readable name for the dashboard.', example: 'ТМТ ЕЛКОМ' })
  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @ApiProperty({
    description:
      'Negotiated discount off the listed price, in percent. The comparison uses the discounted figure — a shop with a higher shelf price can be the cheaper one for this customer, and ignoring that makes the answer wrong.',
    example: 10,
  })
  @Column({
    name: 'discount_percent',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  discountPercent!: number;

  @ApiProperty({ description: 'Currency this shop quotes in.', example: 'EUR' })
  @Column({ type: 'char', length: 3, default: 'EUR' })
  currency!: string;

  @ApiProperty({ description: 'Inactive shops are left out of every search.', example: true })
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
