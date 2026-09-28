import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { CreateOrderDto, UpsertCartDto } from './orders.dto';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}
  list(buyerId?: string) { return this.prisma.order.findMany({ where: buyerId ? { buyerId } : undefined, include: { items: true }, orderBy: { createdAt: 'desc' } }); }
  async get(id: string) { const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } }); if (!order) throw new NotFoundException('Pedido no encontrado'); return order; }
  async create(dto: CreateOrderDto) {
    if (dto.idempotencyKey) { const previous = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } }); if (previous) return previous; }
    const items = dto.items.map((item) => ({ ...item, subtotal: item.quantity * item.unitPrice }));
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
