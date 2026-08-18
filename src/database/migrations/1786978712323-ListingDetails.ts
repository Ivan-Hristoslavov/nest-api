import { MigrationInterface, QueryRunner } from 'typeorm';

export class ListingDetails1786978712323 implements MigrationInterface {
  name = 'ListingDetails1786978712323';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "competitors" ADD "seller_name" character varying(160)`);
    await queryRunner.query(`ALTER TABLE "competitors" ADD "location" character varying(255)`);
    await queryRunner.query(`ALTER TABLE "competitors" ADD "image_url" text`);
    await queryRunner.query(`ALTER TABLE "competitors" ADD "attributes" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "competitors" DROP COLUMN "attributes"`);
    await queryRunner.query(`ALTER TABLE "competitors" DROP COLUMN "image_url"`);
    await queryRunner.query(`ALTER TABLE "competitors" DROP COLUMN "location"`);
    await queryRunner.query(`ALTER TABLE "competitors" DROP COLUMN "seller_name"`);
  }
}
