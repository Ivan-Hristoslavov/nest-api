import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seven days of Pro for every new account.
 *
 * One nullable column carries the whole feature: null means "never had one",
 * a future date means "running", a past date means "had it, and it is over".
 * That last state is why the column is never cleared when a trial ends — it is
 * the only record stopping the same mailbox taking another week tomorrow.
 *
 * Existing accounts are left alone. Backfilling a trial onto them would hand
 * Pro to every dormant registration at once, including the ones that signed up
 * and never returned.
 */
export class FreeTrial1787500000000 implements MigrationInterface {
  name = 'FreeTrial1787500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "trial_ends_at" TIMESTAMPTZ`);

    // The sweeper asks "whose trial has run out" every hour, which without this
    // is a sequential scan of the customer table on every pass.
    await queryRunner.query(`
      CREATE INDEX "idx_users_trial_ends_at" ON "users" ("trial_ends_at")
      WHERE "trial_ends_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_trial_ends_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "trial_ends_at"`);
  }
}
