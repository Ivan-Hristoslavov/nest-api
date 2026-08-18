import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes catalogue search survive mixed alphabets.
 *
 * Bulgarian shops write model codes with whichever letter is under the finger:
 * TMT lists "ЛАМПА LED 7W,Е27" with a *Cyrillic* Е, while every buyer types
 * "E27" on a Latin layout. Those are different code points, so the search
 * returned nothing — measured, not guessed: `е27` matched 40 rows and `e27`
 * matched none.
 *
 * `translate()` folds the twelve Cyrillic letters that have Latin lookalikes
 * onto their twins, on both the indexed text and the query. Real words get
 * mangled too ("крушка" becomes "kpyшka"), which does not matter: both sides
 * are mangled identically, and the untouched `name` column is what is
 * displayed. This is a search key, not text.
 */
export class OfferSearchHomoglyphs1787060000000 implements MigrationInterface {
  name = 'OfferSearchHomoglyphs1787060000000';

  /** Kept in one place so the query cannot drift from the index. */
  static readonly EXPRESSION = `to_tsvector('simple', translate(lower(coalesce("name", '') || ' ' || coalesce("shop_code", '')), 'аеорсухкмтвн', 'aeopcyxkmtbh'))`;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_offers_search"`);
    await queryRunner.query(
      `CREATE INDEX "idx_offers_search" ON "offers" USING GIN (${OfferSearchHomoglyphs1787060000000.EXPRESSION})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_offers_search"`);
    await queryRunner.query(`
      CREATE INDEX "idx_offers_search" ON "offers"
      USING GIN (to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("shop_code", '')))
    `);
  }
}
