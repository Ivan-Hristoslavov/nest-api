import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Storage for AI product matching: the answers already paid for, and the
 * allowance each account gets.
 *
 * The cache is the cost control that matters. A supplier's product name is
 * stable for months, so the same pair asked twice is the same answer — paid
 * for twice unless it is remembered. The allowance is the second control: it
 * bounds what a single account can spend on a feature whose cost is per call
 * rather than per subscription.
 */
export class AiMatching1787200000000 implements MigrationInterface {
  name = 'AiMatching1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_match_cache" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "fingerprint" character(64) NOT NULL,
        "is_same" boolean NOT NULL,
        "confidence" numeric(4,3) NOT NULL,
        "reason" text NOT NULL,
        "model" character varying(64) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_ai_match_cache" PRIMARY KEY ("id")
      )
    `);

    // The fingerprint already carries the model and the prompt version, so a
    // new prompt writes new rows rather than reading stale ones.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_ai_match_cache_fingerprint" ON "ai_match_cache" ("fingerprint")`,
    );

    // Sweeping old rows scans by age.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_ai_match_cache_created" ON "ai_match_cache" ("created_at")`,
    );

    // AI is metered apart from price checks because it is a different cost.
    // A price check is one HTTP request to a shop; a match is tokens. Mixing
    // them into one counter would make a heavy searcher look like a heavy
    // scraper and get throttled for the wrong reason.
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "ai_matches_used" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "ai_matches_limit" integer NOT NULL DEFAULT 200,
        ADD COLUMN IF NOT EXISTS "ai_period_started_at" TIMESTAMP WITH TIME ZONE
    `);

    // Existing accounts get the allowance their plan implies rather than the
    // free-tier default the column was created with.
    await queryRunner.query(`
      UPDATE "users" SET "ai_matches_limit" = CASE "plan"
        WHEN 'starter'  THEN 2000
        WHEN 'pro'      THEN 10000
        WHEN 'business' THEN 50000
        ELSE 200
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "ai_matches_used",
        DROP COLUMN IF EXISTS "ai_matches_limit",
        DROP COLUMN IF EXISTS "ai_period_started_at"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_match_cache"`);
  }
}
