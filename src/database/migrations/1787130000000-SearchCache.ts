import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Caches what a shop answered for a question somebody asked.
 *
 * Not the catalogue crawl returning: nothing is fetched to fill this, so the
 * cost still follows demand rather than the size of a supplier's catalogue.
 *
 * It exists to make basket comparison possible. Forty lines against a shop read
 * through its sitemap is forty times eight page fetches — eleven minutes,
 * which nobody waits for. Buyers order the same articles every month, so the
 * second basket is the same questions again and answers instantly.
 */
export class SearchCache1787130000000 implements MigrationInterface {
  name = 'SearchCache1787130000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "search_cache" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "shop_id" uuid NOT NULL,
        "query" character varying(160) NOT NULL,
        "products" jsonb NOT NULL,
        "duration_ms" integer NOT NULL DEFAULT 0,
        "fetched_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_search_cache" PRIMARY KEY ("id"),
        CONSTRAINT "fk_search_cache_shop" FOREIGN KEY ("shop_id")
          REFERENCES "shops"("id") ON DELETE CASCADE
      )
    `);

    // One row per shop per question, so a repeat asks the index and not the shop.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_search_cache_lookup" ON "search_cache" ("shop_id", "query")`,
    );

    // Sweeping expired rows scans by age.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_search_cache_fetched" ON "search_cache" ("fetched_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "search_cache"`);
  }
}
