import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two column defaults that had drifted away from the entities.
 *
 * Neither had bitten yet, which is why they survived: both columns are always
 * written explicitly by the code that creates the row. They are fixed because
 * a default is a promise about what happens when someone forgets, and both of
 * these promised the wrong thing.
 *
 * `users.product_limit` said 5 where the free plan is 10 — the number on the
 * pricing page, in the welcome email and in `PLAN_PRODUCT_LIMIT`. An account
 * created by any future path that does not set it would have been given half
 * of what it was sold.
 *
 * `orders.total` said 0. A total is computed from the lines; a default means a
 * bug that forgets to set it writes a zero-lev order instead of failing, and a
 * zero-lev order is one that gets emailed to a supplier.
 */
export class ColumnDefaults1787800000000 implements MigrationInterface {
  name = 'ColumnDefaults1787800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "product_limit" SET DEFAULT 10`);
    await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "total" DROP DEFAULT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ALTER COLUMN "total" SET DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "product_limit" SET DEFAULT 5`);
  }
}
