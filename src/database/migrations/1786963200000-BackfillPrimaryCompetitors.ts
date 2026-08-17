import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data migration: gives every pre-existing product the primary competitor row
 * that multi-competitor tracking now assumes.
 *
 * Before this change a product carried a single `competitor_url`. The scraper
 * now iterates `competitors`, so without a backfill every product created
 * before the upgrade would be silently skipped by every sweep — the worst kind
 * of breakage, because nothing errors.
 *
 * Existing `price_history` rows are re-pointed at the new listing so the charts
 * stay continuous.
 */
export class BackfillPrimaryCompetitors1786963200000 implements MigrationInterface {
  name = 'BackfillPrimaryCompetitors1786963200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // One listing per product that has none, derived from `competitor_url`.
    // The host is extracted in SQL so the migration needs no application code.
    await queryRunner.query(`
      INSERT INTO "competitors" (
        "product_id", "name", "url", "host", "is_primary", "is_active",
        "currency", "current_price", "previous_price", "last_updated",
        "last_checked_at", "scrape_status", "failure_count"
      )
      SELECT
        p."id",
        COALESCE(
          NULLIF(split_part(regexp_replace(p."competitor_url", '^https?://(www\\.)?', ''), '/', 1), ''),
          'Competitor'
        ),
        p."competitor_url",
        COALESCE(
          NULLIF(split_part(regexp_replace(p."competitor_url", '^https?://', ''), '/', 1), ''),
          'unknown'
        ),
        true,
        true,
        p."currency",
        p."current_price",
        p."previous_price",
        p."last_updated",
        p."last_checked_at",
        -- The two tables have separate enum types with identical members, so
        -- the value has to round-trip through text.
        p."scrape_status"::text::"public"."competitors_scrape_status_enum",
        p."failure_count"
      FROM "products" p
      WHERE NOT EXISTS (
        SELECT 1 FROM "competitors" c WHERE c."product_id" = p."id"
      )
    `);

    // Point the product at its new listing and record the count.
    await queryRunner.query(`
      UPDATE "products" p
      SET "cheapest_competitor_id" = c."id",
          "competitor_count" = 1
      FROM "competitors" c
      WHERE c."product_id" = p."id"
        AND c."is_primary" = true
        AND p."cheapest_competitor_id" IS NULL
    `);

    // Attach the historical observations to that listing.
    await queryRunner.query(`
      UPDATE "price_history" h
      SET "competitor_id" = c."id"
      FROM "competitors" c
      WHERE c."product_id" = h."product_id"
        AND c."is_primary" = true
        AND h."competitor_id" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "price_history" SET "competitor_id" = NULL`);
    await queryRunner.query(
      `UPDATE "products" SET "cheapest_competitor_id" = NULL, "competitor_count" = 0`,
    );
    await queryRunner.query(`DELETE FROM "competitors" WHERE "is_primary" = true`);
  }
}
