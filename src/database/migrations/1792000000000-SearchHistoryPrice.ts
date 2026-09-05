import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The price a search found, on the row that lists it.
 *
 * The history list answers one question per line — "did I find this, and for
 * how much" — and it could only answer half of it. The figure existed on the
 * snapshot, but reaching it meant opening a jsonb document per row, which is
 * exactly what the projected columns beside it were added to avoid.
 *
 * So the cheapest offer of the most recent run joins the status and the count
 * already projected here. Like them it is a *copy*, refreshed on every run and
 * authoritative nowhere: the snapshot remains the record of what the shops
 * said, and this is the summary that lets a list of twenty searches be drawn
 * from one indexed query.
 *
 * Backfilled from the newest snapshot of each search, so a history that
 * already exists gains its prices rather than showing blanks until the next
 * time somebody searches.
 */
export class SearchHistoryPrice1792000000000 implements MigrationInterface {
  name = 'SearchHistoryPrice1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "saved_searches"
        ADD COLUMN IF NOT EXISTS "last_best_price" numeric(12,2),
        ADD COLUMN IF NOT EXISTS "last_best_currency" character(3)
    `);

    // Every search that already has snapshots keeps its newest one's figure.
    // `DISTINCT ON` takes the first row per search under that ordering, which
    // is the most recently fetched.
    await queryRunner.query(`
      UPDATE "saved_searches" AS s
         SET "last_best_price" = newest."best_price",
             "last_best_currency" = newest."best_currency"
        FROM (
          SELECT DISTINCT ON ("search_id")
                 "search_id", "best_price", "best_currency"
            FROM "search_snapshots"
           ORDER BY "search_id", "fetched_at" DESC
        ) AS newest
       WHERE newest."search_id" = s."id"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "saved_searches"
        DROP COLUMN IF EXISTS "last_best_price",
        DROP COLUMN IF EXISTS "last_best_currency"
    `);
  }
}
