import { Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { ApiPaginatedResponse } from '../common/swagger/api-paginated-response.decorator';
import { AlertsService } from './alerts.service';
import { QueryAlertsDto } from './dto/query-alerts.dto';
import { Alert } from './entities/alert.entity';

@ApiTags('Alerts')
@ApiKeyAuth()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @ApiOperation({
    summary: 'List alerts',
    description:
      'Price movements, undercuts and failing listings, newest first. Filter by product, type, severity or acknowledgement state.',
  })
  @ApiPaginatedResponse(Alert, 'Page of alerts.')
  findAll(@Query() query: QueryAlertsDto): Promise<PaginatedResponseDto<Alert>> {
    return this.alertsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one alert' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'The requested alert.', type: Alert })
  @ApiNotFoundResponse({ description: 'No alert with this id.', type: ErrorResponseDto })
  findOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<Alert> {
    return this.alertsService.findOne(id);
  }

  @Patch(':id/acknowledge')
  @ApiOperation({
    summary: 'Acknowledge an alert',
    description:
      'Marks the alert as handled so it drops out of the unacknowledged queue. Idempotent — the original timestamp is kept.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'The acknowledged alert.', type: Alert })
  @ApiNotFoundResponse({ description: 'No alert with this id.', type: ErrorResponseDto })
  acknowledge(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<Alert> {
    return this.alertsService.acknowledge(id);
  }
}
