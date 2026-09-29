import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { CreatePaymentDto, TopUpWalletDto } from './payment.dto';
@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}
  list(buyerId?: string) { return this.prisma.payment.findMany({ where: buyerId ? { buyerId } : undefined, orderBy: { createdAt: 'desc' } }); }
  async get(id: string) { const payment = await this.prisma.payment.findUnique({ where: { id } }); if (!payment) throw new NotFoundException('Pago no encontrado'); return payment; }
  wallet(buyerId: string) { return this.prisma.wallet.findUnique({ where: { buyerId }, include: { transactions: { orderBy: { createdAt: 'desc' }, take: 50 } } }); }
  async topUp(buyerId: string, dto: TopUpWalletDto, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) { const old = await tx.walletTransaction.findUnique({ where: { idempotencyKey: dto.idempotencyKey } }); if (old) return tx.wallet.findUnique({ where: { buyerId }, include: { transactions: true } }); }
      const wallet = await tx.wallet.upsert({ where: { buyerId }, create: { buyerId }, update: {} });
      const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: dto.amount }, version: { increment: 1 } } });
      await tx.walletTransaction.create({ data: { walletId: wallet.id, type: 'credit', amount: dto.amount, balanceAfter: updated.balance, reason: dto.reason, actorId, idempotencyKey: dto.idempotencyKey } });
      return updated;
    });
  }
  async create(dto: CreatePaymentDto, authenticatedBuyerId?: string) {
    if (authenticatedBuyerId && dto.buyerId !== authenticatedBuyerId) throw new ForbiddenException('El comprador no coincide con el token');
    if (dto.idempotencyKey) { const old = await this.prisma.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } }); if (old) return old; }
    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { buyerId: dto.buyerId } });
      if (!wallet) throw new BadRequestException('El comprador no tiene una billetera');
      const changed = await tx.wallet.updateMany({ where: { id: wallet.id, balance: { gte: dto.amount } }, data: { balance: { decrement: dto.amount }, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('Saldo insuficiente');
      const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      const payment = await tx.payment.create({ data: { orderId: dto.orderId, buyerId: dto.buyerId, amount: dto.amount, currency: dto.currency ?? 'COP', status: 'authorized', idempotencyKey: dto.idempotencyKey } });
      await tx.walletTransaction.create({ data: { walletId: wallet.id, type: 'debit', amount: dto.amount, balanceAfter: updatedWallet.balance, reason: `Pago del pedido ${dto.orderId}`, paymentId: payment.id, idempotencyKey: dto.idempotencyKey ? `debit:${dto.idempotencyKey}` : undefined } });
      await tx.outboxEvent.create({ data: { eventType: 'payment.authorized', aggregateId: payment.id, payload: { paymentId: payment.id, orderId: payment.orderId, amount: payment.amount.toString(), currency: payment.currency } } });
      return payment;
    });
  }
  async authorize(id: string) { const payment = await this.get(id); if (payment.status !== PaymentStatus.authorized) throw new ConflictException('El pago no fue autorizado'); return payment; }
  async fail(id: string, reason?: string) { await this.get(id); return this.prisma.payment.update({ where: { id }, data: { status: PaymentStatus.failed, failureReason: reason ?? 'Pago rechazado' } }); }
  async refund(id: string) { const payment = await this.get(id); if (payment.status !== PaymentStatus.authorized) throw new ConflictException('Solo se puede reembolsar un pago autorizado'); return this.prisma.$transaction(async (tx) => { const wallet = await tx.wallet.findUniqueOrThrow({ where: { buyerId: payment.buyerId } }); const updatedWallet = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: payment.amount }, version: { increment: 1 } } }); const updated = await tx.payment.update({ where: { id }, data: { status: 'refunded' } }); await tx.walletTransaction.create({ data: { walletId: wallet.id, type: 'refund', amount: payment.amount, balanceAfter: updatedWallet.balance, reason: `Reembolso del pago ${id}`, paymentId: id } }); await tx.outboxEvent.create({ data: { eventType: 'payment.refunded', aggregateId: id, payload: { paymentId: id, orderId: payment.orderId, amount: payment.amount.toString() } } }); return updated; }); }
}
