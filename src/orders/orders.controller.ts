import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { MailService } from '../billing/mail.service';
import { PurchaseDecisionsService } from '../decisions/purchase-decisions.service';
import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { AuthenticatedRequest } from '../common/guards/api-key.guard';
import { CreateOrderDto, UpdateOrderStatusDto } from './dto/order.dto';
import { Order } from './entities/order.entity';
import { OrdersService } from './orders.service';

/**
 * Ordering, as far as this product goes.
 *
 * The comparison answers "where should I buy this today". Without these
 * endpoints the buyer then copies that answer into an email by hand — the same
 * work the front page promises to give back, moved to the afternoon.
 *
 * What this is *not* is a marketplace. No money moves through here, nothing is
 * reserved, and the email goes out from the buyer with their address in
 * `Reply-To`. Standing between two companies in a commercial transaction is a
 * different business with different liabilities.
 */
@ApiTags('Orders')
@ApiKeyAuth()
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly mail: MailService,
    private readonly decisions: PurchaseDecisionsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Draft an order for one supplier',
    description:
      'Built from the lines you chose, at the prices you were shown, and numbered within your account. Nothing is sent until `POST /orders/:id/send`.\n\nOne supplier per order: a basket split across three warehouses is three orders, because that is three deliveries and three invoices.',
  })
  @ApiOkResponse({ type: Order })
  @ApiNotFoundResponse({ description: 'No such supplier on your list.', type: ErrorResponseDto })
  async create(@Req() request: AuthenticatedRequest, @Body() dto: CreateOrderDto): Promise<Order> {
    const owner = this.owner(request);

    // Checked here rather than trusted from the body. Without this an account
    // could attach its order to somebody else's decision id, and the victim's
    // savings history would start reporting purchases they never made — a
    // write across a tenant boundary through a field that merely looks like a
    // label. `findOne` is owner-scoped and throws, so an id from another
    // account is refused as missing.
    if (dto.purchaseDecisionId) {
      await this.decisions.findOne(owner.id, dto.purchaseDecisionId);
    }

    return this.orders.create(owner, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Your orders, newest first' })
  @ApiOkResponse({ type: Order, isArray: true })
  findAll(@Req() request: AuthenticatedRequest): Promise<Order[]> {
    return this.orders.findAll(this.owner(request).id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One order, with its lines' })
  @ApiOkResponse({ type: Order })
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Order> {
    return this.orders.findOne(this.owner(request).id, id);
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Email the order to the supplier',
    description:
      "Sent from your company, with your address in `Reply-To` — the supplier's answer reaches you, not us. The prices are labelled as read from their own site and asked to be confirmed, because that is what they are.\n\nRequires an order address on the supplier. Without one the order can still be built, printed or copied by hand.",
  })
  @ApiOkResponse({ type: Order })
  @ApiBadRequestResponse({
    description: 'Already sent, or the supplier has no address.',
    type: ErrorResponseDto,
  })
  async send(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Order> {
    const owner = this.owner(request);
    const order = await this.orders.findOne(owner.id, id);

    if (!order.isEditable()) {
      throw new BadRequestException('Тази поръчка вече е изпратена.');
    }

    if (!order.shopEmail) {
      throw new BadRequestException(
        'Доставчикът няма имейл за поръчки. Добавете го в настройките му или изпратете поръчката сами.',
      );
    }

    // Checked before the mail is built, not after: the limit exists to stop
    // this endpoint being used as a mail relay, and a message that was
    // rendered and then thrown away has already cost the work.
    await this.orders.assertWithinDailySendLimit(owner.id);

    const delivered = await this.mail.sendOrderRequest({
      to: order.shopEmail,
      // The buyer, deliberately. An answer that lands in our inbox is a delay
      // and a game of telephone between two companies that can talk directly.
      replyTo: owner.email,
      buyerName: owner.name?.trim() || owner.email,
      orderNumber: order.number,
      currency: order.currency,
      total: order.total,
      note: order.note,
      contact: null,
      lines: order.lines.map((line) => ({
        query: line.query,
        matchedName: line.matchedName,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
    });

    if (!delivered) {
      throw new BadRequestException(
        'Пощата не тръгна. Опитайте пак след малко — поръчката остава запазена.',
      );
    }

    return this.orders.markSent(order);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Mark an order confirmed or cancelled',
    description:
      'The two states this system cannot know for itself — they happen in a phone call or a reply we never see. A status guessed at would be worse than none.',
  })
  @ApiOkResponse({ type: Order })
  async setStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ): Promise<Order> {
    const ownerId = this.owner(request).id;
    const order = await this.orders.setStatus(ownerId, id, dto.status);

    // Confirming an order is the moment a plan becomes a purchase, and
    // cancelling one is the moment it stops being one. Both directions are
    // handled by the same call, which re-reads the evidence rather than
    // adjusting a running total — a total nudged up on confirm and down on
    // cancel drifts the first time a request is retried.
    const decisionId = this.orders.decisionBehind(order);
    if (decisionId) {
      await this.decisions.refreshRealizedSavings(ownerId, decisionId);
    }

    return order;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard a draft',
    description:
      'Drafts only. An order the supplier has already received is a record of something that happened — mark it cancelled instead.',
  })
  @ApiNoContentResponse({ description: 'Gone.' })
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.orders.remove(this.owner(request).id, id);
  }

  /** An operator key authenticates without owning anything to order with. */
  private owner(request: AuthenticatedRequest) {
    const owner = request.user;

    if (!owner) {
      throw new BadRequestException(
        'Това е операторски ключ — той няма акаунт и не може да поръчва. Използвайте клиентски ключ.',
      );
    }

    return owner;
  }
}
