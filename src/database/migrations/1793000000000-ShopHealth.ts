import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What the last health check concluded about each shop's search.
 *
 * A supplier's search page breaks quietly: it starts answering every query
 * with the same twenty tiles, or with none, and the customer's comparison
 * simply stops mentioning that supplier. Until now the only way to learn this
 * was a customer reporting nonsense results — Elmark and Technopolis were
 * both found that way, months after the fact.
 *
 * The check writes its verdict here, on the shop row, so the operator screen
 * can say which hosts are answering and the daily run can tell "still broken"
 * from "broke last night" — the second is the one worth an email.
 */
export class ShopHealth1793000000000 implements MigrationInterface {
  name = 'ShopHealth1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shops"
        ADD COLUMN IF NOT EXISTS "health_status" character varying(16),
        ADD COLUMN IF NOT EXISTS "health_detail" text,
        ADD COLUMN IF NOT EXISTS "health_checked_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shops"
        DROP COLUMN IF EXISTS "health_status",
        DROP COLUMN IF EXISTS "health_detail",
        DROP COLUMN IF EXISTS "health_checked_at"
    `);
  }
}
