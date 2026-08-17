import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { DataSource } from 'typeorm';

import { Public } from '../common/decorators/public.decorator';
import { Configuration } from '../config/configuration';
import { HealthResponseDto } from './dto/health-response.dto';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = Date.now();

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService<Configuration, true>,
  ) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Liveness and database readiness probe',
    description:
      'Unauthenticated on purpose so load balancers and uptime monitors can reach it. Returns 503 when the Supabase connection is down.',
  })
  @ApiOkResponse({ description: 'Service and database are healthy.', type: HealthResponseDto })
  @ApiServiceUnavailableResponse({
    description: 'Database unreachable.',
    type: HealthResponseDto,
  })
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthResponseDto> {
    const database = await this.pingDatabase();
    const healthy = database.status === 'up';

    response.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: healthy ? 'ok' : 'error',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      environment: this.configService.get('app', { infer: true }).nodeEnv,
      timestamp: new Date().toISOString(),
      database,
    };
  }

  private async pingDatabase(): Promise<HealthResponseDto['database']> {
    const startedAt = Date.now();

    try {
      if (!this.dataSource.isInitialized) {
        return { status: 'down', latencyMs: null, error: 'DataSource is not initialized' };
      }

      await this.dataSource.query('SELECT 1');
      return { status: 'up', latencyMs: Date.now() - startedAt, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown database error';
      this.logger.error(`Database health check failed: ${message}`);
      return { status: 'down', latencyMs: Date.now() - startedAt, error: message };
    }
  }
}
