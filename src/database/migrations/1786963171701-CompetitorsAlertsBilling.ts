import { MigrationInterface, QueryRunner } from "typeorm";

export class CompetitorsAlertsBilling1786963171701 implements MigrationInterface {
    name = 'CompetitorsAlertsBilling1786963171701'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uq_products_sku"`);
        await queryRunner.query(`CREATE TYPE "public"."competitors_scrape_status_enum" AS ENUM('pending', 'success', 'failed', 'skipped')`);
        await queryRunner.query(`CREATE TABLE "competitors" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "product_id" uuid NOT NULL, "name" character varying(120) NOT NULL, "url" text NOT NULL, "host" character varying(255) NOT NULL, "is_primary" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, "price_selector" character varying(255), "price_attribute" character varying(64), "currency" character(3) NOT NULL DEFAULT 'EUR', "current_price" numeric(12,2), "previous_price" numeric(12,2), "in_stock" boolean, "last_updated" TIMESTAMP WITH TIME ZONE, "last_checked_at" TIMESTAMP WITH TIME ZONE, "scrape_status" "public"."competitors_scrape_status_enum" NOT NULL DEFAULT 'pending', "last_error" text, "failure_count" integer NOT NULL DEFAULT '0', "last_strategy" character varying(32), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_competitors_product_url" UNIQUE ("product_id", "url"), CONSTRAINT "PK_76a451dd0c8a51a0e0fb6284389" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_competitors_active_last_checked" ON "competitors" ("is_active", "last_checked_at") `);
        await queryRunner.query(`CREATE TYPE "public"."alerts_type_enum" AS ENUM('price_drop', 'price_rise', 'undercut', 'all_time_low', 'out_of_stock', 'scrape_failing')`);
        await queryRunner.query(`CREATE TYPE "public"."alerts_severity_enum" AS ENUM('info', 'warning', 'critical')`);
        await queryRunner.query(`CREATE TYPE "public"."alerts_delivery_status_enum" AS ENUM('pending', 'delivered', 'failed', 'skipped')`);
        await queryRunner.query(`CREATE TABLE "alerts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "product_id" uuid NOT NULL, "competitor_id" uuid, "type" "public"."alerts_type_enum" NOT NULL, "severity" "public"."alerts_severity_enum" NOT NULL DEFAULT 'info', "message" text NOT NULL, "old_price" numeric(12,2), "new_price" numeric(12,2), "change_percent" numeric(8,4), "currency" character(3) NOT NULL DEFAULT 'EUR', "delivery_status" "public"."alerts_delivery_status_enum" NOT NULL DEFAULT 'pending', "delivered_channels" text array, "delivery_error" text, "acknowledged_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_60f895662df096bfcdfab7f4b96" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_alerts_unacknowledged" ON "alerts" ("acknowledged_at") `);
        await queryRunner.query(`CREATE INDEX "idx_alerts_product_created" ON "alerts" ("product_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "idx_alerts_created" ON "alerts" ("created_at") `);
        await queryRunner.query(`CREATE TABLE "billing_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "event_id" character varying(191) NOT NULL, "provider" character varying(32) NOT NULL, "event_type" character varying(128) NOT NULL, "email" character varying(320), "user_id" uuid, "processed" boolean NOT NULL DEFAULT false, "note" text, "payload" jsonb NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9a4a4a1b1f55bbc868f6a76a597" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_billing_events_event_id" ON "billing_events" ("event_id") `);
        await queryRunner.query(`CREATE INDEX "idx_billing_events_type" ON "billing_events" ("event_type") `);
        await queryRunner.query(`CREATE TYPE "public"."users_status_enum" AS ENUM('pending', 'active', 'expired', 'suspended')`);
        await queryRunner.query(`CREATE TYPE "public"."users_plan_enum" AS ENUM('free', 'starter', 'pro', 'business')`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying(320) NOT NULL, "name" character varying(255), "api_key_hash" character varying(64), "api_key_prefix" character varying(24), "api_key_issued_at" TIMESTAMP WITH TIME ZONE, "api_key_last_used_at" TIMESTAMP WITH TIME ZONE, "status" "public"."users_status_enum" NOT NULL DEFAULT 'pending', "plan" "public"."users_plan_enum" NOT NULL DEFAULT 'free', "product_limit" integer NOT NULL DEFAULT '5', "paddle_customer_id" character varying(128), "subscription_id" character varying(128), "last_payment_id" character varying(128), "last_payment_at" TIMESTAMP WITH TIME ZONE, "access_expires_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_users_api_key_hash" ON "users" ("api_key_hash") `);
        await queryRunner.query(`CREATE INDEX "idx_users_status" ON "users" ("status") `);
        await queryRunner.query(`CREATE INDEX "idx_users_paddle_customer" ON "users" ("paddle_customer_id") `);
        await queryRunner.query(`ALTER TABLE "price_history" ADD "competitor_id" uuid`);
        await queryRunner.query(`ALTER TABLE "products" ADD "cheapest_competitor_id" uuid`);
        await queryRunner.query(`ALTER TABLE "products" ADD "competitor_count" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "products" ADD "our_price" numeric(12,2)`);
        await queryRunner.query(`CREATE INDEX "idx_price_history_competitor_recorded" ON "price_history" ("competitor_id", "recorded_at") `);
        await queryRunner.query(`ALTER TABLE "price_history" ADD CONSTRAINT "FK_52cb611fd8151a893dd82b996df" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "competitors" ADD CONSTRAINT "FK_c68675be426f567a0a2c5801ab5" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "alerts" ADD CONSTRAINT "FK_137b233903b939bcae8421722ee" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "alerts" ADD CONSTRAINT "FK_da354081829e982f6b8f0925aa4" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "alerts" DROP CONSTRAINT "FK_da354081829e982f6b8f0925aa4"`);
        await queryRunner.query(`ALTER TABLE "alerts" DROP CONSTRAINT "FK_137b233903b939bcae8421722ee"`);
        await queryRunner.query(`ALTER TABLE "competitors" DROP CONSTRAINT "FK_c68675be426f567a0a2c5801ab5"`);
        await queryRunner.query(`ALTER TABLE "price_history" DROP CONSTRAINT "FK_52cb611fd8151a893dd82b996df"`);
        await queryRunner.query(`DROP INDEX "public"."idx_price_history_competitor_recorded"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "our_price"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "competitor_count"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "cheapest_competitor_id"`);
        await queryRunner.query(`ALTER TABLE "price_history" DROP COLUMN "competitor_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_users_paddle_customer"`);
        await queryRunner.query(`DROP INDEX "public"."idx_users_status"`);
        await queryRunner.query(`DROP INDEX "public"."idx_users_api_key_hash"`);
        await queryRunner.query(`DROP INDEX "public"."idx_users_email"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TYPE "public"."users_plan_enum"`);
        await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_billing_events_type"`);
        await queryRunner.query(`DROP INDEX "public"."idx_billing_events_event_id"`);
        await queryRunner.query(`DROP TABLE "billing_events"`);
        await queryRunner.query(`DROP INDEX "public"."idx_alerts_created"`);
        await queryRunner.query(`DROP INDEX "public"."idx_alerts_product_created"`);
        await queryRunner.query(`DROP INDEX "public"."idx_alerts_unacknowledged"`);
        await queryRunner.query(`DROP TABLE "alerts"`);
        await queryRunner.query(`DROP TYPE "public"."alerts_delivery_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."alerts_severity_enum"`);
        await queryRunner.query(`DROP TYPE "public"."alerts_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."idx_competitors_active_last_checked"`);
        await queryRunner.query(`DROP TABLE "competitors"`);
        await queryRunner.query(`DROP TYPE "public"."competitors_scrape_status_enum"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uq_products_sku" ON "products" ("sku") WHERE (sku IS NOT NULL)`);
    }

}
