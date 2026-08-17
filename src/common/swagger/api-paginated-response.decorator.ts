import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

import { PaginatedResponseDto, PaginationMetaDto } from '../dto/paginated-response.dto';

/**
 * Produces an OpenAPI schema for `PaginatedResponseDto<TModel>`, which the
 * plain `@ApiOkResponse({ type: ... })` form cannot express because generics
 * are erased at runtime.
 */
export const ApiPaginatedResponse = <TModel extends Type<unknown>>(
  model: TModel,
  description = 'Paginated result set.',
) =>
  applyDecorators(
    ApiExtraModels(PaginatedResponseDto, PaginationMetaDto, model),
    ApiOkResponse({
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(PaginatedResponseDto) },
          {
            properties: {
              data: {
                type: 'array',
                items: { $ref: getSchemaPath(model) },
              },
              meta: { $ref: getSchemaPath(PaginationMetaDto) },
            },
          },
        ],
      },
    }),
  );
