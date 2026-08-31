import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Letters asking a supplier for a feed instead of a scraper.
 *
 * Unique on `host`, which is the point rather than a detail: the same
 * wholesaler exists as one `shops` row per customer who added it, and a table
 * keyed by anything else would let one partnership request go out four times
 * to the same inbox. The constraint is what makes "have we already written to
 * them" answerable without trusting whoever is reading the screen.
 */
export class ApiOutreach1788000000000 implements MigrationInterface {
  name = 'ApiOutreach1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_outreach" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "host" character varying(255) NOT NULL,
        "recipient" character varying(320) NOT NULL,
        "locale" character varying(5) NOT NULL,
        "subject" text NOT NULL,
        "body" text NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'sent',
        "note" text,
        "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_api_outreach" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_outreach_host" ON "api_outreach" ("host")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_api_outreach_host"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "api_outreach"`);
  }
}
