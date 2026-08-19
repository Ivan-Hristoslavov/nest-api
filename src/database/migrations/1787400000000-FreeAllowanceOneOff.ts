import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The free AI allowance stops renewing, and shrinks.
 *
 * A monthly free allowance is worth farming: three mailboxes are three
 * allowances, every month, for ever, and nothing about a password or a phone
 * number changes that arithmetic. A one-off allowance is worth farming once,
 * for fifty comparisons — which is not worth anybody's morning.
 *
 * Existing free accounts keep whatever they have already spent; only the
 * ceiling moves, and the code stops resetting it.
 */
export class FreeAllowanceOneOff1787400000000 implements MigrationInterface {
  name = 'FreeAllowanceOneOff1787400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users"
      SET "ai_matches_limit" = 50
      WHERE "plan" = 'free' AND "ai_matches_limit" <> 50
    `);

    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "ai_matches_limit" SET DEFAULT 50`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users" SET "ai_matches_limit" = 200 WHERE "plan" = 'free'
    `);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "ai_matches_limit" SET DEFAULT 200`);
  }
}
