import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShopSearchConfig1787038895354 implements MigrationInterface {
  name = 'ShopSearchConfig1787038895354';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "offers" DROP CONSTRAINT "fk_offers_shop"`);
    await queryRunner.query(`DROP INDEX "public"."idx_offers_gtin"`);
    await queryRunner.query(`ALTER TABLE "shops" ADD "search_url_template" text`);
    await queryRunner.query(
      `ALTER TABLE "shops" ADD "search_result_selector" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "shops" ADD "search_price_selector" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "shops" ADD "search_blocked_reason" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "offers" ADD CONSTRAINT "FK_7b24bcb9a291c85b7469906b254" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "offers" DROP CONSTRAINT "FK_7b24bcb9a291c85b7469906b254"`,
    );
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN "search_blocked_reason"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN "search_price_selector"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN "search_result_selector"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN "search_url_template"`);
    await queryRunner.query(
      `CREATE INDEX "idx_offers_gtin" ON "offers" ("gtin") WHERE (gtin IS NOT NULL)`,
    );
    await queryRunner.query(
      `ALTER TABLE "offers" ADD CONSTRAINT "fk_offers_shop" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
