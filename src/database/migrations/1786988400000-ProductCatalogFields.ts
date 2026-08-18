import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catalogue identity for a product: who makes it, what it is called, what it
 * looks like.
 *
 * Until now a product was a name, a SKU and a set of URLs — enough to scrape,
 * not enough to shop with. Brand and manufacturer are separate columns on
 * purpose: they disagree often enough (Redmi/Xiaomi, Specna Arms/Global
 * Airsoft) that folding them into one field loses the distinction a buyer
 * actually negotiates on.
 */
export class ProductCatalogFields1786988400000 implements MigrationInterface {
  name = 'ProductCatalogFields1786988400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "products" ADD "brand" character varying(120)`);
    await queryRunner.query(`ALTER TABLE "products" ADD "manufacturer" character varying(160)`);
    await queryRunner.query(`ALTER TABLE "products" ADD "model" character varying(120)`);
    await queryRunner.query(`ALTER TABLE "products" ADD "category" character varying(120)`);
    await queryRunner.query(`ALTER TABLE "products" ADD "gtin" character varying(14)`);
    await queryRunner.query(`ALTER TABLE "products" ADD "image_url" text`);
    await queryRunner.query(`ALTER TABLE "products" ADD "attributes" jsonb`);
    await queryRunner.query(`ALTER TABLE "products" ADD "notes" text`);
    await queryRunner.query(`CREATE INDEX "idx_products_brand" ON "products" ("brand")`);
    await queryRunner.query(`CREATE INDEX "idx_products_category" ON "products" ("category")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_products_category"`);
    await queryRunner.query(`DROP INDEX "public"."idx_products_brand"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "notes"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "attributes"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "image_url"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "gtin"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "category"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "model"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "manufacturer"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "brand"`);
  }
}
