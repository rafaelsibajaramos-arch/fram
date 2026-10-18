import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { CreatePaymentDto, CreateSimulatedCardDto, TopUpWalletDto } from './payment.dto';
@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}
  list(buyerId?: string) { return this.prisma.payment.findMany({ where: buyerId ? { buyerId } : undefined, orderBy: { createdAt: 'desc' } }); }
  listPayouts(producerId?: string) { return this.prisma.producerPayout.findMany({ where: producerId ? { producerId } : undefined, include: { items: { orderBy: { createdAt: 'asc' }, include: { chargeDetail: true } }, adjustments: true }, orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }] }); }
  async completePayout(id: string, providerReference: string, correlationId?: string) {
    const reference = providerReference.trim();
    if (reference.length < 3 || reference.length > 120) throw new BadRequestException('La referencia de transferencia debe tener entre 3 y 120 caracteres');
    const traceId = normalizeCorrelationId(correlationId);
    return this.prisma.$transaction(async (tx) => {
      const payout = await tx.producerPayout.findUnique({ where: { id } });
      if (!payout) throw new NotFoundException('Liquidación no encontrada');
      if (payout.status === 'paid') {
        if (payout.providerReference === reference) return payout;
        throw new ConflictException('La liquidación ya fue completada con otra referencia');
      }
      if (payout.status !== 'scheduled' || !payout.netAmount.gt(0)) throw new ConflictException('Solo se pueden completar liquidaciones programadas con valor neto mayor que cero');
      const transitioned = await tx.producerPayout.updateMany({ where: { id, status: 'scheduled', providerReference: null }, data: { status: 'paid', providerReference: reference } });
      if (transitioned.count !== 1) {
        const latest = await tx.producerPayout.findUniqueOrThrow({ where: { id } });
        if (latest.status === 'paid' && latest.providerReference === reference) return latest;
        throw new ConflictException('La liquidación ya fue completada o modificada por otro administrador');
      }
      const updated = await tx.producerPayout.findUniqueOrThrow({ where: { id } });
      await this.enqueueEvent(tx, 'payout.completed', updated.id, 1, traceId, { payout_id: updated.id, producer_id: updated.producerId, period_start: updated.periodStart.toISOString().slice(0, 10), period_end: updated.periodEnd.toISOString().slice(0, 10), gross_amount: updated.grossAmount.toString(), refund_amount: updated.refundAmount.toString(), commission_amount: updated.commissionAmount.toString(), adjustment_amount: updated.adjustmentAmount.toString(), net_amount: updated.netAmount.toString(), currency: 'COP', provider_reference: reference });
      return updated;
    });
  }
  async get(id: string) { const payment = await this.prisma.payment.findUnique({ where: { id } }); if (!payment) throw new NotFoundException('Pago no encontrado'); return payment; }
  async getByOrder(orderId: string) { const payment = await this.prisma.payment.findUnique({ where: { orderId } }); if (!payment) throw new NotFoundException('Pago no encontrado para este pedido'); return payment; }
  wallet(buyerId: string) { return this.prisma.wallet.findUnique({ where: { buyerId }, include: { transactions: { orderBy: { createdAt: 'desc' }, take: 50 } } }); }
  async listCards(buyerId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { buyerId } });
    if (!wallet) return [];
    return this.prisma.simulatedCard.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: 'desc' } });
  }
  async createCard(buyerId: string, dto: CreateSimulatedCardDto) {
    const wallet = await this.prisma.wallet.upsert({ where: { buyerId }, create: { buyerId }, update: {} });
    const expiry = new Date(); expiry.setMonth(expiry.getMonth() + randomInt(18, 73));
    return this.prisma.simulatedCard.create({ data: {
      walletId: wallet.id, brand: dto.brand, holderName: dto.holderName.trim(),
      last4: String(randomInt(0, 10000)).padStart(4, '0'), expiryMonth: expiry.getMonth() + 1, expiryYear: expiry.getFullYear(),
    } });
  }
  async deleteCard(buyerId: string, cardId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { buyerId } });
    if (!wallet) throw new NotFoundException('No se encontró la tarjeta');
    const removed = await this.prisma.simulatedCard.deleteMany({ where: { id: cardId, walletId: wallet.id } });
    if (!removed.count) throw new NotFoundException('La tarjeta no existe en tu cuenta');
    return { deleted: true, sharedBalancePreserved: true };
  }
  async topUp(buyerId: string, dto: TopUpWalletDto, actorId: string, correlationId?: string) {
    const traceId = normalizeCorrelationId(correlationId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) { const old = await tx.walletTransaction.findUnique({ where: { idempotencyKey: dto.idempotencyKey } }); if (old) return tx.wallet.findUnique({ where: { buyerId }, include: { transactions: true } }); }
      const wallet = await tx.wallet.upsert({ where: { buyerId }, create: { buyerId }, update: {} });
      const updated = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: dto.amount }, version: { increment: 1 } } });
      await tx.walletTransaction.create({ data: { walletId: wallet.id, type: 'credit', amount: dto.amount, balanceAfter: updated.balance, reason: dto.reason, actorId, idempotencyKey: dto.idempotencyKey } });
      await this.enqueueEvent(tx, 'wallet.topped_up', updated.id, updated.version, traceId, { wallet_id: updated.id, buyer_id: buyerId, amount: dto.amount.toString(), currency: updated.currency, balance_after: updated.balance.toString(), actor_id: actorId, reason: dto.reason });
      return updated;
    });
  }
  async create(dto: CreatePaymentDto, authenticatedBuyerId?: string, correlationId?: string) {
    const traceId = normalizeCorrelationId(correlationId);
    if (authenticatedBuyerId && dto.buyerId !== authenticatedBuyerId) throw new ForbiddenException('El comprador no coincide con el token');
    if (dto.idempotencyKey) {
      const old = await this.prisma.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
      if (old) return this.assertSameAuthorization(old, dto);
    }
    try { return await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { buyerId: dto.buyerId } });
      if (!wallet) throw new BadRequestException('El comprador no tiene una billetera');
      const card = await tx.simulatedCard.findFirst({ where: { id: dto.simulatedCardId, walletId: wallet.id } });
      if (!card) throw new ConflictException('La tarjeta simulada ya no está disponible');
      const changed = await tx.wallet.updateMany({ where: { id: wallet.id, balance: { gte: dto.amount } }, data: { balance: { decrement: dto.amount }, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('Saldo insuficiente');
      const updatedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      const payment = await tx.payment.create({ data: { orderId: dto.orderId, buyerId: dto.buyerId, amount: dto.amount, currency: dto.currency ?? 'COP', status: 'authorized', idempotencyKey: dto.idempotencyKey, simulatedCardId: card.id, simulatedCardBrand: card.brand, simulatedCardLast4: card.last4 } });
      await tx.walletTransaction.create({ data: { walletId: wallet.id, type: 'debit', amount: dto.amount, balanceAfter: updatedWallet.balance, reason: `Pago del pedido ${dto.orderId}`, paymentId: payment.id, idempotencyKey: dto.idempotencyKey ? `debit:${dto.idempotencyKey}` : undefined } });
      await this.enqueueEvent(tx, 'payment.authorized', payment.id, 1, traceId, { payment_id: payment.id, order_id: payment.orderId, buyer_id: payment.buyerId, amount: payment.amount.toString(), currency: payment.currency, simulated_card_brand: card.brand, simulated_card_last4: card.last4 });
      return payment;
    }); } catch (error) {
      // Idempotency/order unique constraints may race. Return the transaction
      // winner only when it represents the exact same authorization request.
      if (isUniqueViolation(error)) {
        const existing = dto.idempotencyKey
          ? await this.prisma.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } })
          : await this.prisma.payment.findUnique({ where: { orderId: dto.orderId } });
        if (existing) return this.assertSameAuthorization(existing, dto);
      }
      throw error;
    }
  }
  async authorizeCheckoutFromInventory(event: { event_id: string; event_type: string; source_service: string; correlation_id: string; entity_id: string; payload: Record<string, unknown> }) {
    if (event.source_service !== 'inventory-service' || event.event_type !== 'inventory.order_reserved') throw new BadRequestException('Reserva de checkout no confiable');
    const orderId = String(event.payload.order_id ?? '');
    const buyerId = String(event.payload.buyer_id ?? '');
    const simulatedCardId = String(event.payload.simulated_card_id ?? '');
    const amount = new Prisma.Decimal(String(event.payload.total_amount ?? 'NaN'));
    const currency = String(event.payload.currency ?? 'COP');
    const lines = Array.isArray(event.payload.items) ? event.payload.items as Array<Record<string, unknown>> : [];
    const lineTotal = lines.reduce((sum, line) => sum.plus(new Prisma.Decimal(String(line.subtotal ?? 'NaN'))), new Prisma.Decimal(0));
    if (!isUuid(event.event_id) || !isUuid(orderId) || !isUuid(buyerId) || !isUuid(simulatedCardId) || !amount.isFinite() || !amount.gt(0) || !lines.length || lines.some((line) => !isUuid(String(line.order_item_id ?? '')) || !isUuid(String(line.reservation_id ?? ''))) || !lineTotal.equals(amount)) throw new BadRequestException('El evento de reserva no contiene un medio de pago, total y detalle consistentes');
    if (await this.prisma.processedEvent.findUnique({ where: { eventId: event.event_id } })) return { duplicate: true };
    try {
      const payment = await this.create({ orderId, buyerId, amount: amount.toNumber(), simulatedCardId, currency, idempotencyKey: `checkout:${orderId}` }, undefined, event.correlation_id);
      if (payment.status !== PaymentStatus.authorized) throw new ConflictException('La autorización del pago simulado no quedó vigente');
      await this.prisma.$transaction(async (tx) => {
        if (await tx.processedEvent.findUnique({ where: { eventId: event.event_id } })) return;
        await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
        await this.enqueueEvent(tx, 'payment.checkout_authorized', payment.id, 1, normalizeCorrelationId(event.correlation_id), { payment_id: payment.id, order_id: orderId, buyer_id: buyerId, amount: payment.amount.toString(), currency: payment.currency });
      });
      return payment;
    } catch (error) {
      if (!(error instanceof ConflictException) || !['Saldo insuficiente', 'La tarjeta simulada ya no está disponible'].includes(error.message)) throw error;
      await this.prisma.$transaction(async (tx) => {
        if (await tx.processedEvent.findUnique({ where: { eventId: event.event_id } })) return;
        await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
        await this.enqueueEvent(tx, 'payment.checkout_authorization_rejected', orderId, 1, normalizeCorrelationId(event.correlation_id), { order_id: orderId, buyer_id: buyerId, reason: error.message === 'Saldo insuficiente' ? 'insufficient_simulated_balance' : 'simulated_card_unavailable' });
      });
      return { rejected: true, reason: 'authorization_rejected' };
    }
  }
  async compensateCheckoutCancellation(event: { event_id: string; event_type: string; source_service: string; correlation_id: string; payload: Record<string, unknown> }) {
    if (event.source_service !== 'order-service' || event.event_type !== 'order.cancelled') throw new BadRequestException('Cancelación de pedido no confiable');
    const orderId = String(event.payload.orderId ?? event.payload.order_id ?? '');
    if (!isUuid(event.event_id) || !isUuid(orderId)) throw new BadRequestException('Cancelación de pedido incompleta');
    if (await this.prisma.processedEvent.findUnique({ where: { eventId: event.event_id } })) return { duplicate: true };
    const payment = await this.prisma.payment.findUnique({ where: { orderId } });
    if (payment?.status === PaymentStatus.authorized) await this.voidAuthorization(payment.id, event.correlation_id);
    await this.prisma.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { eventId: event.event_id } })) return;
      await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
    });
    return { compensated: true };
  }
  async authorize(id: string) { const payment = await this.get(id); if (payment.status !== PaymentStatus.authorized) throw new ConflictException('El pago no fue autorizado'); return payment; }
  async lockForFulfillment(id: string, routeId: string) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Pago no encontrado');
      if (payment.status !== PaymentStatus.authorized) throw new ConflictException('El pedido no tiene una autorización de pago vigente');
      if (payment.fulfillmentRouteId && payment.fulfillmentRouteId !== routeId) throw new ConflictException('El pago ya está reservado para otra ruta');
      if (payment.fulfillmentRouteId === routeId) return payment;
      const changed = await tx.payment.updateMany({ where: { id, status: PaymentStatus.authorized, fulfillmentRouteId: null }, data: { fulfillmentRouteId: routeId } });
      if (changed.count !== 1) {
        const latest = await tx.payment.findUniqueOrThrow({ where: { id } });
        if (latest.status === PaymentStatus.authorized && latest.fulfillmentRouteId === routeId) return latest;
        throw new ConflictException('No se pudo reservar la autorización para despacho');
      }
      return tx.payment.findUniqueOrThrow({ where: { id } });
    });
  }
  async unlockForFulfillment(id: string, routeId: string) {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Pago no encontrado');
      if (payment.status !== PaymentStatus.authorized) return payment;
      if (payment.fulfillmentRouteId !== routeId) throw new ConflictException('La autorización no está reservada para esta ruta');
      await tx.payment.updateMany({ where: { id, status: PaymentStatus.authorized, fulfillmentRouteId: routeId }, data: { fulfillmentRouteId: null } });
      return tx.payment.findUniqueOrThrow({ where: { id } });
    });
  }
  async capture(id: string, correlationId?: string) {
    const traceId = normalizeCorrelationId(correlationId);
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Pago no encontrado');
      if (payment.status === PaymentStatus.captured) return payment;
      if (payment.status !== PaymentStatus.authorized) throw new ConflictException('Solo se puede capturar un pago autorizado');
      const changed = await tx.payment.updateMany({ where: { id, status: PaymentStatus.authorized }, data: { status: PaymentStatus.captured, capturedAmount: payment.amount } });
      if (changed.count !== 1) {
        const latest = await tx.payment.findUniqueOrThrow({ where: { id } });
        if (latest.status === PaymentStatus.captured) return latest;
        throw new ConflictException('El pago ya fue procesado');
      }
      const captured = await tx.payment.findUniqueOrThrow({ where: { id } });
      await this.enqueueEvent(tx, 'payment.captured', id, 2, traceId, { ...this.paymentPayload(captured), amount: captured.capturedAmount.toString(), authorized_amount: captured.amount.toString() });
      await this.enqueueEvent(tx, 'payment.completed', id, 2, traceId, { ...this.paymentPayload(captured), amount: captured.capturedAmount.toString(), authorized_amount: captured.amount.toString() });
      return captured;
    });
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
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { buyerId: payment.buyerId } });
      const releasedAmount = payment.amount.minus(acceptedAmount);
      if (releasedAmount.gt(0)) {
        const walletUpdate = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: releasedAmount }, version: { increment: 1 } } });
        await tx.walletTransaction.create({ data: { walletId: wallet.id, type: 'release', amount: releasedAmount, balanceAfter: walletUpdate.balance, reason: `Saldo no aceptado del pedido ${orderId}`, paymentId, idempotencyKey: `settle:${paymentId}` } });
      }
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
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { buyerId: payment.buyerId } });
      const updatedWallet = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: payment.amount }, version: { increment: 1 } } });
      const voided = await tx.payment.findUniqueOrThrow({ where: { id } });
      await tx.walletTransaction.create({ data: {
        walletId: wallet.id, type: 'release', amount: payment.amount, balanceAfter: updatedWallet.balance,
        reason: `Liberación de autorización del pedido ${payment.orderId}`, paymentId: id,
        idempotencyKey: `void:${id}`,
      } });
      await this.enqueueEvent(tx, 'payment.voided', id, 2, traceId, { ...this.paymentPayload(voided), reason: 'authorization_released' });
      return voided;
    });
  }
  async fail(id: string, reason?: string, correlationId?: string) {
    const traceId = normalizeCorrelationId(correlationId);
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Pago no encontrado');
      if (payment.status !== PaymentStatus.pending) throw new ConflictException('Solo se pueden rechazar pagos pendientes; usa anular o reembolsar para pagos autorizados');
      const changed = await tx.payment.updateMany({ where: { id, status: PaymentStatus.pending }, data: { status: PaymentStatus.failed, failureReason: reason ?? 'Pago rechazado' } });
      if (changed.count !== 1) throw new ConflictException('El pago ya fue procesado');
      const failed = await tx.payment.findUniqueOrThrow({ where: { id } });
      await this.enqueueEvent(tx, 'payment.failed', id, 2, traceId, { ...this.paymentPayload(failed), reason: failed.failureReason });
      return failed;
    });
  }
  async refund(id: string, correlationId?: string) {
    const traceId = normalizeCorrelationId(correlationId);
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id } });
      if (!payment) throw new NotFoundException('Pago no encontrado');
      if (payment.status === PaymentStatus.refunded) return payment;
      if (payment.status !== PaymentStatus.captured) throw new ConflictException('Solo se puede reembolsar un pago capturado y liquidado');
      const refundAmount = payment.capturedAmount;
      const payoutItems = await tx.producerPayoutItem.findMany({ where: { paymentId: id }, include: { payout: true } });
      const itemTotal = payoutItems.reduce((sum, item) => sum.plus(item.grossAmount), new Prisma.Decimal(0));
      if (!payoutItems.length || !itemTotal.equals(refundAmount)) throw new ConflictException('No existe un detalle de liquidación completo para reembolsar este pago');
      if (payoutItems.some((item) => item.refundAmount.gt(0))) throw new ConflictException('El pedido ya tiene líneas reembolsadas');
      const transitioned = await tx.payment.updateMany({ where: { id, status: PaymentStatus.captured }, data: { status: PaymentStatus.refunded } });
      if (transitioned.count !== 1) throw new ConflictException('El pago ya fue procesado');
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { buyerId: payment.buyerId } });
      const updatedWallet = await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: refundAmount }, version: { increment: 1 } } });
      const updated = await tx.payment.findUniqueOrThrow({ where: { id } });
      await tx.walletTransaction.create({ data: { walletId: wallet.id, type: 'refund', amount: refundAmount, balanceAfter: updatedWallet.balance, reason: `Reembolso del pago ${id}`, paymentId: id, idempotencyKey: `refund:${id}` } });
      for (const item of payoutItems) {
        const refund = await tx.refund.create({ data: { paymentId: id, orderItemId: item.orderItemId, producerId: item.payout.producerId, amount: item.grossAmount, status: 'completed', idempotencyKey: `refund:${id}:${item.orderItemId}` } });
        if (item.payout.status === 'paid') {
          const start = new Date(item.payout.periodEnd);
          let adjustmentPayout = null as Awaited<ReturnType<typeof tx.producerPayout.findUnique>>;
          let periodStart = start;
          for (let attempt = 0; attempt < 366; attempt += 1) {
            const periodEnd = nextUtcMonth(periodStart);
            adjustmentPayout = await tx.producerPayout.findUnique({ where: { producerId_periodStart_periodEnd: { producerId: item.payout.producerId, periodStart, periodEnd } } });
            if (!adjustmentPayout || adjustmentPayout.status !== 'paid') break;
            periodStart = periodEnd;
          }
          if (adjustmentPayout?.status === 'paid') throw new ConflictException('No se encontró un periodo abierto para registrar el ajuste de reembolso');
          const periodEnd = nextUtcMonth(periodStart);
          if (!adjustmentPayout) adjustmentPayout = await tx.producerPayout.create({ data: { producerId: item.payout.producerId, periodStart, periodEnd, grossAmount: 0, refundAmount: 0, commissionAmount: 0, adjustmentAmount: 0, netAmount: 0, status: 'carried' } });
          const adjustmentAmount = item.netAmount.negated();
          const adjustment = await tx.settlementAdjustment.create({ data: { refundId: refund.id, originalItemId: item.id, payoutId: adjustmentPayout.id, amount: adjustmentAmount } });
          const nextPayout = await tx.producerPayout.update({ where: { id: adjustmentPayout.id }, data: { adjustmentAmount: { increment: adjustmentAmount }, netAmount: { increment: adjustmentAmount }, status: 'carried' } });
          await this.enqueueEvent(tx, 'payout.scheduled', nextPayout.id, 1, traceId, { payout_id: nextPayout.id, producer_id: nextPayout.producerId, period_start: periodStart.toISOString().slice(0, 10), period_end: periodEnd.toISOString().slice(0, 10), gross_amount: nextPayout.grossAmount.toString(), refund_amount: nextPayout.refundAmount.toString(), commission_amount: nextPayout.commissionAmount.toString(), adjustment_amount: nextPayout.adjustmentAmount.toString(), net_amount: nextPayout.netAmount.toString(), currency: 'COP', adjustment_id: adjustment.id });
        } else {
          await tx.producerPayoutItem.update({ where: { id: item.id }, data: { refundAmount: item.grossAmount, commissionAmount: 0, netAmount: 0 } });
          await tx.settlementAdjustment.create({ data: { refundId: refund.id, originalItemId: item.id, payoutId: item.payoutId, amount: new Prisma.Decimal(0) } });
          const periodItems = await tx.producerPayoutItem.findMany({ where: { payoutId: item.payoutId } });
          const totals = periodItems.reduce((sum, row) => ({ gross: sum.gross.plus(row.grossAmount), refunds: sum.refunds.plus(row.refundAmount), commission: sum.commission.plus(row.commissionAmount), net: sum.net.plus(row.netAmount) }), { gross: new Prisma.Decimal(0), refunds: new Prisma.Decimal(0), commission: new Prisma.Decimal(0), net: new Prisma.Decimal(0) });
          const adjustments = await tx.settlementAdjustment.findMany({ where: { payoutId: item.payoutId } });
          const adjustmentAmount = adjustments.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
          const netAmount = totals.net.plus(adjustmentAmount);
          const updatedPayout = await tx.producerPayout.update({ where: { id: item.payoutId }, data: { grossAmount: totals.gross, refundAmount: totals.refunds, commissionAmount: totals.commission, adjustmentAmount, netAmount, status: netAmount.gt(0) ? 'scheduled' : 'carried' } });
          await this.enqueueEvent(tx, 'payout.scheduled', updatedPayout.id, periodItems.length, traceId, { payout_id: updatedPayout.id, producer_id: updatedPayout.producerId, period_start: updatedPayout.periodStart.toISOString().slice(0, 10), period_end: updatedPayout.periodEnd.toISOString().slice(0, 10), gross_amount: updatedPayout.grossAmount.toString(), refund_amount: updatedPayout.refundAmount.toString(), commission_amount: updatedPayout.commissionAmount.toString(), adjustment_amount: updatedPayout.adjustmentAmount.toString(), net_amount: updatedPayout.netAmount.toString(), status: updatedPayout.status, currency: 'COP', item_count: periodItems.length });
        }
      }
      await this.enqueueEvent(tx, 'payment.refunded', id, 3, traceId, { ...this.paymentPayload(updated), amount: refundAmount.toString(), refund_count: payoutItems.length });
      return updated;
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
    if (payment.orderId !== dto.orderId || payment.buyerId !== dto.buyerId || !payment.amount.equals(dto.amount) || payment.currency !== (dto.currency ?? 'COP') || ('simulatedCardId' in payment && payment.simulatedCardId !== dto.simulatedCardId)) {
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
