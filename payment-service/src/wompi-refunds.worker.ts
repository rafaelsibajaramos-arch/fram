import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { cents, wompiConfig } from './wompi';

@Injectable()
export class WompiRefundsWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private unavailableLogged = false;
  private readonly logger = new Logger(WompiRefundsWorker.name);
  constructor(private readonly db: PrismaService) {}
  onModuleInit() { this.timer = setInterval(() => void this.flush(), 5000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      // A submitting request after a crash is deliberately not resent. Its
      // provider outcome must be reconciled to prevent duplicate refunds.
      const expired = await this.db.payment.findMany({ where: { provider: 'wompi', status: 'pending', checkoutExpiresAt: { lt: new Date() } }, take: 25 });
      for (const payment of expired) await this.db.$transaction(async tx => {
        const changed = await tx.payment.updateMany({ where: { id: payment.id, status: 'pending' }, data: { status: 'failed', cancellationRequested: true, failureReason: 'Checkout Wompi vencido' } });
        if (changed.count) await tx.outboxEvent.create({ data: { eventType: 'payment.checkout_authorization_rejected', aggregateId: payment.id, correlationId: payment.id, payload: { payment_id: payment.id, order_id: payment.orderId, buyer_id: payment.buyerId, reason: 'wompi_checkout_expired' } } });
      });
      const config = wompiConfig();
      this.unavailableLogged = false;
      const jobs = await this.db.wompiRefundOperation.findMany({ where: { status: 'pending' }, include: { payment: true }, take: 10, orderBy: { createdAt: 'asc' } });
      for (const job of jobs) {
        if (job.payment.provider !== 'wompi' || !job.payment.providerTransactionId || job.payment.providerStatus !== 'APPROVED') continue;
        const claim = await this.db.wompiRefundOperation.updateMany({ where: { id: job.id, status: 'pending' }, data: { status: 'submitting' } });
        if (!claim.count) continue;
        try {
          const response = await fetch('https://sandbox.wompi.co/v1/refunds', { method: 'POST', headers: { Authorization: `Bearer ${config.privateKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction_id: job.payment.providerTransactionId, amount_in_cents: cents(job.amount), reason: 'Ajuste de pedido FarmToTable', reference: job.operationKey }), signal: AbortSignal.timeout(15000) });
          const payload = await response.json() as { data?: { id?: number; v2_refund_id?: string; status?: string; amount_in_cents?: number; transaction_id?: string } };
          const data = payload.data;
          const verified = response.ok && data?.status === 'APPROVED' && data.transaction_id === job.payment.providerTransactionId && data.amount_in_cents === cents(job.amount) && Boolean(data.v2_refund_id ?? data.id);
          await this.db.wompiRefundOperation.update({ where: { id: job.id }, data: { status: verified ? 'approved' : response.ok && ['DECLINED', 'ERROR', 'CANCELLED'].includes(data?.status ?? '') ? 'failed' : 'unknown', providerReference: data?.v2_refund_id ?? (data?.id ? String(data.id) : undefined), failureReason: verified ? null : 'Revisar resultado en Wompi antes de reintentar' } });
        } catch { await this.db.wompiRefundOperation.update({ where: { id: job.id }, data: { status: 'unknown', failureReason: 'Respuesta no confirmada; conciliar en Wompi sin reenviar automáticamente' } }); }
      }
    } catch (error) { if (!this.unavailableLogged) this.logger.warn(error instanceof Error ? error.message : 'Reembolsos Wompi no disponibles'); this.unavailableLogged = true; }
    finally { this.running = false; }
  }
}
