import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Baseline schema: the `products` and `price_history` tables as they existed
 * when the project ran with `synchronize: true`.
 *
 * Written by hand and made idempotent with `IF NOT EXISTS` so it is a no-op on
 * the database that `synchronize` already built, while still creating the
 * schema correctly on a fresh one. That is what allows an existing deployment
 * to adopt migrations without dropping and recreating its data.
 */
export class InitialSchema1755400000000 implements MigrationInterface {
  name = 'InitialSchema1755400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."products_scrape_status_enum"
          AS ENUM('pending', 'success', 'failed', 'skipped');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "products" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(255) NOT NULL,
        "sku" character varying(64),
        "target_url" text NOT NULL,
        "competitor_url" text NOT NULL,
        "currency" character(3) NOT NULL DEFAULT 'EUR',
        "current_price" numeric(12,2),
        "previous_price" numeric(12,2),
        "target_price" numeric(12,2),
        "lowest_price" numeric(12,2),
        "highest_price" numeric(12,2),
        "last_updated" TIMESTAMP WITH TIME ZONE,
        "last_checked_at" TIMESTAMP WITH TIME ZONE,
        "scrape_status" "public"."products_scrape_status_enum" NOT NULL DEFAULT 'pending',
        "last_error" text,
        "failure_count" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "check_interval_minutes" integer NOT NULL DEFAULT 60,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_products" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_products_sku" ON "products" ("sku") WHERE "sku" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_products_active_last_checked" ON "products" ("is_active", "last_checked_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_products_competitor_url" ON "products" ("competitor_url")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "price_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "product_id" uuid NOT NULL,
        "price" numeric(12,2) NOT NULL,
        "previous_price" numeric(12,2),
        "change_percent" numeric(8,4),
        "currency" character(3) NOT NULL DEFAULT 'EUR',
        "source" character varying(255) NOT NULL,
        "recorded_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_price_history" PRIMARY KEY ("id"),
        CONSTRAINT "FK_price_history_product"
          FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_price_history_product_recorded" ON "price_history" ("product_id", "recorded_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "price_history"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "products"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."products_scrape_status_enum"`);
  }
}
