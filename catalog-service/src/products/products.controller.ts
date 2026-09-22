import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CorrelationId } from '../common/correlation.decorator';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { AuthUser } from '../common/auth/jwt-auth.guard';
import { PricesService } from '../prices/prices.service';
import { CreateProductDto } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly prices: PricesService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateProductDto, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.products.create(dto, user, cid);
  }

  @Get()
  findAll(@Query() query: QueryProductsDto) {
    return this.products.findAll(query);
  }

  /** Debe declararse antes de :id para que "available" no se lea como UUID. */
  @Get('available')
  findAvailable(@Query() query: QueryProductsDto) {
    return this.products.findAvailable(query);
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.products.findOne(id);
  }

  @Get(':id/price')
  async currentPrice(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.products.getOrThrow(id);
    return this.prices.getCurrent(id);
  }

  @Get(':id/prices')
  async priceHistory(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.products.getOrThrow(id);
    return this.prices.getHistory(id);
  }

  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateProductDto, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.products.update(id, dto, user, cid);
  }

  @Patch(':id/enable')
  enable(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.products.enable(id, user, cid);
  }

  @Patch(':id/disable')
  disable(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.products.disable(id, user, cid);
  }
}
