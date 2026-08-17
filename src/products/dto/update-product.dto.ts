import { PartialType } from '@nestjs/swagger';

import { CreateProductDto } from './create-product.dto';

/**
 * Every field of {@link CreateProductDto}, all optional.
 * `PartialType` from `@nestjs/swagger` (not `@nestjs/mapped-types`) so the
 * inherited `@ApiProperty` metadata is carried over into the OpenAPI schema.
 */
export class UpdateProductDto extends PartialType(CreateProductDto) {}
