import { Injectable, NotFoundException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { CreatePaymentDto } from './payment.dto';
@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}
  list(buyerId?: string) { return this.prisma.payment.findMany({ where: buyerId ? { buyerId } : undefined, orderBy: { createdAt: 'desc' } }); }
  async get(id: string) { const payment = await this.prisma.payment.findUnique({ where: { id } }); if (!payment) throw new NotFoundException('Pago no encontrado'); return payment; }
  async create(dto: CreatePaymentDto) {
    if (dto.idempotencyKey) { const old = await this.prisma.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } }); if (old) return old; }
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({ data: { orderId: dto.orderId, buyerId: dto.buyerId, amount: dto.amount, currency: dto.currency ?? 'COP', provider: dto.provider ?? 'demo', idempotencyKey: dto.idempotencyKey } });
      await tx.outboxEvent.create({ data: { eventType: 'payment.pending', aggregateId: payment.id, payload: { paymentId: payment.id, orderId: payment.orderId, amount: payment.amount.toString(), currency: payment.currency } } });
      return payment;
    });
  }
  async authorize(id: string) { const payment = await this.get(id); if (payment.status === PaymentStatus.authorized) return payment; return this.prisma.$transaction(async (tx) => { const updated = await tx.payment.update({ where: { id }, data: { status: PaymentStatus.authorized, providerReference: `demo_${id}` } }); await tx.outboxEvent.create({ data: { eventType: 'payment.authorized', aggregateId: id, payload: { paymentId: id, orderId: updated.orderId, amount: updated.amount.toString() } } }); return updated; }); }
  async fail(id: string, reason?: string) { await this.get(id); return this.prisma.payment.update({ where: { id }, data: { status: PaymentStatus.failed, failureReason: reason ?? 'Pago rechazado' } }); }
  async refund(id: string) { const payment = await this.get(id); if (payment.status !== PaymentStatus.authorized) throw new Error('Solo se puede reembolsar un pago autorizado'); return this.prisma.payment.update({ where: { id }, data: { status: PaymentStatus.refunded } }); }
}
