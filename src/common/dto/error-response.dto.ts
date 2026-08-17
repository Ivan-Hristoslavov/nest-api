import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ description: 'HTTP status code.', example: 400 })
  statusCode!: number;

  @ApiProperty({
    description: 'Human readable message, or a list of validation failures.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['name should not be empty', 'competitorUrl must be a URL address'],
  })
  message!: string | string[];

  @ApiProperty({ description: 'Short error identifier.', example: 'Bad Request' })
  error!: string;

  @ApiProperty({
    description: 'Request path that produced the error.',
    example: '/api/v1/products',
  })
  path!: string;

  @ApiProperty({
    description: 'Server time when the error was produced (ISO-8601).',
    example: '2026-08-17T09:31:44.512Z',
  })
  timestamp!: string;
}
