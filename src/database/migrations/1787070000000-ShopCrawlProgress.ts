import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * How far the indexing of a shop has got.
 *
 * "115 артикула" answers nothing on its own — out of how many? A catalogue of
 * seven and a half thousand pages takes hours to read at a polite rate, so the
 * dashboard has to be able to say "115 of 7548, still going" rather than
 * leaving someone to conclude the supplier only sells lamps.
 */
export class ShopCrawlProgress1787070000000 implements MigrationInterface {
  name = 'ShopCrawlProgress1787070000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shops" ADD "catalogue_pages" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "shops" ADD "pages_seen" integer NOT NULL DEFAULT 0`);

    // Existing shops already have rows in `offers` for everything read so far,
    // priced or not; counting them is more honest than starting from zero.
    await queryRunner.query(`
      UPDATE "shops" SET "pages_seen" = (
        SELECT COUNT(*) FROM "offers" WHERE "offers"."shop_id" = "shops"."id"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN "pages_seen"`);
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN "catalogue_pages"`);
  }
}
