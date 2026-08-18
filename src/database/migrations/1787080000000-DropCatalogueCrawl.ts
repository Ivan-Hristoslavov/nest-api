import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes the catalogue crawl.
 *
 * The premise was that answering "who sells this cheapest" needed our own copy
 * of every supplier's catalogue. Measured against a real shop, that premise
 * does not survive: bg.elmarkstore.eu advertises 8130 product pages, each ~250
 * KB, served one at a time behind a politeness delay — four and a half hours
 * and two gigabytes of someone else's bandwidth, to learn prices their own
 * `/search` returns in a single request. It is slow, it is rude, and it is the
 * kind of traffic that gets a crawler blocked.
 *
 * Live search replaces it: one request per shop per *question*, never one per
 * article. A supplier with eight thousand items now costs exactly what one
 * with eighty costs, which is what makes this affordable to run.
 *
 * What is lost: shops with no queryable search can no longer be searched at
 * all. Their products are still tracked normally — paste a link and the
 * scraper follows it — which is the part customers pay for.
 *
 * Irreversible in substance: `down()` rebuilds the tables, but the indexed
 * offers themselves are gone. They were a cache of public pages, re-readable
 * at any time, so this is a rebuild rather than a loss.
 */
export class DropCatalogueCrawl1787080000000 implements MigrationInterface {
  name = 'DropCatalogueCrawl1787080000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "offers"`);

    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "sitemap_url"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "last_crawled_at"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "offer_count"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "catalogue_pages"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "pages_seen"`);

    // Kept, repurposed: it used to say why a crawl stopped early, and now says
    // why the last live search failed. Same question, different mechanism.
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "search_title_selector" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "search_confidence" numeric(4,3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "last_searched_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(`ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "last_error" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "last_searched_at"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "search_confidence"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "search_title_selector"`);

    await queryRunner.query(`ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "sitemap_url" text`);
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "last_crawled_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "offer_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "catalogue_pages" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "pages_seen" integer NOT NULL DEFAULT 0`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "offers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "shop_id" uuid NOT NULL,
        "url" text NOT NULL,
        "name" character varying(500) NOT NULL,
        "shop_code" character varying(120),
        "gtin" character varying(14),
        "price" numeric(12,2),
        "currency" character(3) NOT NULL DEFAULT 'EUR',
        "in_stock" boolean,
        "image_url" text,
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_offers" PRIMARY KEY ("id"),
        CONSTRAINT "uq_offers_shop_url" UNIQUE ("shop_id", "url"),
        CONSTRAINT "fk_offers_shop" FOREIGN KEY ("shop_id")
          REFERENCES "shops"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_offers_shop_price" ON "offers" ("shop_id", "price")`,
    );
  }
}
