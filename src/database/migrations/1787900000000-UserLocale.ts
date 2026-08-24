import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The language an account is written to.
 *
 * Every email left in Bulgarian regardless of who was reading it, because
 * nothing anywhere recorded what they read. The site has spoken four languages
 * for a while; the mail that reaches them outside it did not.
 *
 * Nullable rather than defaulted: an account opened before this column existed
 * has no answer, and inventing Bulgarian for it would be a guess wearing the
 * clothes of a fact. Empty means the source language, which is where the
 * translator falls back anyway.
 */
export class UserLocale1787900000000 implements MigrationInterface {
  name = 'UserLocale1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locale" VARCHAR(5)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "locale"`);
  }
}
