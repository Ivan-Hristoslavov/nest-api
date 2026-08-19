import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sign-in links and browser sessions.
 *
 * Until now the only credential was the API key, which meant a customer who
 * closed the tab had to find the email it arrived in. A key is a machine
 * credential and a person is not a machine: these give a browser something it
 * can be handed again tomorrow without rotating the key a customer's scripts
 * depend on.
 */
export class AuthTokens1787300000000 implements MigrationInterface {
  name = 'AuthTokens1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "token_hash" character(64) NOT NULL,
        "kind" character varying(20) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        "user_agent" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "pk_auth_tokens" PRIMARY KEY ("id"),
        -- Erasing an account takes its sessions with it, or a deleted customer
        -- would keep a working browser session.
        CONSTRAINT "fk_auth_tokens_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_tokens_hash" ON "auth_tokens" ("token_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_auth_tokens_user" ON "auth_tokens" ("user_id")`,
    );
    // Sweeping expired rows scans by expiry.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_auth_tokens_expiry" ON "auth_tokens" ("expires_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_tokens"`);
  }
}
