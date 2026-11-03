import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { checkoutUrl, cents, verifyEvent, fetchTransaction } from './wompi';
import { PrismaService } from './prisma.service';
import { CreatePaymentDto } from './payment.dto';
@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}
  list(buyerId?: string) { return this.prisma.payment.findMany({ where: buyerId ? { buyerId } : undefined, orderBy: { createdAt: 'desc' } }); }
  listPayouts(producerId?: string) { return this.prisma.producerPayout.findMany({ where: producerId ? { producerId } : undefined, include: { items: { orderBy: { createdAt: 'asc' }, include: { chargeDetail: true } }, adjustments: true }, orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }] }); }
  async get(id: string) { const payment = await this.prisma.payment.findUnique({ where: { id } }); if (!payment) throw new NotFoundException('Pago no encontrado'); return payment; }
  async getByOrder(orderId: string) { const payment = await this.prisma.payment.findUnique({ where: { orderId }, include: { refundOperations: true } }); if (!payment) throw new NotFoundException('Pago no encontrado para este pedido'); return payment; }
  async create(dto: CreatePaymentDto, authenticatedBuyerId?: string, _correlationId?: string) {
    void _correlationId;
    if (authenticatedBuyerId && dto.buyerId !== authenticatedBuyerId) throw new ForbiddenException('El comprador no coincide con el token');
    if ((dto.currency ?? 'COP') !== 'COP') throw new BadRequestException('Solo COP');
    const cancelled = await this.prisma.processedEvent.findFirst({ where: { entityId: dto.orderId, eventType: 'order.cancelled', sourceService: 'order-service' } });
    if (cancelled) throw new ConflictException('El pedido ya fue cancelado');
    const existing = await this.prisma.payment.findUnique({ where: { orderId: dto.orderId } });
    if (existing) return this.assertSameAuthorization(existing, dto);
    const id = randomUUID();
    try { return await this.prisma.payment.create({ data: { id, orderId: dto.orderId, buyerId: dto.buyerId, amount: dto.amount, currency: 'COP', status: 'pending', provider: 'wompi', providerReference: 'FTT-' + id, checkoutExpiresAt: new Date(Date.now() + 10 * 60_000), idempotencyKey: dto.idempotencyKey } }); }
    catch (error) { if (isUniqueViolation(error)) { const old = await this.prisma.payment.findUnique({ where: { orderId: dto.orderId } }); if (old) return this.assertSameAuthorization(old, dto); } throw error; }
  }
  async authorizeCheckoutFromInventory(event: { event_id: string; event_type: string; source_service: string; correlation_id: string; entity_id: string; payload: Record<string, unknown> }) {
    if (event.source_service !== 'inventory-service' || event.event_type !== 'inventory.order_reserved') throw new BadRequestException('Reserva no confiable');
    const orderId = String(event.payload.order_id ?? ''); const buyerId = String(event.payload.buyer_id ?? '');
    const amount = new Prisma.Decimal(String(event.payload.total_amount ?? 'NaN'));
    const lines = Array.isArray(event.payload.items) ? event.payload.items as Array<Record<string, unknown>> : [];
    const total = lines.reduce((sum, l) => sum.plus(new Prisma.Decimal(String(l.subtotal ?? 'NaN'))), new Prisma.Decimal(0));
    if (!isUuid(orderId) || !isUuid(buyerId) || !amount.isFinite() || !amount.gt(0) || !lines.length || !amount.equals(total)) throw new BadRequestException('Reserva inconsistente');
    return this.create({ orderId, buyerId, amount: amount.toNumber(), currency: String(event.payload.currency ?? 'COP'), idempotencyKey: 'checkout:' + orderId });
  }
  async checkoutSession(orderId: string, buyerId: string) {
    const payment = await this.getByOrder(orderId);
    if (payment.buyerId !== buyerId) throw new ForbiddenException('No autorizado');
    if (payment.provider !== 'wompi' || payment.cancellationRequested || payment.status !== 'pending' || !payment.providerReference || !payment.checkoutExpiresAt || payment.checkoutExpiresAt.getTime() <= Date.now()) throw new ConflictException('Este pago no está disponible para iniciar checkout');
    return { provider: 'wompi', environment: 'sandbox', paymentId: payment.id, amount: payment.amount.toString(), currency: payment.currency, expiresAt: payment.checkoutExpiresAt, checkoutUrl: checkoutUrl(payment.providerReference, payment.amount, payment.checkoutExpiresAt) };
  }
  async wompiEvent(body: unknown) {
    const signed = verifyEvent(body);
    // Verify the complete transaction server-to-server as the event signature
    // may not cover the reference or currency. Never trust redirect parameters.
    const transaction = await fetchTransaction(signed.transaction.id);
    if (transaction.id !== signed.transaction.id) throw new BadRequestException('Transacción no coincidente');
    const reference = transaction.reference;
    return this.prisma.$transaction(async tx => {
      const payment = await tx.payment.findUnique({ where: { providerReference: reference } });
      if (!payment || payment.provider !== 'wompi' || transaction.currency !== 'COP' || transaction.amount_in_cents !== cents(payment.amount)) throw new BadRequestException('El pago no coincide con la referencia, moneda o importe esperado');
      if (payment.providerTransactionId && payment.providerTransactionId !== transaction.id) throw new ConflictException('La referencia ya tiene otra transacción');
      if (transaction.status === 'PENDING') return { received: true };
      if (payment.providerStatus === transaction.status) return { received: true, duplicate: true };
      if (payment.providerStatus === 'APPROVED' && transaction.status !== 'VOIDED') return { received: true, ignored: true };
      if (!['APPROVED', 'DECLINED', 'ERROR', 'VOIDED'].includes(transaction.status)) throw new BadRequestException('Estado de Wompi desconocido');
      const approved = transaction.status === 'APPROVED';
      const cancelled = payment.cancellationRequested;
      const status = approved && !cancelled ? PaymentStatus.authorized : approved || transaction.status === 'VOIDED' ? PaymentStatus.voided : PaymentStatus.failed;
      // authorized is an internal fulfillment gate, not a Wompi preauthorization.
      await tx.payment.update({ where: { id: payment.id }, data: { status, providerStatus: transaction.status, providerTransactionId: transaction.id } });
      if (approved && cancelled) {
        await tx.wompiRefundOperation.upsert({ where: { operationKey: 'void:' + payment.id }, create: { paymentId: payment.id, operationKey: 'void:' + payment.id, amount: payment.amount }, update: {} });
        return { received: true, refundPending: true };
      }
      const payload = { payment_id: payment.id, order_id: payment.orderId, buyer_id: payment.buyerId, amount: payment.amount.toString(), currency: payment.currency, provider: 'wompi', provider_transaction_id: transaction.id, reason: 'wompi_' + transaction.status.toLowerCase() };
      await this.enqueueEvent(tx, approved ? 'payment.checkout_authorized' : transaction.status === 'VOIDED' ? 'payment.voided' : 'payment.checkout_authorization_rejected', payment.id, 1, randomUUID(), payload);
      return { received: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  async compensateCheckoutCancellation(event: { event_id: string; event_type: string; source_service: string; correlation_id: string; payload: Record<string, unknown> }) {
    if (event.source_service !== 'order-service' || event.event_type !== 'order.cancelled') throw new BadRequestException('Cancelación de pedido no confiable');
    const orderId = String(event.payload.orderId ?? event.payload.order_id ?? '');
    if (!isUuid(event.event_id) || !isUuid(orderId)) throw new BadRequestException('Cancelación de pedido incompleta');
    if (await this.prisma.processedEvent.findUnique({ where: { eventId: event.event_id } })) return { duplicate: true };
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (payment) await this.prisma.payment.update({ where: { id: payment.id }, data: { cancellationRequested: true } });
    if (payment?.status === PaymentStatus.authorized) await this.voidAuthorization(payment.id, event.correlation_id);
    await this.prisma.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { eventId: event.event_id } })) return;
      await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
    });
    return { compensated: true };
  }
  async lockForFulfillment(id: string, routeId: string) {
    return this.prisma.$transaction(async tx => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.provider !== 'wompi' || payment.providerStatus !== 'APPROVED' || payment.status !== PaymentStatus.authorized) throw new ConflictException('El pedido no tiene un pago Wompi aprobado');
      await tx.paymentRouteLock.upsert({ where: { paymentId_routeId: { paymentId: id, routeId } }, create: { paymentId: id, routeId }, update: {} });
      if (!payment.fulfillmentRouteId) await tx.payment.update({ where: { id }, data: { fulfillmentRouteId: routeId } });
      return tx.payment.findUniqueOrThrow({ where: { id } });
    }, { isolationLevel: 'Serializable' });
  }
  async unlockForFulfillment(id: string, routeId: string) {
    return this.prisma.$transaction(async tx => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.status !== PaymentStatus.authorized) return payment;
      await tx.paymentRouteLock.deleteMany({ where: { paymentId: id, routeId } });
      const other = await tx.paymentRouteLock.findFirst({ where: { paymentId: id } });
      return tx.payment.update({ where: { id }, data: { fulfillmentRouteId: other?.routeId ?? null } });
    }, { isolationLevel: 'Serializable' });
  }
  async registerOrderConfirmed(event: { event_id: string; event_type: string; source_service: string; correlation_id: string; entity_id: string; payload: Record<string, unknown> }) {
    if (event.source_service !== 'order-service' || event.event_type !== 'order.confirmed') throw new BadRequestException('Confirmación de pedido no confiable');
    const eventId = String(event.event_id ?? '');
    const orderId = String(event.payload.orderId ?? event.entity_id ?? '');
    const buyerId = String(event.payload.buyerId ?? event.payload.buyer_id ?? '');
    if (!isUuid(eventId) || !isUuid(orderId) || !isUuid(buyerId) || String(event.payload.status ?? 'confirmed') !== 'confirmed') throw new BadRequestException('order.confirmed no tiene identificadores o estado válidos');
    const rawItems = Array.isArray(event.payload.items) ? event.payload.items as Array<Record<string, unknown>> : [];
    if (!rawItems.length) throw new BadRequestException('order.confirmed no contiene líneas de cobro');
    const defaultRate = commissionRate();
    const details = rawItems.map((line) => {
      const orderItemId = String(line.id ?? '');
      const productId = String(line.productId ?? '');
      const productName = String(line.productName ?? '').trim();
      const producerName = line.producerName == null ? null : String(line.producerName).trim().slice(0, 180);
      const producerId = String(line.producerId ?? '');
      const quantity = new Prisma.Decimal(String(line.quantity ?? 'NaN'));
      const unitPrice = new Prisma.Decimal(String(line.unitPrice ?? 'NaN'));
      // La tasa es configuración del servicio de pagos: un productor de eventos
      // de pedidos no puede inyectar/modificar la comisión cobrada.
      const rate = defaultRate;
      if (!isUuid(orderItemId) || !isUuid(productId) || !isUuid(producerId) || productName.length < 1 || productName.length > 160 || !quantity.isFinite() || !quantity.gt(0) || !unitPrice.isFinite() || !unitPrice.gt(0) || !rate.isFinite() || rate.isNegative() || rate.gt(1)) throw new BadRequestException('Una línea confirmada contiene datos contables inválidos');
      return { orderItemId, productId, productName, producerName, producerId, quantity, unitPrice, commissionRate: rate };
    });
    if (new Set(details.map((detail) => detail.orderItemId)).size !== details.length) throw new BadRequestException('order.confirmed repite líneas de pedido');
    const authorizedAmount = details.reduce((sum, detail) => sum.plus(detail.quantity.times(detail.unitPrice).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)), new Prisma.Decimal(0));
    const traceId = normalizeCorrelationId(event.correlation_id);

    return this.prisma.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { eventId } })) return tx.chargeDetail.findMany({ where: { payment: { orderId } }, orderBy: { orderItemId: 'asc' } });
      const payment = await tx.payment.findUnique({ where: { orderId } });
      if (!payment || payment.buyerId !== buyerId) throw new NotFoundException('No existe una autorización del comprador para el pedido confirmado');
      if (payment.status !== PaymentStatus.authorized) throw new ConflictException('El detalle contable solo se registra después de autorizar el pedido');
      if (!payment.amount.equals(authorizedAmount)) throw new ConflictException('La suma de las líneas del pedido no coincide con el importe autorizado');
      for (const detail of details) {
        const where = { paymentId_orderItemId: { paymentId: payment.id, orderItemId: detail.orderItemId } };
        const existing = await tx.chargeDetail.findUnique({ where });
        if (existing) {
          if (existing.productId !== detail.productId || existing.productName !== detail.productName || existing.producerName !== detail.producerName || existing.producerId !== detail.producerId || !existing.orderedQuantity.equals(detail.quantity) || !existing.unitPrice.equals(detail.unitPrice) || !existing.commissionRate.equals(detail.commissionRate)) throw new ConflictException('El detalle contable existente no coincide con el pedido confirmado');
          continue;
        }
        await tx.chargeDetail.create({ data: { paymentId: payment.id, orderItemId: detail.orderItemId, productId: detail.productId, productName: detail.productName, producerName: detail.producerName, producerId: detail.producerId, orderedQuantity: detail.quantity, unitPrice: detail.unitPrice, commissionRate: detail.commissionRate } });
      }
      await tx.processedEvent.create({ data: { eventId, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
      await this.enqueueEvent(tx, 'payment.details_registered', payment.id, 1, traceId, { payment_id: payment.id, order_id: orderId, buyer_id: buyerId, line_count: details.length, commission_rate_source: 'payment_service_configuration' });
      return tx.chargeDetail.findMany({ where: { paymentId: payment.id }, orderBy: { orderItemId: 'asc' } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  async settleFulfillment(event: { event_id: string; event_type: string; source_service: string; correlation_id: string; payload: Record<string, unknown> }) {
    if (event.source_service !== 'logistics-service' || event.event_type !== 'order.fulfillment_closed') throw new BadRequestException('Evento de cierre de entrega no confiable');
    const eventId = event.event_id;
    const paymentId = String(event.payload.payment_id ?? '');
    const orderId = String(event.payload.order_id ?? '');
    const acceptedAmount = new Prisma.Decimal(String(event.payload.accepted_amount ?? 'NaN'));
    if (!isUuid(eventId) || !isUuid(paymentId) || !isUuid(orderId) || !acceptedAmount.isFinite() || acceptedAmount.isNegative()) throw new BadRequestException('El evento de entrega no contiene un pago válido');
    const lines = Array.isArray(event.payload.items) ? event.payload.items as Array<Record<string, unknown>> : [];
    if (!lines.length) throw new BadRequestException('El cierre de entrega no contiene líneas aceptadas');
    const lineAmount = lines.reduce((sum, line) => {
      const amount = new Prisma.Decimal(String(line.accepted_amount ?? 'NaN'));
      if (!amount.isFinite() || amount.isNegative()) throw new BadRequestException('El importe aceptado por línea es inválido');
      return sum.plus(amount);
    }, new Prisma.Decimal(0)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    if (!lineAmount.equals(acceptedAmount)) throw new BadRequestException('El total aceptado no coincide con el detalle por línea');
    const traceId = normalizeCorrelationId(event.correlation_id);
    return this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.processedEvent.findUnique({ where: { eventId } });
      if (duplicate) return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment || payment.orderId !== orderId) throw new NotFoundException('No existe el pago asociado al pedido entregado');
      if (payment.provider !== 'wompi' || payment.providerStatus !== 'APPROVED') throw new ConflictException('La recepción requiere un pago aprobado por Wompi');
      if (acceptedAmount.gt(payment.amount)) throw new ConflictException('El valor aceptado supera el valor autorizado');
      const details = await tx.chargeDetail.findMany({ where: { paymentId }, orderBy: { orderItemId: 'asc' } });
      if (details.length !== lines.length) throw new ConflictException('El cierre logístico no coincide con las líneas confirmadas del pedido');
      const detailsByItem = new Map(details.map((detail) => [detail.orderItemId, detail]));
      const acceptedLines = lines.map((line) => {
        const orderItemId = String(line.order_item_id ?? '');
        const detail = detailsByItem.get(orderItemId);
        const ordered = new Prisma.Decimal(String(line.quantity_ordered_kg ?? 'NaN'));
        const accepted = new Prisma.Decimal(String(line.accepted_quantity_kg ?? 'NaN'));
        const amount = new Prisma.Decimal(String(line.accepted_amount ?? 'NaN'));
        if (!detail || !ordered.isFinite() || !accepted.isFinite() || !amount.isFinite() || accepted.isNegative() || accepted.gt(detail.orderedQuantity) || !ordered.equals(detail.orderedQuantity)) throw new ConflictException('Una línea aceptada no coincide con la cantidad confirmada');
        if (line.producer_id != null && String(line.producer_id) !== detail.producerId) throw new ConflictException('El productor de una línea entregada no coincide con el pedido');
        const expectedAmount = accepted.times(detail.unitPrice).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        if (!amount.equals(expectedAmount)) throw new ConflictException('El importe aceptado por línea no coincide con su precio confirmado');
        return { detail, accepted, amount };
      });
      if (new Set(acceptedLines.map((line) => line.detail.orderItemId)).size !== details.length) throw new ConflictException('El cierre logístico repite o excluye líneas confirmadas');
      const isVoid = acceptedAmount.isZero();
      if (payment.status !== PaymentStatus.authorized) {
        if ((payment.status === PaymentStatus.captured && payment.capturedAmount.equals(acceptedAmount)) || (payment.status === PaymentStatus.voided && isVoid)) {
          await tx.processedEvent.create({ data: { eventId, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
          return payment;
        }
        throw new ConflictException('El pago ya tuvo una liquidación distinta');
      }
      const status = isVoid ? PaymentStatus.voided : PaymentStatus.captured;
      const transitioned = await tx.payment.updateMany({ where: { id: paymentId, status: PaymentStatus.authorized }, data: { status, capturedAmount: acceptedAmount } });
      if (transitioned.count !== 1) {
        const latest = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
        if ((latest.status === PaymentStatus.captured && latest.capturedAmount.equals(acceptedAmount)) || (latest.status === PaymentStatus.voided && isVoid)) {
          await tx.processedEvent.create({ data: { eventId, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
          return latest;
        }
        throw new ConflictException('El pago ya tuvo una liquidación distinta');
      }
      const releasedAmount = payment.amount.minus(acceptedAmount);
      if (releasedAmount.gt(0)) await tx.wompiRefundOperation.upsert({ where: { operationKey: 'settle:' + paymentId }, create: { paymentId, operationKey: 'settle:' + paymentId, amount: releasedAmount }, update: {} });
      for (const line of acceptedLines) {
        await tx.chargeDetail.update({ where: { id: line.detail.id }, data: { acceptedQuantity: line.accepted, grossAmount: line.amount } });
      }
      if (!isVoid) await this.scheduleProducerPayouts(tx, payment, acceptedLines, traceId, event.payload.closed_at);
      const updated = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      await tx.processedEvent.create({ data: { eventId, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
      const payload = { ...this.paymentPayload(updated), amount: acceptedAmount.toString(), authorized_amount: payment.amount.toString(), status };
      await this.enqueueEvent(tx, isVoid ? 'payment.voided' : 'payment.captured', paymentId, 2, traceId, payload);
      if (!isVoid) await this.enqueueEvent(tx, 'payment.completed', paymentId, 2, traceId, payload);
      return updated;
    });
  }
  async voidAuthorization(id: string, correlationId?: string) {
    const traceId = normalizeCorrelationId(correlationId);
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Pago no encontrado');
      if (payment.status === PaymentStatus.voided) return payment;
      if (payment.status !== PaymentStatus.authorized) throw new ConflictException('Solo se puede anular una autorización vigente');
      if (payment.fulfillmentRouteId) throw new ConflictException('No se puede anular un pago reservado para una ruta en despacho');
      const changed = await tx.payment.updateMany({ where: { id, status: PaymentStatus.authorized, fulfillmentRouteId: null }, data: { status: PaymentStatus.voided } });
      if (changed.count !== 1) {
        const latest = await tx.payment.findUniqueOrThrow({ where: { id } });
        if (latest.status === PaymentStatus.voided) return latest;
        throw new ConflictException('El pago ya fue procesado');
      }
      if (payment.providerStatus === 'APPROVED') await tx.wompiRefundOperation.upsert({ where: { operationKey: 'void:' + id }, create: { paymentId: id, operationKey: 'void:' + id, amount: payment.amount }, update: {} });
      const voided = await tx.payment.findUniqueOrThrow({ where: { id } });
      await this.enqueueEvent(tx, 'payment.voided', id, 2, traceId, { ...this.paymentPayload(voided), reason: 'authorization_released' });
      return voided;
    });
  }
  private enqueueEvent(tx: Prisma.TransactionClient, eventType: string, aggregateId: string, entityVersion: number, correlationId: string, payload: Record<string, unknown>) {
    return tx.outboxEvent.create({ data: { eventType, aggregateId, entityVersion, schemaVersion: 1, correlationId, payload: payload as Prisma.InputJsonValue } });
  }
  private async scheduleProducerPayouts(tx: Prisma.TransactionClient, payment: { id: string; orderId: string }, acceptedLines: Array<{ detail: { id: string; orderItemId: string; producerId: string; commissionRate: Prisma.Decimal }; accepted: Prisma.Decimal; amount: Prisma.Decimal }>, correlationId: string, closedAt?: unknown) {
    const closeDate = closedAt ? new Date(String(closedAt)) : new Date();
    if (Number.isNaN(closeDate.getTime())) throw new BadRequestException('Fecha de cierre de entrega inválida');
    const initialStart = startOfUtcMonth(closeDate);
    const producerIds = [...new Set(acceptedLines.filter((line) => line.amount.gt(0)).map((line) => line.detail.producerId))];
    for (const producerId of producerIds) {
      const lines = acceptedLines.filter((line) => line.detail.producerId === producerId && line.amount.gt(0));
      let periodStart = initialStart;
      let payout = null as Awaited<ReturnType<typeof tx.producerPayout.findUnique>>;
      // Never mutate a completed transfer; carry new financial entries to the next open daily period.
      for (let attempt = 0; attempt < 366; attempt += 1) {
        const periodEnd = nextUtcMonth(periodStart);
        payout = await tx.producerPayout.findUnique({ where: { producerId_periodStart_periodEnd: { producerId, periodStart, periodEnd } } });
        if (!payout || payout.status !== 'paid') break;
        periodStart = periodEnd;
      }
      if (payout?.status === 'paid') throw new ConflictException('No se encontró un periodo abierto para liquidar al productor');
      const periodEnd = nextUtcMonth(periodStart);
      if (!payout) payout = await tx.producerPayout.create({ data: { producerId, periodStart, periodEnd, grossAmount: 0, refundAmount: 0, commissionAmount: 0, adjustmentAmount: 0, netAmount: 0, status: 'draft' } });
      for (const line of lines) {
        const existing = await tx.producerPayoutItem.findUnique({ where: { orderItemId: line.detail.orderItemId } });
        if (existing) {
          if (existing.paymentId !== payment.id || existing.chargeDetailId !== line.detail.id || existing.payoutId !== payout.id || !existing.grossAmount.equals(line.amount)) throw new ConflictException('La línea ya pertenece a otra liquidación');
          continue;
        }
        const commissionAmount = line.amount.times(line.detail.commissionRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        await tx.producerPayoutItem.create({ data: { payoutId: payout.id, paymentId: payment.id, orderId: payment.orderId, orderItemId: line.detail.orderItemId, chargeDetailId: line.detail.id, grossAmount: line.amount, refundAmount: 0, commissionRate: line.detail.commissionRate, commissionAmount, netAmount: line.amount.minus(commissionAmount) } });
      }
      const items = await tx.producerPayoutItem.findMany({ where: { payoutId: payout.id } });
      const totals = items.reduce((sum, item) => ({ gross: sum.gross.plus(item.grossAmount), refunds: sum.refunds.plus(item.refundAmount), commission: sum.commission.plus(item.commissionAmount), net: sum.net.plus(item.netAmount) }), { gross: new Prisma.Decimal(0), refunds: new Prisma.Decimal(0), commission: new Prisma.Decimal(0), net: new Prisma.Decimal(0) });
      const adjustments = await tx.settlementAdjustment.findMany({ where: { payoutId: payout.id } });
      const adjustmentAmount = adjustments.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
      const netAmount = totals.net.plus(adjustmentAmount);
      const updated = await tx.producerPayout.update({ where: { id: payout.id }, data: { grossAmount: totals.gross, refundAmount: totals.refunds, commissionAmount: totals.commission, adjustmentAmount, netAmount, status: netAmount.gt(0) ? 'scheduled' : 'carried' } });
      await this.enqueueEvent(tx, 'payout.scheduled', updated.id, items.length, correlationId, { payout_id: updated.id, producer_id: producerId, period_start: periodStart.toISOString().slice(0, 10), period_end: periodEnd.toISOString().slice(0, 10), gross_amount: updated.grossAmount.toString(), refund_amount: updated.refundAmount.toString(), commission_amount: updated.commissionAmount.toString(), adjustment_amount: updated.adjustmentAmount.toString(), net_amount: updated.netAmount.toString(), status: updated.status, currency: 'COP', item_count: items.length });
    }
  }

  private paymentPayload(payment: { id: string; orderId: string; buyerId: string; amount: Prisma.Decimal; capturedAmount?: Prisma.Decimal; currency: string; status: PaymentStatus }) {
    const settled = payment.status === PaymentStatus.captured || payment.status === PaymentStatus.refunded;
    return { payment_id: payment.id, order_id: payment.orderId, buyer_id: payment.buyerId, amount: (settled ? payment.capturedAmount ?? payment.amount : payment.amount).toString(), authorized_amount: payment.amount.toString(), currency: payment.currency, status: payment.status };
  }

  private assertSameAuthorization<T extends { orderId: string; buyerId: string; amount: Prisma.Decimal; currency: string }>(payment: T, dto: CreatePaymentDto): T {
    if (payment.orderId !== dto.orderId || payment.buyerId !== dto.buyerId || !payment.amount.equals(dto.amount) || payment.currency !== (dto.currency ?? 'COP')) {
      throw new ConflictException('La clave idempotente del pago ya pertenece a otra operación');
    }
    return payment;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function normalizeCorrelationId(value?: string): string { return value && UUID_PATTERN.test(value) ? value : randomUUID(); }
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002'); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function commissionRate(): Prisma.Decimal {
  const value = new Prisma.Decimal(process.env.PLATFORM_COMMISSION_RATE ?? '0.10');
  if (!value.isFinite() || value.isNegative() || value.gt(1)) throw new Error('PLATFORM_COMMISSION_RATE debe estar entre 0 y 1');
  return value;
}
function startOfUtcMonth(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1)); }
function nextUtcMonth(value: Date): Date { return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1)); }
