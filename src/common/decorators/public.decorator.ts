import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a controller or a single route out of the globally registered
 * {@link import('../guards/api-key.guard').ApiKeyGuard}.
 * Use sparingly — health checks and the docs endpoint only.
 */
export const Public = (): CustomDecorator<string> => SetMetadata(IS_PUBLIC_KEY, true);
