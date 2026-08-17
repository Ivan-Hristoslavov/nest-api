import { ApiProperty } from '@nestjs/swagger';

/**
 * What the payment provider gets back.
 *
 * Deliberately minimal: never echo the customer's data, and never the issued
 * API key. The provider only needs to know the delivery succeeded.
 */
export class WebhookResponseDto {
  @ApiProperty({ description: 'Always true once the signature verified.', example: true })
  received!: true;

  @ApiProperty({ description: 'Whether the event changed account state.', example: true })
  processed!: boolean;

  @ApiProperty({
    description: 'Whether this event id had already been handled.',
    example: false,
  })
  duplicate!: boolean;

  @ApiProperty({
    description: 'Short explanation, useful in the provider dashboard.',
    example: 'Account activated, API key issued',
  })
  note!: string;
}
