import { BadGatewayException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { CreateOrderDto, CreateOrderRatingDto, UpsertCartDto } from './orders.dto';
import { EventEnvelope } from './events/event-envelope';

export type CheckoutUpstreams = { catalog?: string; inventory?: string; payment?: string; producer?: string };

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  constructor(private readonly prisma: PrismaService) {}
  list(buyerId?: string) { return this.prisma.order.findMany({ where: buyerId ? { buyerId } : undefined, include: { items: true }, orderBy: { createdAt: 'desc' } }); }
  async listForProducer(userId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}) {
    const producerId = await this.producerIdForUser(userId, bearer, gatewayUserId, gatewayRoles, upstreams);
    // Las líneas nuevas ya llevan producerId. Para conservar visibles los
    // pedidos confirmados antes de esta migración, se resuelve el dueño del
    // producto desde Catálogo una sola vez por producto.
    const orders = await this.prisma.order.findMany({ include: { items: true }, orderBy: { createdAt: 'desc' } });
    const ownerCache = new Map<string, boolean>();
    const owns = async (productId: string) => {
      if (!ownerCache.has(productId)) ownerCache.set(productId, await this.productBelongsToProducer(productId, producerId, bearer, gatewayUserId, gatewayRoles, upstreams));
      return ownerCache.get(productId)!;
    };
    const visible = [] as typeof orders;
    for (const order of orders) {
      const items = [] as typeof order.items;
      for (const item of order.items) if (item.producerId === producerId || (!item.producerId && await owns(item.productId))) items.push(item);
      if (items.length) visible.push({ ...order, items });
    }
    return visible;
  }
  async getForProducer(id: string, userId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}) {
    const orders = await this.listForProducer(userId, bearer, gatewayUserId, gatewayRoles, upstreams);
    const order = orders.find((candidate) => candidate.id === id);
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return order;
  }
  async get(id: string) { const order = await this.prisma.order.findUnique({ where: { id }, include: { items: true } }); if (!order) throw new NotFoundException('Pedido no encontrado'); return order; }
  async create(dto: CreateOrderDto, buyerId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}, correlationId: string = randomUUID()) {
    if (dto.buyerId !== buyerId) throw new ForbiddenException('El comprador no coincide con el token');
    const inventoryUrl = this.url(upstreams.inventory, 'INVENTORY_SERVICE_URL', 'http://localhost:3004');
    if (dto.idempotencyKey) { const previous = await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } }); if (previous) return previous; }
    const resolved = await this.resolveItems(dto, bearer, gatewayUserId, gatewayRoles, upstreams);
    const reservations: Array<{ reservationId: string; productId: string; producerId?: string; producerName?: string | null; quantity: number; unitPrice: number; priceVersionId?: string; productName: string; harvestBatchId: string | null; farmId: string | null; pickupAddress: string | null; pickupLatitude: number | null; pickupLongitude: number | null }> = [];
    for (const item of resolved) {
      const response = await fetch(`${inventoryUrl}/inventory/reservations`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-correlation-id': correlationId }, body: JSON.stringify({ product_id: item.productId, quantity_kg: item.quantity, idempotency_key: reservationIdempotencyKey(dto.idempotencyKey ?? correlationId, buyerId, item.productId) }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        // No responder al cliente mientras quede una compensación de stock en
        // vuelo: si una línea posterior no se reserva, libera las anteriores
        // antes de permitir que el comprador reintente el checkout.
        await this.release(reservations, bearer, gatewayUserId, gatewayRoles, upstreams);
        throw new ConflictException(`No se pudo reservar inventario para ${item.productId}`);
      }
      const body = await response.json() as { reservation?: { id: string }; stock?: { batch_id?: string | null; farm_id?: string | null; pickup_address?: string | null; pickup_latitude?: number | null; pickup_longitude?: number | null } };
      if (!body.reservation?.id) throw new Error('Inventario no devolvio la reserva');
      reservations.push({ reservationId: body.reservation.id, productId: item.productId, producerId: item.producerId, producerName: item.producerName, quantity: item.quantity, unitPrice: item.unitPrice, priceVersionId: item.priceVersionId, productName: item.productName, harvestBatchId: body.stock?.batch_id ?? null, farmId: body.stock?.farm_id ?? null, pickupAddress: body.stock?.pickup_address ?? null, pickupLatitude: body.stock?.pickup_latitude ?? null, pickupLongitude: body.stock?.pickup_longitude ?? null });
    }
    const items = reservations.map((item) => ({ ...item, subtotal: item.quantity * item.unitPrice }));
    const totalAmount = items.reduce((sum, item) => sum + item.subtotal, 0);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({ data: { buyerId: dto.buyerId, simulatedCardId: dto.simulatedCardId, deliveryAddress: dto.deliveryAddress, currency: dto.currency ?? 'COP', totalAmount, idempotencyKey: dto.idempotencyKey, items: { create: items.map((item) => ({ ...item, harvestBatchId: item.harvestBatchId, farmId: item.farmId, pickupAddress: item.pickupAddress, pickupLatitude: item.pickupLatitude, pickupLongitude: item.pickupLongitude })) } }, include: { items: true } });
      await tx.outboxEvent.create({ data: { eventType: 'order.created', aggregateId: order.id, correlationId, payload: toJsonValue(order)! } });
      return order;
    });
  }
  async startCheckoutSaga(dto: CreateOrderDto, buyerId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}, correlationId: string = randomUUID()) {
    if (dto.buyerId !== buyerId) throw new ForbiddenException('El comprador no coincide con el token');
    dto.items = aggregateOrderItems(dto.items);
    const existing = dto.idempotencyKey ? await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } }) : null;
    if (existing?.buyerId !== undefined && existing.buyerId !== buyerId) throw new ForbiddenException('La clave de compra pertenece a otra cuenta');
    if (existing?.status === OrderStatus.cancelled) throw new ConflictException('Este intento fue cancelado; vuelve al carrito para iniciar una compra nueva');
    if (existing) return { order: existing, processing: existing.status === OrderStatus.pending, replayed: true };
    if (!dto.items.length || dto.items.length > 100) throw new ConflictException('El carrito está vacío o supera el máximo de productos');
    const resolved = await this.resolveItems(dto, bearer, gatewayUserId, gatewayRoles, upstreams);
    const total = resolved.reduce((sum, item) => sum.plus(new Prisma.Decimal(item.quantity).times(new Prisma.Decimal(item.unitPrice)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)), new Prisma.Decimal(0));
    if (!total.gt(0)) throw new ConflictException('El total de la compra debe ser mayor que cero');
    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const raced = await tx.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } });
        if (raced) return { order: raced, processing: raced.status === OrderStatus.pending, replayed: true };
      }
      const order = await tx.order.create({ data: {
        buyerId, simulatedCardId: dto.simulatedCardId, deliveryAddress: dto.deliveryAddress, currency: dto.currency ?? 'COP', totalAmount: total, idempotencyKey: dto.idempotencyKey,
        items: { create: resolved.map((item) => ({ productId: item.productId, producerId: item.producerId, producerName: item.producerName, productName: item.productName, quantity: item.quantity, unitPrice: item.unitPrice, subtotal: new Prisma.Decimal(item.quantity).times(new Prisma.Decimal(item.unitPrice)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP), priceVersionId: item.priceVersionId })) },
      }, include: { items: true } });
      await tx.outboxEvent.create({ data: { eventType: 'order.created', aggregateId: order.id, correlationId, payload: {
        checkout_mode: 'async_saga', order_id: order.id, buyer_id: buyerId, simulated_card_id: order.simulatedCardId, delivery_address: order.deliveryAddress, total_amount: total.toString(), currency: order.currency,
        items: order.items.map((item) => ({ order_item_id: item.id, product_id: item.productId, producer_id: item.producerId, product_name: item.productName, producer_name: item.producerName, quantity_kg: item.quantity.toString(), unit_price: item.unitPrice.toString(), subtotal: item.subtotal.toString() })),
      } } });
      return { order, processing: true, replayed: false };
    });
  }
  async consumeCheckoutSagaEvent(event: EventEnvelope) {
    const orderId = String(event.payload.order_id ?? event.payload.orderId ?? event.entity_id ?? '');
    const buyerId = String(event.payload.buyer_id ?? event.payload.buyerId ?? '');
    if (!isUuid(event.event_id) || !isUuid(orderId)) throw new ConflictException('El evento de checkout no contiene identificadores válidos');
    const expectedSource: Record<string, string> = {
      'inventory.order_reserved': 'inventory-service', 'payment.checkout_authorized': 'payment-service',
      'inventory.checkout_consumed': 'inventory-service', 'inventory.order_reservation_failed': 'inventory-service',
      'inventory.checkout_consumption_failed': 'inventory-service', 'payment.checkout_authorization_rejected': 'payment-service',
      'payment.voided': 'payment-service',
    };
    if (expectedSource[event.event_type] !== event.source_service) throw new ConflictException('El origen del evento de checkout no es confiable');
    return this.prisma.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { eventId: event.event_id } })) return tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order) throw new NotFoundException('Pedido de checkout no encontrado');
      if (buyerId && order.buyerId !== buyerId) throw new ConflictException('El comprador del evento no coincide con el pedido');
      let changed = order;
      if (event.event_type === 'inventory.order_reserved' && order.status === OrderStatus.pending) {
        const lines = Array.isArray(event.payload.items) ? event.payload.items as Array<Record<string, unknown>> : [];
        if (lines.length !== order.items.length || new Set(lines.map((line) => String(line.order_item_id ?? ''))).size !== order.items.length) throw new ConflictException('Las reservas no coinciden con las líneas del pedido');
        const itemsById = new Map(order.items.map((item) => [item.id, item]));
        for (const line of lines) {
          const itemId = String(line.order_item_id ?? ''); const item = itemsById.get(itemId);
          const reservationId = String(line.reservation_id ?? ''); const batchId = String(line.harvest_batch_id ?? ''); const farmId = String(line.farm_id ?? '');
          const quantity = new Prisma.Decimal(String(line.quantity_kg ?? 'NaN'));
          if (!item || !isUuid(reservationId) || !isUuid(batchId) || !isUuid(farmId) || !quantity.isFinite() || !item.quantity.equals(quantity) || String(line.product_id ?? '') !== item.productId || typeof line.pickup_address !== 'string' || line.pickup_address.trim().length < 3 || !Number.isFinite(Number(line.pickup_latitude)) || !Number.isFinite(Number(line.pickup_longitude))) throw new ConflictException('Una reserva contiene datos de finca o cantidad inválidos');
          await tx.orderItem.update({ where: { id: item.id }, data: { reservationId, harvestBatchId: batchId, farmId, pickupAddress: String(line.pickup_address), pickupLatitude: Number(line.pickup_latitude), pickupLongitude: Number(line.pickup_longitude) } });
        }
        changed = await tx.order.update({ where: { id: orderId }, data: { checkoutInventoryStatus: 'reserved' }, include: { items: true } });
      } else if (event.event_type === 'payment.checkout_authorized' && order.status === OrderStatus.pending) {
        const paymentId = String(event.payload.payment_id ?? ''); const amount = new Prisma.Decimal(String(event.payload.amount ?? 'NaN'));
        if (!isUuid(paymentId) || !amount.isFinite() || !amount.equals(order.totalAmount) || String(event.payload.currency ?? order.currency) !== order.currency) throw new ConflictException('La autorización no coincide con el total del pedido');
        changed = await tx.order.update({ where: { id: orderId }, data: { paymentId, paymentStatus: PaymentStatus.authorized }, include: { items: true } });
      } else if (event.event_type === 'inventory.checkout_consumed' && order.status === OrderStatus.pending) {
        if (order.items.length === 0 || order.items.some((item) => !item.reservationId)) throw new ConflictException('Inventario consumió un pedido sin reservas completas');
        changed = await tx.order.update({ where: { id: orderId }, data: { checkoutInventoryStatus: 'consumed', inventoryConsumed: true }, include: { items: true } });
      } else if (event.event_type === 'inventory.order_reservation_failed' || event.event_type === 'inventory.checkout_consumption_failed' || event.event_type === 'payment.checkout_authorization_rejected') {
        const reason = String(event.payload.reason ?? 'checkout_saga_failed').slice(0, 180);
        const failed = await tx.order.updateMany({ where: { id: orderId, status: OrderStatus.pending }, data: { status: OrderStatus.cancelled, ...(event.event_type === 'inventory.checkout_consumption_failed' ? { checkoutInventoryStatus: 'failed' } : { checkoutInventoryStatus: 'failed', paymentStatus: PaymentStatus.failed }) } });
        if (failed.count === 1) {
          changed = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
          await tx.outboxEvent.create({ data: { eventType: 'order.cancelled', aggregateId: orderId, correlationId: event.correlation_id, payload: { orderId, buyerId: order.buyerId, paymentId: changed.paymentId, reason } } });
        }
      } else if (event.event_type === 'payment.voided' && order.status === OrderStatus.cancelled && order.paymentId === String(event.payload.payment_id ?? '')) {
        changed = await tx.order.update({ where: { id: orderId }, data: { paymentStatus: PaymentStatus.voided }, include: { items: true } });
      }
      await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
      if (changed.status === OrderStatus.pending && changed.checkoutInventoryStatus === 'consumed' && changed.paymentStatus === PaymentStatus.authorized && changed.paymentId) {
        const claimed = await tx.order.updateMany({ where: { id: orderId, status: OrderStatus.pending, checkoutInventoryStatus: 'consumed', paymentStatus: PaymentStatus.authorized, paymentId: changed.paymentId }, data: { status: OrderStatus.confirmed } });
        if (claimed.count === 1) {
          changed = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
          const cart = await tx.cart.findUnique({ where: { buyerId: changed.buyerId } });
          if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
          await tx.outboxEvent.create({ data: { eventType: 'order.confirmed', aggregateId: orderId, correlationId: event.correlation_id, payload: { orderId, buyerId: changed.buyerId, paymentId: changed.paymentId, status: changed.status, totalAmount: changed.totalAmount.toString(), currency: changed.currency, deliveryAddress: changed.deliveryAddress, items: changed.items.map((item) => ({ id: item.id, productId: item.productId, productName: item.productName, producerId: item.producerId, producerName: item.producerName, reservationId: item.reservationId, harvestBatchId: item.harvestBatchId, farmId: item.farmId, pickupAddress: item.pickupAddress, pickupLatitude: item.pickupLatitude == null ? null : Number(item.pickupLatitude), pickupLongitude: item.pickupLongitude == null ? null : Number(item.pickupLongitude), quantity: item.quantity.toString(), unitPrice: item.unitPrice.toString(), subtotal: item.subtotal.toString() })) } } });
        }
      }
      return changed;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  async checkout(dto: CreateOrderDto, buyerId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}, correlationId: string = randomUUID()) {
    dto.items = aggregateOrderItems(dto.items);
    this.logger.log(`checkout_started buyer=${buyerId} key=${dto.idempotencyKey ?? 'none'}`);
    let order = dto.idempotencyKey
      ? await this.prisma.order.findUnique({ where: { idempotencyKey: dto.idempotencyKey }, include: { items: true } })
      : null;
    if (order?.buyerId !== undefined && order.buyerId !== buyerId) throw new ForbiddenException('El comprador no coincide con el pedido');
    if (order?.status === OrderStatus.cancelled) throw new ConflictException('Este intento de compra fue cancelado; vuelve al carrito para iniciar un pedido nuevo');
    if (order?.status === OrderStatus.confirmed) {
      this.logger.log(`checkout_replayed_confirmed order=${order.id}`);
      return { order, replayed: true };
    }
    if (!order) {
      order = await this.create(dto, buyerId, bearer, gatewayUserId, gatewayRoles, upstreams, correlationId);
      this.logger.log(`checkout_order_created order=${order.id}`);
    } else {
      this.logger.warn(`checkout_resuming_pending order=${order.id}`);
    }
    const paymentUrl = this.url(upstreams.payment, 'PAYMENT_SERVICE_URL', 'http://localhost:3006');
    const headers = this.headers(bearer);
    let paymentId: string | undefined;
    let inventoryConsumed = false;
    let paymentRejected = false;
    if (order.items.some((item) => !item.reservationId || !item.harvestBatchId || !item.farmId || !item.pickupAddress || item.pickupLatitude == null || item.pickupLongitude == null)) {
      const reservations = order.items.flatMap((item) => item.reservationId ? [{ reservationId: item.reservationId }] : []);
      await this.release(reservations, bearer, gatewayUserId, gatewayRoles, upstreams);
      await this.prisma.$transaction(async (tx) => {
        const cancelled = await tx.order.update({ where: { id: order!.id }, data: { status: OrderStatus.cancelled, paymentStatus: PaymentStatus.failed }, include: { items: true } });
        await tx.outboxEvent.create({ data: { eventType: 'order.cancelled', aggregateId: cancelled.id, correlationId, payload: { orderId: cancelled.id, buyerId, reason: 'missing_fulfillment_snapshot' } } });
      });
      throw new ConflictException('No se pudo validar la finca de origen de uno de los productos. Se liberó la reserva; contacta al productor para actualizar la ubicación de su cosecha.');
    }
    try {
      let paymentResponse: Response | undefined;
      let paymentFailure: Error | undefined;
      try {
        paymentResponse = await fetch(`${paymentUrl}/api/v1/payments`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-correlation-id': correlationId }, body: JSON.stringify({ orderId: order.id, buyerId, amount: Number(order.totalAmount), simulatedCardId: dto.simulatedCardId, currency: order.currency, idempotencyKey: `payment:${dto.idempotencyKey ?? order.id}` }), signal: AbortSignal.timeout(6000) });
      } catch (error) {
        paymentFailure = error instanceof Error ? error : new Error('No se recibió respuesta del servicio de Pagos');
      }
      let payment: { id?: string; status?: string } | undefined;
      if (paymentResponse && !paymentResponse.ok) {
        // Rechazos de negocio/autenticación son definitivos para este intento:
        // cancelar y liberar evita retener inventario 15 minutos. Timeouts,
        // throttling y errores 5xx quedan pendientes para reintentar con la
        // misma clave idempotente, pues el upstream pudo haber autorizado.
        const retryableClientStatuses = [408, 425, 429];
        if (paymentResponse.status >= 400 && paymentResponse.status < 500 && !retryableClientStatuses.includes(paymentResponse.status)) {
          paymentRejected = true;
          const cancelled = await this.cancelPendingOrder(order.id, buyerId, correlationId, 'payment_authorization_rejected');
          if (cancelled) {
            const reservations = order.items.flatMap((item) => item.reservationId ? [{ reservationId: item.reservationId }] : []);
            await this.release(reservations, bearer, gatewayUserId, gatewayRoles, upstreams);
          }
          throw new ConflictException('El pago simulado no pudo completarse. Verifica el saldo común y que la tarjeta siga activa; vuelve a intentarlo con un pedido nuevo.');
        }
        paymentFailure = new Error(await paymentResponse.text());
      }
      if (paymentResponse?.ok) {
        try { payment = await paymentResponse.json() as { id?: string; status?: string }; }
        catch (error) { paymentFailure = error instanceof Error ? error : new Error('La respuesta de Pagos no es válida'); }
      }
      if (!payment?.id) {
        // El POST pudo haber hecho commit aunque su respuesta se perdiera.
        // Consultar por orderId recupera esa autorización sin volver a debitar.
        payment = await this.findAuthorizedPayment(paymentUrl, order.id, bearer, gatewayUserId, gatewayRoles, correlationId) ?? undefined;
      }
      if (!payment?.id) throw paymentFailure ?? new Error('Pagos no devolvió el identificador de la autorización');
      paymentId = payment.id;
      if (payment.status !== 'authorized') throw new ConflictException('La autorización anterior ya no está vigente; confirma de nuevo el carrito para crear un pedido nuevo');
      this.logger.log(`checkout_payment_authorized order=${order.id} payment=${String(payment?.id ?? 'unknown')}`);
      const reservations = order.items.map((item) => ({ reservationId: item.reservationId!, productId: item.productId, quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) }));
      await this.consume(reservations, bearer, gatewayUserId, gatewayRoles, upstreams);
      inventoryConsumed = true;
      this.logger.log(`checkout_inventory_consumed order=${order.id}`);
      const confirmed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.confirmed, paymentStatus: PaymentStatus.authorized }, include: { items: true } });
        const cart = await tx.cart.findUnique({ where: { buyerId } });
        if (cart) await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await tx.outboxEvent.create({ data: { eventType: 'order.confirmed', aggregateId: updated.id, correlationId, payload: { orderId: updated.id, buyerId, paymentId: payment.id, status: updated.status, totalAmount: updated.totalAmount.toString(), currency: updated.currency, deliveryAddress: updated.deliveryAddress, items: updated.items.map((item) => ({ id: item.id, productId: item.productId, productName: item.productName, producerId: item.producerId, producerName: item.producerName, reservationId: item.reservationId, harvestBatchId: item.harvestBatchId, farmId: item.farmId, pickupAddress: item.pickupAddress, pickupLatitude: item.pickupLatitude == null ? null : Number(item.pickupLatitude), pickupLongitude: item.pickupLongitude == null ? null : Number(item.pickupLongitude), quantity: item.quantity.toString(), unitPrice: item.unitPrice.toString(), subtotal: item.subtotal.toString() })) } } });
        return updated;
      });
      this.logger.log(`checkout_confirmed order=${confirmed.id}`);
      return { order: confirmed, payment };
    } catch (error) {
      this.logger.error(`checkout_failed order=${order.id} reason=${(error as Error).message}`);
      if (paymentRejected) throw error;
      // Si el consumo atómico fue rechazado, compensar la autorización antes
      // de cerrar el pedido. Si la respuesta se perdió tras confirmar consumo,
      // conservar pago/pedido permite reintentar por las claves idempotentes.
      if (paymentId && !inventoryConsumed && error instanceof ConflictException) {
        let compensated = false;
        try {
          const voided = await fetch(`${paymentUrl}/api/v1/payments/${paymentId}/void`, {
            method: 'PATCH', headers: { ...headers, 'x-internal-api-key': process.env.INTERNAL_API_KEY ?? '', 'x-correlation-id': correlationId },
            signal: AbortSignal.timeout(6000),
          });
          if (!voided.ok) throw new Error(`No se pudo anular el pago: ${await voided.text()}`, { cause: error });
          const reservations = order.items.map((item) => ({ reservationId: item.reservationId! }));
          await this.release(reservations, bearer, gatewayUserId, gatewayRoles, upstreams);
          await this.prisma.$transaction(async (tx) => {
            const cancelled = await tx.order.update({ where: { id: order!.id }, data: { status: OrderStatus.cancelled, paymentStatus: PaymentStatus.voided }, include: { items: true } });
            await tx.outboxEvent.create({ data: { eventType: 'order.cancelled', aggregateId: cancelled.id, correlationId, payload: { orderId: cancelled.id, buyerId, paymentId, reason: 'inventory_reservation_invalid' } } });
          });
          compensated = true;
        } catch (compensationError) {
          this.logger.error(`checkout_compensation_pending order=${order.id} payment=${paymentId} reason=${(compensationError as Error).message}`);
        }
        if (compensated) throw new ConflictException('La reserva venció o cambió. El saldo fue liberado; vuelve a confirmar el carrito para intentarlo de nuevo.');
      }
      throw new BadGatewayException(`No se pudo completar el pago: ${(error as Error).message}`);
    }
  }
  async updateStatus(id: string, status: OrderStatus) {
    const order = await this.get(id);
    if (order.status === status) return order;
    throw new ConflictException('El estado se actualiza mediante checkout, despacho y recepción. No se permite saltar el flujo de entrega.');
  }
  async consumeDeliveryInTransit(event: EventEnvelope) {
    if (event.source_service !== 'logistics-service' || event.event_type !== 'delivery.in_transit') throw new ConflictException('Evento de despacho no confiable');
    const orderId = String(event.payload?.order_id ?? '');
    if (!isUuid(orderId)) throw new ConflictException('Pedido inválido en despacho');
    // A delayed/repeated dispatch must never regress a final order.
    return this.prisma.order.updateMany({ where: { id: orderId, status: 'confirmed' }, data: { status: 'dispatched' } });
  }
  async consumeFulfillmentClosed(event: EventEnvelope) {
    if (event.source_service !== 'logistics-service' || event.event_type !== 'order.fulfillment_closed') throw new ConflictException('Evento de cierre de entrega no confiable');
    const orderId = String(event.payload?.order_id ?? '');
    if (!isUuid(orderId) || !isUuid(event.event_id)) throw new ConflictException('El cierre no contiene identificadores válidos');
    const lines = Array.isArray(event.payload.items) ? event.payload.items as Array<Record<string, unknown>> : [];
    if (!lines.length) throw new ConflictException('El cierre no contiene líneas de entrega');
    const accepted = lines.reduce((sum, line) => sum.plus(new Prisma.Decimal(String(line.accepted_quantity_kg ?? 'NaN'))), new Prisma.Decimal(0));
    const ordered = lines.reduce((sum, line) => sum.plus(new Prisma.Decimal(String(line.quantity_ordered_kg ?? 'NaN'))), new Prisma.Decimal(0));
    if (!accepted.isFinite() || !ordered.isFinite() || ordered.lte(0) || accepted.lt(0) || accepted.gt(ordered)) throw new ConflictException('Las cantidades aceptadas del cierre son inválidas');
    const settledAmount = new Prisma.Decimal(String(event.payload.accepted_amount ?? 'NaN'));
    const eventLines = lines.map((line) => ({
      id: String(line.order_item_id ?? ''),
      ordered: new Prisma.Decimal(String(line.quantity_ordered_kg ?? 'NaN')),
      accepted: new Prisma.Decimal(String(line.accepted_quantity_kg ?? 'NaN')),
      amount: new Prisma.Decimal(String(line.accepted_amount ?? 'NaN')),
    }));
    if (!settledAmount.isFinite() || settledAmount.isNegative() || eventLines.some((line) => !isUuid(line.id) || !line.ordered.isFinite() || !line.accepted.isFinite() || !line.amount.isFinite() || line.amount.isNegative()) || new Set(eventLines.map((line) => line.id)).size !== eventLines.length) throw new ConflictException('El detalle aceptado del cierre es inválido');
    if (!eventLines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0)).equals(settledAmount)) throw new ConflictException('El total liquidado no coincide con los importes aceptados por línea');
    const status = accepted.isZero() ? OrderStatus.cancelled : accepted.lt(ordered) ? OrderStatus.partial : OrderStatus.delivered;
    const paymentStatus = accepted.isZero() ? PaymentStatus.voided : PaymentStatus.captured;
    return this.prisma.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { eventId: event.event_id } })) return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order) throw new NotFoundException('Pedido del evento de entrega no encontrado');
      if (settledAmount.gt(order.totalAmount) || eventLines.length !== order.items.length) throw new ConflictException('El cierre no coincide con el total o las líneas del pedido');
      const orderItems = new Map(order.items.map((item) => [item.id, item]));
      for (const line of eventLines) {
        const item = orderItems.get(line.id);
        if (!item || !item.quantity.equals(line.ordered) || line.accepted.gt(item.quantity) || line.accepted.isNegative()) throw new ConflictException('Las cantidades aceptadas no coinciden con las líneas compradas');
        const expectedAmount = line.accepted.times(item.unitPrice).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        if (!expectedAmount.equals(line.amount)) throw new ConflictException('El importe aceptado no coincide con el precio del pedido');
      }
      if (order.status !== OrderStatus.confirmed && order.status !== OrderStatus.dispatched) {
        if (order.status === status) {
          await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
          return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
        }
        throw new ConflictException('El pedido ya tuvo una transición distinta al cierre logístico');
      }
      for (const line of eventLines) await tx.orderItem.update({ where: { id: line.id }, data: { acceptedQuantity: line.accepted, acceptedSubtotal: line.amount } });
      const updated = await tx.order.update({ where: { id: orderId }, data: { status, paymentStatus, settledAmount }, include: { items: true } });
      await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
      return updated;
    });
  }
  async rate(orderId: string, buyerId: string, dto: CreateOrderRatingDto, correlationId: string = randomUUID()) {
    const comment = dto.comment?.trim() || null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId }, select: { buyerId: true, status: true, paymentStatus: true, items: { select: { acceptedQuantity: true, acceptedSubtotal: true } } } });
        if (!order) throw new NotFoundException('Pedido no encontrado');
        if (order.buyerId !== buyerId) throw new ForbiddenException('Solo el comprador puede calificar este pedido');
        if (!['delivered', 'partial'].includes(order.status) || order.paymentStatus !== 'captured' || !order.items.some((item) => item.acceptedQuantity?.gt(0) && item.acceptedSubtotal?.gt(0))) throw new ConflictException('Solo se pueden calificar pedidos entregados con productos aceptados y pagados');
        const existing = await tx.orderRating.findUnique({ where: { orderId } });
        if (existing) {
          if (existing.buyerId === buyerId && existing.score === dto.score && existing.comment === comment) return { rating: existing, replayed: true };
          throw new ConflictException('Este pedido ya fue calificado');
        }
        const rating = await tx.orderRating.create({ data: { orderId, buyerId, score: dto.score, comment } });
        await tx.outboxEvent.create({ data: { eventType: 'rating.created', routingKey: 'rating.created', aggregateId: rating.id, entityVersion: 1, schemaVersion: 1, correlationId, payload: { rating_id: rating.id, order_id: orderId, buyer_id: buyerId, score: rating.score, comment: rating.comment, created_at: rating.createdAt.toISOString() } } });
        return { rating, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isRatingRace(error)) throw error;
      const existing = await this.prisma.orderRating.findUnique({ where: { orderId } });
      if (existing && existing.buyerId === buyerId && existing.score === dto.score && existing.comment === comment) return { rating: existing, replayed: true };
      if (existing) throw new ConflictException('Este pedido ya fue calificado');
      throw error;
    }
  }
  async getRating(orderId: string, buyerId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { buyerId: true } });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    if (order.buyerId !== buyerId) throw new ForbiddenException('Solo el comprador puede consultar esta calificación');
    return this.prisma.orderRating.findUnique({ where: { orderId }, select: { score: true, comment: true, createdAt: true } });
  }
  getCart(buyerId: string) { return this.prisma.cart.findUnique({ where: { buyerId }, include: { items: true } }); }
  upsertCart(buyerId: string, dto: UpsertCartDto) { return this.prisma.cart.upsert({ where: { buyerId }, create: { buyerId, items: { create: dto.items } }, update: { items: { deleteMany: {}, create: dto.items } }, include: { items: true } }); }
  clearCart(buyerId: string) { return this.prisma.cart.update({ where: { buyerId }, data: { items: { deleteMany: {} } }, include: { items: true } }); }
  private headers(bearer: string) { return { authorization: `Bearer ${bearer}` }; }
  private async findAuthorizedPayment(paymentUrl: string, orderId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string, correlationId?: string) {
    try {
      const response = await fetch(`${paymentUrl}/api/v1/payments/by-order/${orderId}`, { headers: { ...this.headers(bearer), ...(correlationId ? { 'x-correlation-id': correlationId } : {}) }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const payment = await response.json() as { id?: string; status?: string };
      return payment.id && payment.status === 'authorized' ? payment : null;
    } catch (error) {
      this.logger.warn(`payment_recovery_lookup_failed order=${orderId} reason=${(error as Error).message}`);
      return null;
    }
  }
  private async cancelPendingOrder(orderId: string, buyerId: string, correlationId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.order.updateMany({ where: { id: orderId, status: OrderStatus.pending, paymentStatus: PaymentStatus.pending }, data: { status: OrderStatus.cancelled, paymentStatus: PaymentStatus.failed } });
      if (changed.count !== 1) return false;
      await tx.outboxEvent.create({ data: { eventType: 'order.cancelled', aggregateId: orderId, correlationId, payload: { orderId, buyerId, reason } } });
      return true;
    });
  }
  private url(fromGateway: string | undefined, variable: string, fallback: string) { return (fromGateway || process.env[variable] || fallback).replace(/\/+$/, ''); }
  private async producerIdForUser(userId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}) {
    const producerUrl = this.url(upstreams.producer, 'PRODUCER_SERVICE_URL', 'http://localhost:3001');
    const response = await fetch(`${producerUrl}/producers/by-user/${userId}`, { headers: this.headers(bearer), signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new ForbiddenException('No se pudo comprobar el perfil de productor');
    const producer = await response.json() as { id?: string };
    if (!producer.id) throw new ForbiddenException('No existe un perfil de productor para esta cuenta');
    return producer.id;
  }
  private async productBelongsToProducer(productId: string, producerId: string, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}) {
    const catalogUrl = this.url(upstreams.catalog, 'CATALOG_SERVICE_URL', 'http://localhost:3002');
    const response = await fetch(`${catalogUrl}/products/${productId}`, { headers: this.headers(bearer), signal: AbortSignal.timeout(6000) });
    if (!response.ok) return false;
    const product = await response.json() as { producer_id?: string };
    return product.producer_id === producerId;
  }
  private async release(items: Array<{ reservationId: string }>, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}) {
    const url = this.url(upstreams.inventory, 'INVENTORY_SERVICE_URL', 'http://localhost:3004');
    const results = await Promise.allSettled(items.map((item) => fetch(`${url}/inventory/reservations/${item.reservationId}/release`, { method: 'POST', headers: this.headers(bearer), signal: AbortSignal.timeout(4000) })));
    const failures = results.filter((result) => result.status === 'rejected' || !result.value.ok);
    if (failures.length) this.logger.error(`reservation_release_failed count=${failures.length} total=${items.length}`);
  }
  private async consume(items: Array<{ reservationId: string }>, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}) { const url = this.url(upstreams.inventory, 'INVENTORY_SERVICE_URL', 'http://localhost:3004'); const r = await fetch(`${url}/inventory/reservations/consume-batch`, { method: 'POST', headers: { ...this.headers(bearer), 'content-type': 'application/json' }, body: JSON.stringify({ reservation_ids: items.map((item) => item.reservationId) }), signal: AbortSignal.timeout(8000) }); if (!r.ok) { const message = await r.text(); if (r.status >= 400 && r.status < 500) throw new ConflictException('Una reserva del carrito venció o ya no está disponible'); throw new BadGatewayException(`Inventario no pudo confirmar la salida: ${message}`); } }
  private async resolveItems(dto: CreateOrderDto, bearer: string, gatewayUserId?: string, gatewayRoles?: string, upstreams: CheckoutUpstreams = {}) {
    const catalogUrl = this.url(upstreams.catalog, 'CATALOG_SERVICE_URL', 'http://localhost:3002');
    return Promise.all(dto.items.map(async (item) => { const r = await fetch(`${catalogUrl}/products/${item.productId}`, { headers: this.headers(bearer), signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new BadGatewayException('No se pudo validar el producto y su precio'); const product = await r.json() as { active: boolean; price: number | null; price_version_id: string | null; producer_id: string; producer_name?: string | null; name: string; min_order_quantity: number }; if (!product.active || product.price === null) throw new ConflictException('El producto ya no está disponible'); if (item.quantity < Number(product.min_order_quantity)) throw new ConflictException(`La cantidad mínima para ${product.name} no se cumple`); return { productId: item.productId, producerId: product.producer_id, producerName: product.producer_name ?? null, quantity: item.quantity, unitPrice: Number(product.price), priceVersionId: product.price_version_id ?? undefined, productName: product.name }; }));
  }
}

function isRatingRace(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && ['P2002', 'P2034'].includes(String((error as { code?: string }).code))); }

function reservationIdempotencyKey(key: string, buyerId: string, productId: string): string {
  return `checkout:${createHash('sha256').update(`${key}:${buyerId}:${productId}`).digest('hex')}`;
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }

function toJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  throw new TypeError('El evento contiene un valor que no se puede serializar a JSON');
}

export function aggregateOrderItems<T extends { productId: string; quantity: number }>(items: T[]): T[] {
  const byProduct = new Map<string, T>();
  for (const item of items) {
    const previous = byProduct.get(item.productId);
    byProduct.set(item.productId, previous ? { ...previous, quantity: previous.quantity + item.quantity } : { ...item });
  }
  return [...byProduct.values()];
}
