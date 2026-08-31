import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { Owner } from '../common/decorators/owner.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { Order } from '../orders/entities/order.entity';
import {
  CreatePurchaseDecisionDto,
  DecisionPageDto,
  ListPurchaseDecisionsDto,
  SavingsSummaryDto,
} from './dto/purchase-decision.dto';
import { PurchaseDecision } from './entities/purchase-decision.entity';
import { PurchaseDecisionsService } from './purchase-decisions.service';

/**
 * The record of what was decided, and why.
 *
 * Every route here is scoped to the calling account by `@Owner`, which refuses
 * an operator key outright. That is not belt-and-braces: a purchase decision
 * contains a customer's negotiated discounts, their suppliers' terms and what
 * they buy, and an unscoped query over this table would publish one customer's
 * entire purchasing position to anyone else holding a key.
 */
@ApiTags('Purchase decisions')
@ApiKeyAuth()
@Controller('purchase-decisions')
export class PurchaseDecisionsController {
  constructor(private readonly decisions: PurchaseDecisionsService) {}

  @Post()
  @ApiOperation({
    summary: 'Keep this plan, with the evidence behind it',
    description:
      'Turns the comparison you were just shown into a permanent record: the supplier terms, the prices and where each was read, the match and what decided it, the plan and every alternative it beat.\n\n**Post back the `decision` object from `POST /discovery/basket` unchanged.** Nothing is recalculated — no supplier is asked again, no model is called, and the optimiser does not run a second time, so what is stored is exactly what you saw. The signature is what makes that safe: an edited figure is refused rather than saved.\n\nDecisions are created when you choose a plan, not on every comparison. Pricing an order to see what it would cost writes nothing.',
  })
  @ApiCreatedResponse({ type: PurchaseDecision })
  @ApiBadRequestResponse({
    description: 'The draft was altered, or the comparison is more than an hour old.',
    type: ErrorResponseDto,
  })
  create(
    @Owner() ownerId: string,
    @Body() dto: CreatePurchaseDecisionDto,
  ): Promise<PurchaseDecision> {
    return this.decisions.create(ownerId, { snapshot: dto.snapshot, signature: dto.signature });
  }

  @Get()
  @ApiOperation({
    summary: 'Your decisions',
    description:
      'Newest first by default. `sort=savings` orders by what each one saved — decisions with no single-supplier baseline have no saving to sort by and come last in either direction.\n\n`shopId` narrows to decisions a supplier took part in, whether they won the order, lost it or were refused for being under their minimum.',
  })
  @ApiOkResponse({ type: DecisionPageDto })
  list(
    @Owner() ownerId: string,
    @Query() query: ListPurchaseDecisionsDto,
  ): Promise<DecisionPageDto> {
    return this.decisions.list(ownerId, query);
  }

  @Get('summary')
  @ApiOperation({
    summary: 'What this has saved you',
    description:
      'Potential and realized are reported separately and never added together.\n\n**Potential** is what the optimiser says was avoidable on a plan you chose. **Realized** is what was saved on a purchase you confirmed happened — every supplier in the plan ordered from, and every one of those orders marked confirmed. A decision counts towards one or the other, never both, so the same saving is never claimed twice.',
  })
  @ApiOkResponse({ type: SavingsSummaryDto })
  summary(@Owner() ownerId: string): Promise<SavingsSummaryDto> {
    return this.decisions.summary(ownerId);
  }

  /*
   * Declared after `summary` deliberately.
   *
   * Nest matches routes in declaration order, and `:id` would otherwise
   * swallow `/summary` — then reject it at `ParseUUIDPipe` with a message
   * about a malformed identifier, for a path that is not an identifier at all.
   */
  @Get(':id')
  @ApiOperation({
    summary: 'One decision, whole',
    description:
      'Everything the interface needs for "how was this calculated?": the request, each supplier’s terms as they stood, every line with the price it was given and where that price was read, the match and what decided it, the chosen plan, the baseline it beat and the alternatives it was chosen over.\n\nThe figures are the ones from the day it was made. A supplier who has since changed their discount, or an article whose price has moved, does not change a word of it.',
  })
  @ApiOkResponse({ type: PurchaseDecision })
  @ApiNotFoundResponse({ description: 'No such decision on your account.', type: ErrorResponseDto })
  findOne(
    @Owner() ownerId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PurchaseDecision> {
    return this.decisions.findOne(ownerId, id);
  }

  @Get(':id/orders')
  @ApiOperation({
    summary: 'Orders placed on this decision',
    description:
      'What the plan actually became. Once every supplier in the plan has a confirmed order here, the decision’s saving is reported as realized rather than potential.',
  })
  @ApiOkResponse({ type: Order, isArray: true })
  orders(@Owner() ownerId: string, @Param('id', ParseUUIDPipe) id: string): Promise<Order[]> {
    return this.decisions.ordersFor(ownerId, id);
  }
}
