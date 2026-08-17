import { config as loadEnv } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';

import { configuration } from '../config/configuration';
import { buildTypeOrmOptions } from './typeorm-options.factory';

// The TypeORM CLI boots outside the Nest DI container, so .env must be loaded
// by hand here. `dotenv` ships as a transitive dependency of @nestjs/config.
loadEnv();

/**
 * DataSource used exclusively by the TypeORM CLI:
 *
 *   npm run migration:generate -- src/database/migrations/AddSomething
 *   npm run migration:run
 *   npm run migration:revert
 *
 * `synchronize` is forced off here — schema changes must go through migrations,
 * never through the CLI implicitly rewriting production tables.
 */
export const dataSourceOptions: DataSourceOptions = {
  ...buildTypeOrmOptions(configuration().database),
  synchronize: false,
} as DataSourceOptions;

export default new DataSource(dataSourceOptions);
