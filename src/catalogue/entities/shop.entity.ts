import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../common/transformers/numeric-column.transformer';
import { Offer } from './offer.entity';

/**
 * A supplier whose catalogue we index.
 *
 * Distinct from `competitors`, which are individual listings of a product we
 * already track. A shop here is the whole catalogue: we walk its sitemap, read
 * every product page it advertises, and keep our own searchable copy. That is
 * what makes "къде е най-евтината крушка 20W" answerable — the question spans
 * products nobody has added yet.
 */
@Entity('shops')
@Index('idx_shops_host', ['host'], { unique: true })
export class Shop {
  @ApiProperty({ format: 'uuid' })
  @PrimaryGeneratedColumn('uuid')
  id!: string;

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

  @ApiPropertyOptional({
    description:
      'Why this shop cannot be searched live, when it cannot. Filled in by the check so the reason survives instead of being rediscovered.',
    nullable: true,
    example: 'търсачката не приема заявка през GET',
  })
  @Column({ name: 'search_blocked_reason', type: 'varchar', length: 255, nullable: true })
  searchBlockedReason!: string | null;

  @ApiProperty({ description: 'Readable name for the dashboard.', example: 'ТМТ ЕЛКОМ' })
  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @ApiPropertyOptional({
    description:
      "Sitemap advertising the shop's product pages. Usually named in their own robots.txt, which is as close to an invitation as the web has.",
    format: 'uri',
    nullable: true,
    example: 'https://www.tmt-elkom.com/sitemap.xml',
  })
  @Column({ name: 'sitemap_url', type: 'text', nullable: true })
  sitemapUrl!: string | null;

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

  @ApiProperty({ description: 'Inactive shops are skipped by the crawler.', example: true })
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @Column({ name: 'last_crawled_at', type: 'timestamptz', nullable: true })
  lastCrawledAt!: Date | null;

  @ApiPropertyOptional({
    description: 'Reason the last crawl stopped early, when it did.',
    nullable: true,
  })
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @ApiProperty({ description: 'Offers currently indexed for this shop.', example: 782 })
  @Column({ name: 'offer_count', type: 'int', default: 0 })
  offerCount!: number;

  @ApiProperty({
    description:
      'Pages the sitemap offers, after the obvious non-products are filtered out. Together with `offerCount` this is how far the indexing has got — without it the dashboard can only say "115 indexed" and leave you wondering out of how many.',
    example: 7548,
  })
  @Column({ name: 'catalogue_pages', type: 'int', default: 0 })
  cataloguePages!: number;

  @ApiProperty({
    description: 'Pages read so far, whether or not they held a price.',
    example: 340,
  })
  @Column({ name: 'pages_seen', type: 'int', default: 0 })
  pagesSeen!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => Offer, (offer) => offer.shop)
  offers?: Offer[];
}
