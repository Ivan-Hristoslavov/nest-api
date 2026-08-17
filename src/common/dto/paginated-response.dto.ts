import { ApiProperty } from '@nestjs/swagger';

export class PaginationMetaDto {
  @ApiProperty({ description: 'Total number of items matching the filter.', example: 137 })
  total!: number;

  @ApiProperty({ description: 'Page size used for this response.', example: 20 })
  limit!: number;

  @ApiProperty({ description: 'Number of items skipped.', example: 0 })
  offset!: number;

  @ApiProperty({ description: 'Whether more items exist after this page.', example: true })
  hasMore!: boolean;
}

/**
 * Generic page envelope. Swagger cannot infer generics, so controllers pair
 * this with {@link import('../swagger/api-paginated-response.decorator').ApiPaginatedResponse}
 * to produce a correctly typed `data` array in the OpenAPI schema.
 */
export class PaginatedResponseDto<T> {
  @ApiProperty({ description: 'Items in the current page.', isArray: true })
  data!: T[];

  @ApiProperty({ description: 'Pagination metadata.', type: PaginationMetaDto })
  meta!: PaginationMetaDto;

  constructor(data: T[], total: number, limit: number, offset: number) {
    this.data = data;
    this.meta = {
      total,
      limit,
      offset,
      hasMore: offset + data.length < total,
    };
  }
}
