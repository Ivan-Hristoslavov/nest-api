import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An optional second factor, and an index the retention sweep needs.
 *
 * The three columns are all nullable and all default to null, so every
 * existing account carries on signing in exactly as before. Two-factor is
 * something a customer turns on, not something that happens to them.
 *
 * `totp_secret` is the one secret in this system that cannot be a digest — the
 * server has to compute codes from it — so it is stored encrypted, with the
 * key held in the environment rather than the database. A dump of this table
 * on its own is therefore useless, which is the case a second factor exists
 * for in the first place.
 */
export class TwoFactorAndRetention1787600000000 implements MigrationInterface {
  name = 'TwoFactorAndRetention1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "totp_secret" VARCHAR(255)`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "totp_confirmed_at" TIMESTAMPTZ`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "totp_recovery_hashes" JSONB`);

    // The retention sweep asks "what is older than N days" nightly over the
    // largest table in the database. Without this it is a sequential scan of
    // tens of millions of rows, every night, competing with the price sweep.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_price_history_recorded_at" ON "price_history" ("recorded_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_price_history_recorded_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "totp_recovery_hashes"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "totp_confirmed_at"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "totp_secret"`);
  }
}
