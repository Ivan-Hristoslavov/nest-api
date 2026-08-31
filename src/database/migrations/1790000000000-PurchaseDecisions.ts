import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The record behind "you saved €214".
 *
 * Until now that number existed only in a response. It was correct when it was
 * computed and unreproducible ten minutes later: recomputing it needs the
 * supplier's discount, their delivery charge, their minimum order and the
 * article's price *as they were then*, and all four are live rows that move.
 * A claim nobody can check is not evidence, and this is the one number the
 * product is bought for.
 *
 * So a decision is written down whole. `snapshot` holds the document — terms,
 * prices, provenance, matches, the plan and everything it beat — and the flat
 * columns beside it are a projection of that document, indexed, so the list and
 * savings screens can be answered without reading every row.
 *
 * Nothing in this migration touches an existing table's data. `orders` gains
 * one nullable column, and every order written before today keeps meaning
 * exactly what it meant.
 */
export class PurchaseDecisions1790000000000 implements MigrationInterface {
  name = 'PurchaseDecisions1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "purchase_decisions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "owner_id" uuid NOT NULL,
        "number" integer NOT NULL,
        "currency" character(3) NOT NULL DEFAULT 'EUR',
        "line_count" integer NOT NULL,
        "suppliers_used" integer NOT NULL,
        "supplier_ids" uuid[] NOT NULL DEFAULT '{}',
        "baseline_total" numeric(14,2),
        "optimised_total" numeric(14,2) NOT NULL,
        "savings" numeric(14,2),
        "savings_percent" numeric(6,2),
        "savings_kind" character varying(16) NOT NULL DEFAULT 'potential',
        "realized_total" numeric(14,2),
        "realized_savings" numeric(14,2),
        "bounded_search" boolean NOT NULL DEFAULT false,
        "duration_ms" integer NOT NULL DEFAULT 0,
        "snapshot" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_purchase_decisions" PRIMARY KEY ("id")
      )
    `);

    // Numbered per account, like orders. The unique index is what the advisory
    // lock in the service protects: without it two decisions saved in the same
    // second would both be "#4".
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_purchase_decisions_owner_number"
        ON "purchase_decisions" ("owner_id", "number")
    `);

    // The list screen. Descending on the date because every screen that reads
    // this table reads it newest first.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_purchase_decisions_owner_created"
        ON "purchase_decisions" ("owner_id", "created_at" DESC)
    `);

    // The savings screen, sorted by what each decision saved.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_purchase_decisions_owner_savings"
        ON "purchase_decisions" ("owner_id", "savings" DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_purchase_decisions_savings_kind"
        ON "purchase_decisions" ("savings_kind")
    `);

    // GIN, because the only question asked of this column is "which decisions
    // involved this supplier", which is array containment. A btree would not
    // answer it.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_purchase_decisions_suppliers"
        ON "purchase_decisions" USING GIN ("supplier_ids")
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_purchase_decisions_savings_kind'
        ) THEN
          ALTER TABLE "purchase_decisions"
            ADD CONSTRAINT "chk_purchase_decisions_savings_kind"
            CHECK ("savings_kind" IN ('potential', 'realized'));
        END IF;
      END $$;
    `);

    // A realized figure without the spend behind it is the exact claim this
    // feature exists to prevent, so the database refuses to hold one. Stated
    // here rather than only in the service because a constraint survives a
    // refactor, a migration run by hand, and a future second writer.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_purchase_decisions_realized'
        ) THEN
          ALTER TABLE "purchase_decisions"
            ADD CONSTRAINT "chk_purchase_decisions_realized"
            CHECK (
              ("savings_kind" = 'potential' AND "realized_total" IS NULL AND "realized_savings" IS NULL)
              OR ("savings_kind" = 'realized' AND "realized_total" IS NOT NULL)
            );
        END IF;
      END $$;
    `);

    /*
     * Immutability, enforced where it cannot be argued with.
     *
     * The service has no update method, which stops the mistake being made on
     * purpose. This stops it being made by accident — by a future endpoint, a
     * migration written in a hurry, a console session, or an ORM feature
     * nobody expected to issue an UPDATE.
     *
     * The two realized columns and `savings_kind` are the sole exceptions, and
     * they are the opposite of a revision: they record that a purchase
     * happened. Everything the decision *claimed* — the terms, the prices, the
     * plan, the saving — is frozen, and the trigger raises rather than
     * silently ignoring a change, because a write that is quietly dropped is
     * how two systems come to disagree about what a record says.
     */
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION purchase_decisions_immutable()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
           OR NEW.number IS DISTINCT FROM OLD.number
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.line_count IS DISTINCT FROM OLD.line_count
           OR NEW.suppliers_used IS DISTINCT FROM OLD.suppliers_used
           OR NEW.supplier_ids IS DISTINCT FROM OLD.supplier_ids
           OR NEW.baseline_total IS DISTINCT FROM OLD.baseline_total
           OR NEW.optimised_total IS DISTINCT FROM OLD.optimised_total
           OR NEW.savings IS DISTINCT FROM OLD.savings
           OR NEW.savings_percent IS DISTINCT FROM OLD.savings_percent
           OR NEW.bounded_search IS DISTINCT FROM OLD.bounded_search
           OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms
           OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION
            'purchase_decisions is a historical record: only savings_kind, realized_total and realized_savings may change after insert';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "trg_purchase_decisions_immutable" ON "purchase_decisions"
    `);

    await queryRunner.query(`
      CREATE TRIGGER "trg_purchase_decisions_immutable"
        BEFORE UPDATE ON "purchase_decisions"
        FOR EACH ROW EXECUTE FUNCTION purchase_decisions_immutable()
    `);

    /*
     * The link to an order.
     *
     * On `orders` rather than on the decision, and nullable, because that is
     * the direction the facts run: one decision may become several orders (a
     * plan split across two suppliers is two of them), an order may exist
     * without any decision behind it (the existing flow, which must keep
     * working), and the decision is the earlier record — it cannot point at
     * rows that do not exist yet.
     *
     * `ON DELETE SET NULL` rather than CASCADE: deleting the reasoning must
     * never delete the record of an order that was actually placed. In
     * practice nothing deletes decisions, but the constraint is where that
     * intent is written down.
     */
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "purchase_decision_id" uuid
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_purchase_decision'
        ) THEN
          ALTER TABLE "orders"
            ADD CONSTRAINT "fk_orders_purchase_decision"
            FOREIGN KEY ("purchase_decision_id")
            REFERENCES "purchase_decisions" ("id")
            ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    // Partial, because the overwhelming majority of orders have no decision
    // and indexing their NULLs would cost writes to answer nothing. The only
    // query is "which orders came from this decision".
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_orders_purchase_decision"
        ON "orders" ("purchase_decision_id")
        WHERE "purchase_decision_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_orders_purchase_decision"`);
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "fk_orders_purchase_decision"`,
    );
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "purchase_decision_id"`);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_purchase_decisions_immutable" ON "purchase_decisions"`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS purchase_decisions_immutable()`);
    await queryRunner.query(`DROP TABLE IF EXISTS "purchase_decisions"`);
  }
}
