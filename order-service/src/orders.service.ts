import { BadGatewayException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { CreateOrderDto, UpsertCartDto } from './orders.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(private readonly prisma: PrismaService) {}
  list(buyerId?: string) { return this.prisma.order.findMany({ where: buyerId ? { buyerId } : undefined, include: { items: true }, orderBy: { createdAt: 'desc' } }); }
  async get(id: string) { const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } }); if (!order) throw new NotFoundException('Pedido no encontrado'); return order; }
  async create(dto: CreateOrderDto, buyerId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string) {
    if (dto.buyerId !== buyerId) throw new ForbiddenException('El comprador no coincide con el token');
    const inventoryUrl = (process.env.INVENTORY_SERVICE_URL ?? 'http://localhost:3004').replace(/\/+$/, '');
    if (dto.idempotencyKey) { const previous = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } }); if (previous) return previous; }
    const resolved = await this.resolveItems(dto, bearer, gatewayUserId, gatewayRoles);
    const reservations: Array<{ reservationId: string; productId: string; quantity: number; unitPrice: number; priceVersionId?: string; productName: string }> = [];
    for (const item of resolved) {
      const response = await fetch(`${inventoryUrl}/inventory/reservations`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, ...(gatewayUserId ? { 'x-gateway-user-id': gatewayUserId, 'x-gateway-user-roles': gatewayRoles ?? '' } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ product_id: item.productId, quantity_kg: item.quantity }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) { void this.release(reservations, bearer, gatewayUserId, gatewayRoles); throw new ConflictException(`No se pudo reservar inventario para ${item.productId}`); }
      const body = await response.json() as { reservation?: { id: string } };
      if (!body.reservation?.id) throw new Error('Inventario no devolvio la reserva');
      reservations.push({ reservationId: body.reservation.id, productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice, priceVersionId: item.priceVersionId, productName: item.productName });
    }
    const items = reservations.map((item) => ({ ...item, subtotal: item.quantity * item.unitPrice }));
    const totalAmount = items.reduce((sum, item) => sum + item.subtotal, 0);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({ data: { buyerId: dto.buyerId, deliveryAddress: dto.deliveryAddress, currency: dto.currency ?? 'COP', totalAmount, idempotencyKey: dto.idempotencyKey, items: { create: items } }, include: { items: true } });
      await tx.outboxEvent.create({ data: { eventType: 'order.created', aggregateId: order.id, payload: order as any } });
      return order;
    });
  }
  async checkout(dto: CreateOrderDto, buyerId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string) {
    this.logger.log(`checkout_started buyer=${buyerId} key=${dto.idempotencyKey ?? 'none'}`);
    let order = dto.idempotencyKey
      ? await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } })
      : null;
    if (order?.buyerId !== undefined && order.buyerId !== buyerId) throw new ForbiddenException('El comprador no coincide con el pedido');
    if (order?.status === OrderStatus.confirmed) {
      this.logger.log(`checkout_replayed_confirmed order=${order.id}`);
      return { order, replayed: true };
    }
    if (!order) {
      order = await this.create(dto, buyerId, bearer, gatewayUserId, gatewayRoles);
      this.logger.log(`checkout_order_created order=${order.id}`);
    } else {
      this.logger.warn(`checkout_resuming_pending order=${order.id}`);
    }
    const paymentUrl = (process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3006').replace(/\/+$/, '');
    const headers = this.headers(bearer, gatewayUserId, gatewayRoles);
    try {
      const paymentResponse = await fetch(`${paymentUrl}/api/v1/payments`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ orderId: order.id, buyerId, amount: Number(order.totalAmount), currency: order.currency, idempotencyKey: dto.idempotencyKey ? `payment:${dto.idempotencyKey}` : undefined }), signal: AbortSignal.timeout(6000) });
      if (!paymentResponse.ok) throw new Error(await paymentResponse.text());
      const payment = await paymentResponse.json();
      this.logger.log(`checkout_payment_authorized order=${order.id} payment=${String(payment?.id ?? 'unknown')}`);
      const reservations = order.items.map((item) => ({ reservationId: item.reservationId!, productId: item.productId, quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) }));
      await this.consume(reservations, bearer, gatewayUserId, gatewayRoles);
      this.logger.log(`checkout_inventory_consumed order=${order.id}`);
      const confirmed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.confirmed, paymentStatus: PaymentStatus.authorized }, include: { items: true } });
        const cart = await tx.cart.findUnique({ where: { buyerId } });
        if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await tx.outboxEvent.create({ data: { eventType: 'order.confirmed', aggregateId: updated.id, payload: { orderId: updated.id, paymentId: payment.id } } });
        return updated;
      });
      this.logger.log(`checkout_confirmed order=${confirmed.id}`);
      return { order: confirmed, payment };
    } catch (error) {
      this.logger.error(`checkout_failed order=${order.id} reason=${(error as Error).message}`);
      void this.release(order.items.filter((item) => item.reservationId).map((item) => ({ reservationId: item.reservationId! })), bearer, gatewayUserId, gatewayRoles);
      throw new BadGatewayException(`No se pudo completar el pago: ${(error as Error).message}`);
    }
  }
  async updateStatus(id: string, status: OrderStatus) { await this.get(id); return this.prisma.order.update({ where: { id }, data: { status }, include: { items: true } }); }
  getCart(buyerId: string) { return this.prisma.cart.findUnique({ where: { buyerId }, include: { items: true } }); }
  upsertCart(buyerId: string, dto: UpsertCartDto) { return this.prisma.cart.upsert({ where: { buyerId }, create: { buyerId, items: { create: dto.items } }, update: { items: { deleteMany: {}, create: dto.items } }, include: { items: true } }); }
  clearCart(buyerId: string) { return this.prisma.cart.update({ where: { buyerId }, data: { items: { deleteMany: {} } }, include: { items: true } }); }
  private headers(bearer: string, gatewayUserId?: string, gatewayRoles?: string) { return { authorization: `Bearer ${bearer}`, ...(gatewayUserId ? { 'x-gateway-user-id': gatewayUserId, 'x-gateway-user-roles': gatewayRoles ?? '' } : {}) }; }
  private async release(items: Array<{ reservationId: string }>, bearer: string, gatewayUserId?: string, gatewayRoles?: string) { const url = (process.env.INVENTORY_SERVICE_URL ?? 'http://localhost:3004').replace(/\/+$/, ''); await Promise.allSettled(items.map((item) => fetch(`${url}/inventory/reservations/${item.reservationId}/release`, { method: 'POST', headers: this.headers(bearer, gatewayUserId, gatewayRoles), signal: AbortSignal.timeout(4000) }))); }
  private async consume(items: Array<{ reservationId: string }>, bearer: string, gatewayUserId?: string, gatewayRoles?: string) { const url = (process.env.INVENTORY_SERVICE_URL ?? 'http://localhost:3004').replace(/\/+$/, ''); for (const item of items) { const r = await fetch(`${url}/inventory/reservations/${item.reservationId}/consume`, { method: 'POST', headers: this.headers(bearer, gatewayUserId, gatewayRoles), signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new BadGatewayException('No se pudo confirmar la salida de inventario'); } }
  private async resolveItems(dto: CreateOrderDto, bearer: string, gatewayUserId?: string, gatewayRoles?: string) {
    const catalogUrl = (process.env.CATALOG_SERVICE_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
    return Promise.all(dto.items.map(async (item) => { const r = await fetch(`${catalogUrl}/products/${item.productId}`, { headers: this.headers(bearer, gatewayUserId, gatewayRoles), signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new BadGatewayException('No se pudo validar el producto y su precio'); const product = await r.json() as { active: boolean; price: number | null; price_version_id: string | null; name: string; min_order_quantity: number }; if (!product.active || product.price === null) throw new ConflictException('El producto ya no está disponible'); if (item.quantity < Number(product.min_order_quantity)) throw new ConflictException(`La cantidad mínima para ${product.name} no se cumple`); return { productId: item.productId, quantity: item.quantity, unitPrice: Number(product.price), priceVersionId: product.price_version_id ?? undefined, productName: product.name }; }));
  }
}
