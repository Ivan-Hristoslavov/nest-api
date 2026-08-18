import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Our own copy of a supplier's catalogue.
 *
 * Answering "which shop sells this cheapest" requires knowing about products
 * nobody has added yet, and the shops that matter cannot be searched live:
 * their search is rendered client-side, or their robots.txt disallows the
 * search path while allowing every product page and advertising a sitemap.
 * So we walk the sitemap once and search our own index afterwards.
 *
 * The full-text index is Postgres' `simple` configuration rather than a
 * language one: there is no Bulgarian stemmer in a stock Postgres, and
 * `english` would stem Cyrillic into nonsense. `simple` just lowercases and
 * splits, which for product names — model numbers, wattages, colour
 * temperatures — is what you want anyway.
 */
export class Catalogue1787050000000 implements MigrationInterface {
  name = 'Catalogue1787050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "shops" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "host" character varying(255) NOT NULL,
        "name" character varying(160) NOT NULL,
        "sitemap_url" text,
        "discount_percent" numeric(5,2) NOT NULL DEFAULT '0',
        "currency" character(3) NOT NULL DEFAULT 'EUR',
        "is_active" boolean NOT NULL DEFAULT true,
        "last_crawled_at" TIMESTAMP WITH TIME ZONE,
        "last_error" text,
        "offer_count" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_shops" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX "idx_shops_host" ON "shops" ("host")`);

    await queryRunner.query(`
      CREATE TABLE "offers" (
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
      `CREATE INDEX "idx_offers_shop_price" ON "offers" ("shop_id", "price")`,
    );

    // Search is the whole point of the table, so it gets a real index rather
    // than an ILIKE scan that degrades the moment the catalogue is interesting.
    await queryRunner.query(`
      CREATE INDEX "idx_offers_search" ON "offers"
      USING GIN (to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("shop_code", '')))
    `);

    // Barcodes are how two shops are proven to sell the same item.
    await queryRunner.query(
      `CREATE INDEX "idx_offers_gtin" ON "offers" ("gtin") WHERE "gtin" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_offers_gtin"`);
    await queryRunner.query(`DROP INDEX "public"."idx_offers_search"`);
    await queryRunner.query(`DROP INDEX "public"."idx_offers_shop_price"`);
    await queryRunner.query(`DROP TABLE "offers"`);
    await queryRunner.query(`DROP INDEX "public"."idx_shops_host"`);
    await queryRunner.query(`DROP TABLE "shops"`);
  }
}
