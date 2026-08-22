import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Order requests.
 *
 * The comparison answers "where should I buy this today"; this is where the
 * sentence after it is written down. Deliberately a *request*: no money moves
 * through these tables, nothing is reserved, and the email that goes out is
 * from the buyer's company with their address in Reply-To. Standing between
 * two companies in a sale is a different business with different liabilities.
 *
 * `number` is unique per account rather than globally. A buyer's third order
 * is "#3" to them, and a number that jumps to 4,812 because other customers
 * exist tells them how many other customers exist.
 */
export class Orders1787700000000 implements MigrationInterface {
  name = 'Orders1787700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shops"
        ADD COLUMN IF NOT EXISTS "order_email" VARCHAR(320),
        ADD COLUMN IF NOT EXISTS "order_contact" VARCHAR(160)
    `);

    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "owner_id" uuid NOT NULL,
        "number" integer NOT NULL,
        "shop_id" uuid NOT NULL,
        "shop_name" character varying(255) NOT NULL,
        "shop_email" character varying(320),
        "status" character varying(16) NOT NULL DEFAULT 'draft',
        "currency" character(3) NOT NULL DEFAULT 'EUR',
        "total" numeric(12,2) NOT NULL DEFAULT 0,
        "note" text,
        "sent_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_orders" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "order_lines" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "order_id" uuid NOT NULL,
        "query" character varying(500) NOT NULL,
        "matched_name" character varying(500),
        "url" text,
        "quantity" numeric(12,2) NOT NULL,
        "unit_price" numeric(12,2) NOT NULL,
        "line_total" numeric(12,2) NOT NULL,
        CONSTRAINT "pk_order_lines" PRIMARY KEY ("id")
      )
    `);

    // Deleting an account takes its orders, and an order takes its lines. The
    // privacy policy promises erasure, and a promise that leaves rows behind
    // is not one.
    await queryRunner.query(`
      ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_owner"
        FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "order_lines" ADD CONSTRAINT "fk_order_lines_order"
        FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX "idx_orders_owner_number" ON "orders" ("owner_id", "number")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_orders_owner_created" ON "orders" ("owner_id", "created_at")`,
    );
    await queryRunner.query(`CREATE INDEX "idx_orders_status" ON "orders" ("status")`);
    await queryRunner.query(`CREATE INDEX "idx_order_lines_order" ON "order_lines" ("order_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "order_lines"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "orders"`);
    await queryRunner.query(`
      ALTER TABLE "shops"
        DROP COLUMN IF EXISTS "order_contact",
        DROP COLUMN IF EXISTS "order_email"
    `);
  }
}
