import {
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
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

import { ApiKeyAuth } from '../common/decorators/api-key-auth.decorator';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { CreateShopDto, UpdateShopDto } from './dto/shops.dto';
import { Shop } from './entities/shop.entity';
import { ShopsService } from './shops.service';

@ApiTags('Shops')
@ApiKeyAuth()
@Controller('shops')
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  @Get()
  @ApiOperation({
    summary: 'Your suppliers',
    description:
      'Who you buy from, what discount you have negotiated with each, and whether their search can be queried live.',
  })
  @ApiOkResponse({ type: Shop, isArray: true })
  list(): Promise<Shop[]> {
    return this.shops.findAll();
  }

  @Post()
  @ApiOperation({
    summary: 'Add a supplier',
    description:
      'Registers the shop. It joins the live search as soon as it has a search URL template — use `POST /discovery/detect` to work one out from an example search, then save it here or with `PATCH`.',
  })
  @ApiCreatedResponse({ type: Shop })
  @ApiBadRequestResponse({ description: 'Validation failed.', type: ErrorResponseDto })
  create(@Body() dto: CreateShopDto): Promise<Shop> {
    return this.shops.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a supplier',
    description:
      'Chiefly for the discount — it decides which shop the comparison calls cheapest — and for the search configuration.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: Shop })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateShopDto,
  ): Promise<Shop> {
    return this.shops.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a supplier' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse({ description: 'Shop deleted.' })
  @ApiNotFoundResponse({ description: 'No shop with this id.', type: ErrorResponseDto })
  remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<void> {
    return this.shops.remove(id);
  }
}
