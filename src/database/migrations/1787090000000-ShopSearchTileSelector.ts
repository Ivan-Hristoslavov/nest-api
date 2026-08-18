import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores the tile selector the detector works out.
 *
 * Without it, only the link and price selectors were saved, and the search
 * fell back to a generic list of tile candidates. `closest()` stops at the
 * *nearest* match, so a generic `[class*="item"]` settled on an inner wrapper
 * holding the link but not the price — and homefinishing.bg, whose prices are
 * plainly on the page, returned offers with no price at all.
 */
export class ShopSearchTileSelector1787090000000 implements MigrationInterface {
  name = 'ShopSearchTileSelector1787090000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "search_tile_selector" character varying(255)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shops" DROP COLUMN IF EXISTS "search_tile_selector"`);
  }
}
