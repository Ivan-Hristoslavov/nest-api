import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Searches that survive a reload.
 *
 * Until now a comparison existed only in the browser's memory. Pressing F5
 * threw it away, and the buyer's only way back to the prices they had just been
 * reading was to run the whole search again — a dozen requests to other
 * people's servers to reproduce an answer we already had, and frequently a
 * *different* answer, because shops move.
 *
 * Two tables, because a question and its answers age differently. `saved_searches`
 * is the question, one row per owner per query per scope, updated in place when
 * it is asked again. `search_snapshots` is what the shops said, written once
 * and never touched: reopening Sunday's search must show Sunday's prices, and a
 * row that could be updated is a row that eventually is.
 *
 * The flat columns on the snapshot are a projection of its own `payload`. The
 * history list needs a status and two counts per row and nothing else, and
 * Postgres cannot reach into jsonb without reading it — so the list is answered
 * from indexed integers and the document is read only when a search is opened.
 *
 * Nothing here touches an existing table. `search_cache` keeps its job, which
 * is a different one: it holds one shop's raw reply for a few hours to spare
 * that shop a second request, and knows nothing about who asked or what the
 * matcher made of it.
 */
export class SearchHistory1791000000000 implements MigrationInterface {
  name = 'SearchHistory1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "saved_searches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "query" character varying(160) NOT NULL,
        "normalised_query" character varying(160) NOT NULL,
        "scope" character varying(16) NOT NULL DEFAULT 'my_suppliers',
        "run_count" integer NOT NULL DEFAULT 1,
        "last_status" character varying(16),
        "last_offer_count" integer NOT NULL DEFAULT 0,
        "last_run_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_saved_searches" PRIMARY KEY ("id")
      )
    `);

    // The history screen's only query, and the order it wants: a question
    // asked again belongs at the top, which is `updated_at`, not `created_at`.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_saved_searches_owner_updated"
        ON "saved_searches" ("owner_id", "updated_at" DESC)
    `);

    /*
     * One row per question per scope.
     *
     * Unique so that asking the same thing twice appends a snapshot instead of
     * accumulating near-identical history entries — and so the append can be a
     * single upsert. That matters beyond tidiness: two searches for the same
     * article arriving at once would otherwise race to insert, and one of them
     * would lose on a constraint that did not exist.
     */
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_saved_searches_owner_query"
        ON "saved_searches" ("owner_id", "normalised_query", "scope")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "search_snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "search_id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "status" character varying(16) NOT NULL,
        "offer_count" integer NOT NULL DEFAULT 0,
        "alternative_count" integer NOT NULL DEFAULT 0,
        "shops_asked" integer NOT NULL DEFAULT 0,
        "shops_answered" integer NOT NULL DEFAULT 0,
        "best_price" numeric(12,2),
        "best_currency" character(3),
        "duration_ms" integer NOT NULL DEFAULT 0,
        "payload" jsonb NOT NULL,
        "fetched_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_search_snapshots" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "search_snapshots"
        DROP CONSTRAINT IF EXISTS "fk_search_snapshots_search"
    `);

    // Deleting a search takes its snapshots with it. They have no meaning on
    // their own, and an orphaned document nobody can reach is storage paid for
    // forever.
    await queryRunner.query(`
      ALTER TABLE "search_snapshots"
        ADD CONSTRAINT "fk_search_snapshots_search"
        FOREIGN KEY ("search_id") REFERENCES "saved_searches"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_search_snapshots_search_fetched"
        ON "search_snapshots" ("search_id", "fetched_at" DESC)
    `);

    // The owner is repeated on the snapshot so an ownership check never
    // depends on remembering to join the parent. The check that is easiest to
    // write has to be the safe one.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_search_snapshots_owner_fetched"
        ON "search_snapshots" ("owner_id", "fetched_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "search_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "saved_searches"`);
  }
}
