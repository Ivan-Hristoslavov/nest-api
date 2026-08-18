import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prices the buyer types in, for suppliers with no website.
 *
 * The tool can only read shops that publish. The supplier who is often
 * cheapest publishes nothing — the small local warehouse with no site, who
 * emails an Excel list or quotes down the phone. Comparing only what can be
 * scraped compares the wrong set and names the wrong winner with confidence.
 *
 * These rows join the same ranking, carry the same discount, and are told
 * apart by their age: nothing re-reads them, so `updated_at` is the only thing
 * that says whether the figure can still be trusted.
 */
export class ManualPrices1787120000000 implements MigrationInterface {
  name = 'ManualPrices1787120000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "manual_prices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "shop_id" uuid NOT NULL,
        "name" character varying(300) NOT NULL,
        "shop_code" character varying(120),
        "price" numeric(12,2) NOT NULL,
        "currency" character(3) NOT NULL DEFAULT 'EUR',
        "unit" character varying(32),
        "note" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_manual_prices" PRIMARY KEY ("id"),
        CONSTRAINT "fk_manual_prices_shop" FOREIGN KEY ("shop_id")
          REFERENCES "shops"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_manual_prices_shop" ON "manual_prices" ("shop_id")`,
    );

    // Searching these is a substring match over a few hundred rows per shop,
    // not full text: a buyer types "свт 3x2.5" and the list says
    // "КАБЕЛ СВТ 3x2.5". A trigram index keeps that honest as the list grows.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_manual_prices_name_trgm" ON "manual_prices" USING gin (lower("name") gin_trgm_ops)`,
    );

    // A supplier with no website is searched by neither route.
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "has_website" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "has_website"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_manual_prices_name_trgm"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "manual_prices"`);
  }
}
