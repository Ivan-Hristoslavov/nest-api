import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiSecurity, ApiUnauthorizedResponse } from '@nestjs/swagger';

import { ErrorResponseDto } from '../dto/error-response.dto';

export const API_KEY_SECURITY_SCHEME = 'api-key';

/**
 * Documents the API-key requirement on a controller or route in one place:
 * the security scheme (so Swagger UI's "Authorize" button injects the header),
 * an explicit `X-API-KEY` header entry, and the 401 response shape.
 */
export const ApiKeyAuth = () =>
  applyDecorators(
    ApiSecurity(API_KEY_SECURITY_SCHEME),
    ApiHeader({
      name: 'X-API-KEY',
      description:
        'Shared secret that authenticates the client. Supplied by the **Authorize** button — leave this field empty.',
      // Documented, not required: the security scheme above already injects the
      // header. Marking it required too renders a second, mandatory input on
      // every operation that the user must fill in by hand before Swagger UI
      // will send anything.
      required: false,
      schema: { type: 'string' },
    }),
    ApiUnauthorizedResponse({
      description: 'API key missing or invalid.',
      type: ErrorResponseDto,
    }),
  );
