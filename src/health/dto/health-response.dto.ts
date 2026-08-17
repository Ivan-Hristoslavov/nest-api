import { ApiProperty } from '@nestjs/swagger';

export class DatabaseHealthDto {
  @ApiProperty({ description: 'Connection state.', enum: ['up', 'down'], example: 'up' })
  status!: 'up' | 'down';

  @ApiProperty({
    description: 'Round-trip time of a `SELECT 1` against Supabase, in milliseconds.',
    nullable: true,
    example: 34,
  })
  latencyMs!: number | null;

  @ApiProperty({
    description: 'Error message when the check failed.',
    nullable: true,
    example: null,
  })
  error!: string | null;
}

export class HealthResponseDto {
  @ApiProperty({ description: 'Overall status.', enum: ['ok', 'error'], example: 'ok' })
  status!: 'ok' | 'error';

  @ApiProperty({ description: 'Process uptime in seconds.', example: 1284 })
  uptimeSeconds!: number;

  @ApiProperty({ description: 'Active NODE_ENV.', example: 'development' })
  environment!: string;

  @ApiProperty({ description: 'Server time (ISO-8601).', format: 'date-time' })
  timestamp!: string;

  @ApiProperty({ description: 'Database probe result.', type: DatabaseHealthDto })
  database!: DatabaseHealthDto;
}
