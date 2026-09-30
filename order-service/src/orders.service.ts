import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { CreateOrderDto, UpsertCartDto } from './orders.dto';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}
  list(buyerId?: string) { return this.prisma.order.findMany({ where: buyerId ? { buyerId } : undefined, include: { items: true }, orderBy: { createdAt: 'desc' } }); }
  async get(id: string) { const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } }); if (!order) throw new NotFoundException('Pedido no encontrado'); return order; }
  async create(dto: CreateOrderDto, buyerId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string) {
    if (dto.buyerId !== buyerId) throw new ForbiddenException('El comprador no coincide con el token');
    const inventoryUrl = (process.env.INVENTORY_SERVICE_URL ?? 'http://localhost:3004').replace(/\/+$/, '');
    const reservations: Array<{ reservationId: string; productId: string; quantity: number; unitPrice: number; priceVersionId?: string }> = [];
    for (const item of dto.items) {
      const response = await fetch(`${inventoryUrl}/inventory/reservations`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, ...(gatewayUserId ? { 'x-gateway-user-id': gatewayUserId, 'x-gateway-user-roles': gatewayRoles ?? '' } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ product_id: item.productId, quantity_kg: item.quantity }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) { for (const reserved of reservations) await fetch(`${inventoryUrl}/inventory/reservations/${reserved.reservationId}/release`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` } }).catch(() => undefined); throw new Error(`No se pudo reservar inventario para ${item.productId}`); }
      const body = await response.json() as { reservation?: { id: string } };
      if (!body.reservation?.id) throw new Error('Inventario no devolvio la reserva');
      reservations.push({ reservationId: body.reservation.id, productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice, priceVersionId: item.priceVersionId });
    }
    if (dto.idempotencyKey) { const previous = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } }); if (previous) return previous; }
    const items = reservations.map((item) => ({ ...item, subtotal: item.quantity * item.unitPrice }));
    const totalAmount = items.reduce((sum, item) => sum + item.subtotal, 0);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({ data: { buyerId: dto.buyerId, deliveryAddress: dto.deliveryAddress, currency: dto.currency ?? 'COP', totalAmount, idempotencyKey: dto.idempotencyKey, items: { create: items } }, include: { items: true } });
      await tx.outboxEvent.create({ data: { eventType: 'order.created', aggregateId: order.id, payload: order as any } });
      return order;
    });
  }
  async updateStatus(id: string, status: OrderStatus) { await this.get(id); return this.prisma.order.update({ where: { id }, data: { status }, include: { items: true } }); }
  getCart(buyerId: string) { return this.prisma.cart.findUnique({ where: { buyerId }, include: { items: true } }); }
  upsertCart(buyerId: string, dto: UpsertCartDto) { return this.prisma.cart.upsert({ where: { buyerId }, create: { buyerId, items: { create: dto.items } }, update: { items: { deleteMany: {}, create: dto.items } }, include: { items: true } }); }
  clearCart(buyerId: string) { return this.prisma.cart.update({ where: { buyerId }, data: { items: { deleteMany: {} } }, include: { items: true } }); }
}
