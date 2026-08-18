import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives every product and supplier an owner.
 *
 * Until now a valid API key saw all of them. That is tolerable for one
 * customer and indefensible for two: the comparison ranks by each customer's
 * *negotiated discount*, so a shared `shops` table publishes the terms one
 * buyer agreed with a wholesaler to every other buyer holding a key. Supplier
 * discounts are commercial secrets, and competitors would have been reading
 * each other's.
 *
 * Existing rows are assigned to the oldest account in good standing — see the
 * query below for why "in good standing" and not simply "oldest".
 *
 * Two unique constraints become per-owner at the same time, for the same
 * reason: one customer's SKU must not collide with another's, and two
 * customers may both buy from the same wholesaler on entirely different terms.
 */
export class MultiTenancy1787110000000 implements MigrationInterface {
  name = 'MultiTenancy1787110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The oldest *active* account, not simply the oldest: a seeded demo user
    // is often the first row in the table, and on this project it was — the
    // whole catalogue was handed to an expired example account and had to be
    // moved by hand. An account in good standing is the one that could have
    // been using the system.
    const [owner] = (await queryRunner.query(`
      SELECT id FROM "users"
      ORDER BY (status = 'active') DESC, created_at ASC
      LIMIT 1
    `)) as Array<{ id: string }>;

    if (!owner) {
      // Nothing to inherit the data. A deployment with rows but no account
      // cannot be resolved automatically, and guessing would hand somebody
      // else's catalogue to the first customer who signs up.
      const [{ count }] = (await queryRunner.query(
        `SELECT (SELECT COUNT(*) FROM "products") + (SELECT COUNT(*) FROM "shops") AS count`,
      )) as Array<{ count: string }>;

      if (Number(count) > 0) {
        throw new Error(
          'There are products or shops but no user account to own them. Create the operator ' +
            'account first (pay once, or insert a row into "users"), then run this migration.',
        );
      }
    }

    for (const table of ['products', 'shops']) {
      await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "owner_id" uuid`);

      if (owner) {
        await queryRunner.query(`UPDATE "${table}" SET "owner_id" = $1 WHERE "owner_id" IS NULL`, [
          owner.id,
        ]);
      }

      await queryRunner.query(`ALTER TABLE "${table}" ALTER COLUMN "owner_id" SET NOT NULL`);

      // Deleting an account takes its data with it. Leaving orphaned rows
      // behind would mean a future account could be handed them.
      await queryRunner.query(`
        ALTER TABLE "${table}"
        ADD CONSTRAINT "fk_${table}_owner" FOREIGN KEY ("owner_id")
        REFERENCES "users"("id") ON DELETE CASCADE
      `);
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_products_owner" ON "products" ("owner_id")`,
    );

    // Shops: host was globally unique, which would stop a second customer
    // adding a wholesaler the first one already uses.
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_shops_host"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_shops_owner_host" ON "shops" ("owner_id", "host")`,
    );

    // Products: the same for SKU, which Postgres enforced with an unnamed
    // constraint created by the original schema.
    const skuConstraints = (await queryRunner.query(`
      SELECT con.conname AS name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
      WHERE rel.relname = 'products' AND con.contype = 'u' AND att.attname = 'sku'
    `)) as Array<{ name: string }>;

    for (const constraint of skuConstraints) {
      await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "${constraint.name}"`);
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_products_owner_sku" ON "products" ("owner_id", "sku") WHERE "sku" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_products_owner_sku"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_shops_owner_host"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_products_owner"`);

    await queryRunner.query(`ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "fk_shops_owner"`);
    await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "fk_products_owner"`);

    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "owner_id"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "owner_id"`);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_shops_host" ON "shops" ("host")`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "uq_products_sku" UNIQUE ("sku")`,
    );
  }
}
