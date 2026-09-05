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
import { VatState } from '../../pricing/effective-cost';

/** What the scheduled check concluded about a shop's search. */
export type ShopHealthStatus = 'ok' | 'empty' | 'ignores_query' | 'error';

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

  @ApiPropertyOptional({
    description:
      'What the last scheduled health check concluded about this shop’s search. `ok` — it answers and the answers follow the query. `empty` — every probe came back with nothing. `ignores_query` — different questions get the same answer, which is a search that has stopped searching. `error` — it could not be asked at all. Null until the first check.',
    enum: ['ok', 'empty', 'ignores_query', 'error'],
    nullable: true,
  })
  @Column({ name: 'health_status', type: 'varchar', length: 16, nullable: true })
  healthStatus!: ShopHealthStatus | null;

  @ApiPropertyOptional({
    description: 'The check’s finding in words: which queries were tried and what came back.',
    nullable: true,
  })
  @Column({ name: 'health_detail', type: 'text', nullable: true })
  healthDetail!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @Column({ name: 'health_checked_at', type: 'timestamptz', nullable: true })
  healthCheckedAt!: Date | null;

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

  // --- Commercial terms ------------------------------------------------------
  //
  // Everything below defaults to neutral, so a shop configured before these
  // columns existed prices exactly as it did before: discount applied, nothing
  // else. That is what makes them safe to add to live data.

  @ApiProperty({
    description:
      'Whether this shop quotes with VAT, without it, or has not said.\n\n`unknown` is the honest default and the one every existing shop starts on: a price scraped from a page carries no statement about VAT, and assuming one is a 20% error — larger than almost any negotiated discount, and the exact mistake this product exists to prevent. An offer priced on an unknown basis is still shown, but it is marked as not directly comparable against one whose basis is known.',
    enum: VatState,
    enumName: 'VatState',
    example: VatState.Exclusive,
  })
  @Column({ name: 'vat_state', type: 'varchar', length: 12, default: VatState.Unknown })
  vatState!: VatState;

  @ApiProperty({
    description: 'VAT rate in percent. Only consulted when the shop quotes VAT-inclusive.',
    example: 20,
  })
  @Column({
    name: 'vat_rate',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 20,
    transformer: numericTransformer,
  })
  vatRate!: number;

  @ApiProperty({
    description:
      'Flat delivery charge per order. Charged once per order, not per article — which is why splitting an order across four suppliers saves on goods and adds four deliveries.',
    example: 12,
  })
  @Column({
    name: 'shipping_cost',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  shippingCost!: number;

  @ApiPropertyOptional({
    description:
      'Goods total at or above which delivery is free. Null means it never is. Read against the goods total before delivery is added, so a delivery charge cannot push an order over the line that waives it.',
    type: Number,
    nullable: true,
    example: 300,
  })
  @Column({
    name: 'free_shipping_over',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  freeShippingOver!: number | null;

  @ApiProperty({
    description: 'Per-order charge that is not delivery — packing, documents, a card fee.',
    example: 0,
  })
  @Column({
    name: 'handling_fee',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  handlingFee!: number;

  @ApiProperty({
    description:
      'Below this goods total the supplier will not accept an order. A supplier under their minimum is not the cheapest one — they are not an option, and presenting them as the answer recommends an order that will be refused.',
    example: 200,
  })
  @Column({
    name: 'min_order_value',
    type: 'numeric',
    precision: 12,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  minOrderValue!: number;

  @ApiPropertyOptional({
    description:
      'Anything about this supplier’s terms that the fields above cannot hold — a rebate agreement, a seasonal condition, a person to ask. Read by humans, never by the pricing code.',
    nullable: true,
  })
  @Column({ name: 'terms_note', type: 'text', nullable: true })
  termsNote!: string | null;

  @ApiProperty({ description: 'Inactive shops are left out of every search.', example: true })
  /**
   * Where an order request is sent.
   *
   * Empty for most suppliers, and that is fine — the order can still be built
   * and printed. Ordering by email is how this market actually works: there is
   * no API behind a wholesale counter, there is a person who reads the inbox.
   */
  @ApiPropertyOptional({
    description: 'Address order requests are sent to. Null means orders can be built but not sent.',
    nullable: true,
    example: 'orders@supplier.bg',
  })
  @Column({ name: 'order_email', type: 'varchar', length: 320, nullable: true })
  orderEmail!: string | null;

  @ApiPropertyOptional({
    description: 'Who to address the order to, when the supplier named somebody.',
    nullable: true,
    example: 'Отдел продажби',
  })
  @Column({ name: 'order_contact', type: 'varchar', length: 160, nullable: true })
  orderContact!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
