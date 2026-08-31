import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The terms a price actually depends on, beyond the discount.
 *
 * Until now a customer's price was `list × (1 − discount)` and nothing else,
 * which is wrong in three ways that all point the same direction — they make a
 * supplier look cheaper than they are:
 *
 *  - **VAT.** Wholesale sites quote net at one shop and gross at the next.
 *    Comparing the two is a 20% error, larger than almost any negotiated
 *    discount.
 *  - **Delivery.** Charged once per order, so splitting an order across four
 *    suppliers saves on goods and adds four deliveries.
 *  - **Minimum order.** A supplier who will not accept the order is not the
 *    cheapest; they are not an option.
 *
 * Every column added here defaults to something neutral, so existing shops
 * price exactly as they did before this ran. `vat_state` in particular
 * defaults to `unknown` rather than to a guess: a price read off a page says
 * nothing about VAT, and inventing that fact is the failure the column exists
 * to prevent. Offers on an unknown basis are still shown and still ranked —
 * they are simply marked as not directly comparable against offers whose basis
 * is known.
 */
export class SupplierCommercialTerms1789000000000 implements MigrationInterface {
  name = 'SupplierCommercialTerms1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "shops"
        ADD COLUMN IF NOT EXISTS "vat_state" character varying(12) NOT NULL DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS "vat_rate" numeric(5,2) NOT NULL DEFAULT 20,
        ADD COLUMN IF NOT EXISTS "shipping_cost" numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "free_shipping_over" numeric(12,2),
        ADD COLUMN IF NOT EXISTS "handling_fee" numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "min_order_value" numeric(12,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "terms_note" text
    `);

    // A check constraint rather than a Postgres enum: the set is small and
    // stable, and an enum type would need its own migration to extend while a
    // constraint is one ALTER. Named, so it can be dropped by name rather than
    // hunted for.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_shops_vat_state'
        ) THEN
          ALTER TABLE "shops"
            ADD CONSTRAINT "chk_shops_vat_state"
            CHECK ("vat_state" IN ('inclusive', 'exclusive', 'unknown'));
        END IF;
      END $$;
    `);

    // Money cannot be negative, and a free-shipping threshold below zero would
    // silently mean "always free" — a typo that hands out delivery for nothing
    // and is invisible in the interface.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'chk_shops_terms_non_negative'
        ) THEN
          ALTER TABLE "shops"
            ADD CONSTRAINT "chk_shops_terms_non_negative"
            CHECK (
              "vat_rate" >= 0 AND "vat_rate" <= 100
              AND "shipping_cost" >= 0
              AND "handling_fee" >= 0
              AND "min_order_value" >= 0
              AND ("free_shipping_over" IS NULL OR "free_shipping_over" >= 0)
            );
        END IF;
      END $$;
    `);

    // No index. Every one of these columns is read only after a shop row has
    // already been fetched by owner and host, so an index on them would be
    // written on every update and never used for a lookup.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "chk_shops_terms_non_negative"`,
    );
    await queryRunner.query(`ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "chk_shops_vat_state"`);
    await queryRunner.query(`
      ALTER TABLE "shops"
        DROP COLUMN IF EXISTS "terms_note",
        DROP COLUMN IF EXISTS "min_order_value",
        DROP COLUMN IF EXISTS "handling_fee",
        DROP COLUMN IF EXISTS "free_shipping_over",
        DROP COLUMN IF EXISTS "shipping_cost",
        DROP COLUMN IF EXISTS "vat_rate",
        DROP COLUMN IF EXISTS "vat_state"
    `);
  }
}
