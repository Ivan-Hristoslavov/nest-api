import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { ClaudeService } from './claude.service';

@ApiTags('Matching')
@Controller('matching')
export class MatchingController {
  constructor(private readonly claude: ClaudeService) {}

  @ApiKeyAuth()
  @UseGuards(AdminGuard)
  @Get('health')
  @ApiOperation({
    summary: 'Is AI matching working? (operator only)',
    description:
      'Authenticates the configured key and reports which model comparisons will use. Spends no tokens. Worth running straight after setting `ANTHROPIC_API_KEY`: with no key — or with the README placeholder copied literally — matching still works on barcodes, article numbers and specifications, and this is what says so out loud instead of leaving it to be inferred.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        model: { type: 'string', nullable: true, example: 'claude-haiku-4-5' },
        ok: { type: 'boolean' },
        detail: { type: 'string' },
      },
    },
  })
  health(): Promise<{ enabled: boolean; model: string | null; ok: boolean; detail: string }> {
    return this.claude.health();
  }
}
