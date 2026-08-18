import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records how each shop gets searched, decided once when it is added.
 *
 * Three routes, in the order that serves the user best: the shop's own search
 * where it is available, its sitemap where the search is forbidden but the
 * pages are listed, and neither — said plainly — where a storefront renders
 * its search in JavaScript and publishes no sitemap.
 *
 * Stored rather than re-derived per search: working it out costs a handful of
 * requests to somebody else's server, and the answer changes about as often as
 * a shop is rebuilt.
 */
export class ShopSearchMethod1787100000000 implements MigrationInterface {
  name = 'ShopSearchMethod1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "search_method" character varying(16) NOT NULL DEFAULT 'none'`,
    );
    await queryRunner.query(`ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "search_summary" text`);

    // Shops added before the probe existed: anything already carrying a search
    // template demonstrably has a working live search.
    await queryRunner.query(
      `UPDATE "shops" SET "search_method" = 'live' WHERE "search_url_template" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "search_summary"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "search_method"`);
  }
}
