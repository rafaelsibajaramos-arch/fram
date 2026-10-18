import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InventoryItem, Prisma, Reservation } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { ReceiveDto, ReserveDto, WasteDto } from './dto';
import { DomainEvent, EventsService } from './events.service';

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(private db: PrismaService, private events: EventsService) {}

  onModuleInit(): void {
    this.events.register('inventory-service.harvest', ['harvest.registered'], async (event) => { await this.receiveHarvest(event); });
    this.events.register('inventory-service.checkout', ['order.created', 'payment.checkout_authorized', 'order.cancelled'], async (event) => {
      if (event.event_type === 'order.created') await this.reserveCheckoutOrder(event);
      else if (event.event_type === 'payment.checkout_authorized') await this.consumeCheckoutOrder(event);
      else await this.releaseCheckoutOrder(event);
    });
  }

  async reserveCheckoutOrder(event: DomainEvent) {
    if (event.source_service !== 'order-service' || event.event_type !== 'order.created') throw new BadRequestException('Solicitud de checkout no confiable');
    // The legacy synchronous checkout also emits order.created after reserving
    // inventory. Only the explicitly tagged saga event may reserve stock here.
    if (event.payload.checkout_mode !== 'async_saga') return { ignored: true };
    const orderId = String(event.payload.order_id ?? '');
    const buyerId = String(event.payload.buyer_id ?? '');
    const lines = Array.isArray(event.payload.items) ? event.payload.items as Array<Record<string, unknown>> : [];
    if (!isUuid(event.event_id) || !isUuid(orderId) || !isUuid(buyerId) || !lines.length) throw new BadRequestException('Solicitud de checkout incompleta');
    const existing = await this.db.processedEvent.findUnique({ where: { eventId: event.event_id } });
    if (existing) return { duplicate: true };
    const reservations: Array<Record<string, unknown>> = [];
    try {
      for (const line of lines) {
        const orderItemId = String(line.order_item_id ?? '');
        const productId = String(line.product_id ?? '');
        const quantity = Number(line.quantity_kg);
        if (!isUuid(orderItemId) || !isUuid(productId) || !Number.isFinite(quantity) || quantity <= 0) throw new BadRequestException('Línea de checkout inválida');
        const result = await this.reserve({ product_id: productId, quantity_kg: quantity, idempotency_key: `saga:${orderId}:${orderItemId}`, order_id: orderId, order_item_id: orderItemId }, buyerId, event.correlation_id);
        // A redelivery can encounter an idempotency key whose reservation was
        // released before the previous consumer crashed. Never publish a
        // successful saga result containing a stale, non-active reservation.
        if (result.reservation.status !== 'active') throw new ConflictException('La reserva idempotente ya no está activa');
        reservations.push({ order_item_id: orderItemId, reservation_id: result.reservation.id, product_id: productId, quantity_kg: String(quantity), subtotal: String(line.subtotal ?? ''), harvest_batch_id: result.stock.batch_id, farm_id: result.stock.farm_id, pickup_address: result.stock.pickup_address, pickup_latitude: result.stock.pickup_latitude, pickup_longitude: result.stock.pickup_longitude });
      }
      await this.recordCheckoutEvent(event, 'inventory.order_reserved', { order_id: orderId, buyer_id: buyerId, simulated_card_id: String(event.payload.simulated_card_id ?? ''), total_amount: String(event.payload.total_amount ?? ''), currency: String(event.payload.currency ?? 'COP'), items: reservations });
      return { reserved: true, items: reservations };
    } catch (error) {
      if (!(error instanceof BadRequestException || error instanceof ConflictException)) throw error;
      await this.releaseCheckoutReservations(orderId, buyerId, event.correlation_id);
      await this.recordCheckoutEvent(event, 'inventory.order_reservation_failed', { order_id: orderId, buyer_id: buyerId, reason: error.message });
      return { reserved: false, reason: error.message };
    }
  }

  async consumeCheckoutOrder(event: DomainEvent) {
    if (event.source_service !== 'payment-service' || event.event_type !== 'payment.checkout_authorized') throw new BadRequestException('Autorización de checkout no confiable');
    const orderId = String(event.payload.order_id ?? '');
    const buyerId = String(event.payload.buyer_id ?? '');
    if (!isUuid(event.event_id) || !isUuid(orderId) || !isUuid(buyerId)) throw new BadRequestException('Autorización de checkout incompleta');
    if (await this.db.processedEvent.findUnique({ where: { eventId: event.event_id } })) return { duplicate: true };
    try {
      const reservations = await this.db.reservation.findMany({ where: { orderId }, orderBy: { orderItemId: 'asc' } });
      if (!reservations.length || reservations.some((reservation) => reservation.buyerId !== buyerId)) throw new ConflictException('No existen reservas del comprador para este pedido');
      await this.consumeBatch(reservations.map((reservation) => reservation.id), buyerId, event.correlation_id);
      await this.recordCheckoutEvent(event, 'inventory.checkout_consumed', { order_id: orderId, buyer_id: buyerId });
      return { consumed: true };
    } catch (error) {
      if (!(error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException)) throw error;
      await this.releaseCheckoutReservations(orderId, buyerId, event.correlation_id);
      await this.recordCheckoutEvent(event, 'inventory.checkout_consumption_failed', { order_id: orderId, buyer_id: buyerId, reason: error.message });
      return { consumed: false, reason: error.message };
    }
  }

  async releaseCheckoutOrder(event: DomainEvent) {
    if (event.source_service !== 'order-service' || event.event_type !== 'order.cancelled') throw new BadRequestException('Cancelación de pedido no confiable');
    const orderId = String(event.payload.orderId ?? event.payload.order_id ?? '');
    const buyerId = String(event.payload.buyerId ?? event.payload.buyer_id ?? '');
    if (!isUuid(event.event_id) || !isUuid(orderId) || !isUuid(buyerId)) throw new BadRequestException('Cancelación de pedido incompleta');
    if (await this.db.processedEvent.findUnique({ where: { eventId: event.event_id } })) return { duplicate: true };
    await this.releaseCheckoutReservations(orderId, buyerId, event.correlation_id);
    await this.db.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: orderId } });
    return { released: true };
  }

  private async releaseCheckoutReservations(orderId: string, buyerId: string, correlationId: string) {
    const reservations = await this.db.reservation.findMany({ where: { orderId, buyerId, status: 'active' } });
    for (const reservation of reservations) await this.release(reservation.id, buyerId, correlationId);
  }

  private async recordCheckoutEvent(source: DomainEvent, eventType: string, payload: Record<string, unknown>) {
    await this.db.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { eventId: source.event_id } })) return;
      await tx.processedEvent.create({ data: { eventId: source.event_id, eventType: source.event_type, sourceService: source.source_service, entityId: String(source.payload.order_id), entityVersion: source.entity_version } });
      await this.enqueueEvent(tx, { eventType, entityId: String(source.payload.order_id), entityVersion: source.entity_version, correlationId: source.correlation_id, payload });
    });
  }

  async receiveHarvest(event: DomainEvent) {
    const payload = event.payload;
    const batchId = String(payload.batch_id ?? '');
    const productId = String(payload.product_id ?? '');
    const quantity = new Prisma.Decimal(String(payload.quantity_kg ?? '0'));
    const expiryEstimate = parseExpiry(payload.expiry_estimate);
    if (!batchId || !productId || quantity.lte(0)) throw new BadRequestException('harvest.registered incompleto');
    return this.db.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { eventId: event.event_id } })) return { duplicate: true };
      const farmId = optionalUuid(payload.farm_id);
      const pickupAddress = optionalText(payload.pickup_address);
      const pickupLatitude = finiteCoordinate(payload.pickup_latitude, -90, 90);
      const pickupLongitude = finiteCoordinate(payload.pickup_longitude, -180, 180);
      const item = await tx.inventoryItem.upsert({ where: { batchId }, create: { batchId, productId, farmId, pickupAddress, pickupLatitude, pickupLongitude, expiryEstimate, physicalKg: quantity, availableKg: quantity }, update: {} });
      await this.recordMovement(tx, item, 'entry', quantity, event.event_id, event.correlation_id);
      await tx.processedEvent.create({ data: { eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: batchId, entityVersion: event.entity_version } });
      await this.enqueueStock(tx, item, event.correlation_id);
      return this.view(item);
    });
  }

  async receive(d: ReceiveDto, correlationId: string = randomUUID()) {
    const quantity = new Prisma.Decimal(d.quantity_kg);
    return this.db.$transaction(async (tx) => {
      const item = await tx.inventoryItem.upsert({ where: { batchId: d.batch_id }, create: { batchId: d.batch_id, productId: d.product_id, expiryEstimate: farFuture(), physicalKg: quantity, availableKg: quantity }, update: { physicalKg: { increment: quantity }, availableKg: { increment: quantity }, stockVersion: { increment: 1 } } });
      await this.recordMovement(tx, item, 'entry', quantity, correlationId, correlationId);
      await this.enqueueStock(tx, item, correlationId);
      return this.view(item);
    });
  }

  async byProduct(productId: string) {
    await this.expireDue();
    const items = await this.db.inventoryItem.findMany({ where: { productId }, include: { reservations: { where: { status: 'active' } } }, orderBy: [{ expiryEstimate: 'asc' }, { id: 'asc' }] });
    return items.map((item) => this.view(item));
  }

  async reserve(d: ReserveDto, buyerId: string, correlationId: string = randomUUID()) {
    await this.expireDue();
    const quantity = new Prisma.Decimal(d.quantity_kg);
    const idempotencyKey = d.idempotency_key?.trim() || randomUUID();
    const previous = await this.db.reservation.findUnique({ where: { idempotencyKey }, include: { item: true } });
    if (previous) return this.replayReservation(previous, buyerId, d.product_id, quantity);
    let outcome: { insufficient: true } | { insufficient: false; reservation: Reservation; stock: InventoryItem };
    try { outcome = await this.db.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findFirst({ where: { productId: d.product_id, status: 'available', expiryEstimate: { gte: new Date() }, availableKg: { gte: quantity } }, orderBy: [{ expiryEstimate: 'asc' }, { id: 'asc' }] });
      if (!item) return { insufficient: true as const };
      const updated = await tx.inventoryItem.updateMany({ where: { id: item.id, availableKg: { gte: quantity } }, data: { availableKg: { decrement: quantity }, stockVersion: { increment: 1 } } });
      if (updated.count !== 1) throw new ConflictException('El stock cambio; intente de nuevo');
      const stock = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      const reservation = await tx.reservation.create({ data: { itemId: item.id, buyerId, orderId: d.order_id, orderItemId: d.order_item_id, idempotencyKey, quantityKg: quantity, expiresAt: new Date(Date.now() + 15 * 60_000) } });
      await this.enqueueEvent(tx, { eventType: 'inventory.reserved', entityId: reservation.id, entityVersion: Number(stock.stockVersion), correlationId, payload: { reservation_id: reservation.id, lot_id: item.id, harvest_batch_id: item.batchId, farm_id: item.farmId, pickup_address: item.pickupAddress, pickup_latitude: item.pickupLatitude?.toString() ?? null, pickup_longitude: item.pickupLongitude?.toString() ?? null, product_id: item.productId, buyer_id: buyerId, quantity_kg: quantity.toString(), expires_at: reservation.expiresAt.toISOString() } });
      await this.enqueueStock(tx, stock, correlationId);
      return { insufficient: false as const, reservation, stock };
    }); } catch (error) {
      // Concurrent deliveries of the same checkout key race on the unique
      // index; the losing transaction rolls stock back and replays the winner.
      if (isUniqueViolation(error)) {
        const concurrent = await this.db.reservation.findUnique({ where: { idempotencyKey }, include: { item: true } });
        if (concurrent) return this.replayReservation(concurrent, buyerId, d.product_id, quantity);
      }
      throw error;
    }
    if (outcome.insufficient) {
      await this.db.outboxEvent.create({ data: { eventType: 'inventory.insufficient', routingKey: 'inventory.insufficient', entityId: d.product_id, entityVersion: 0, correlationId, payload: { product_id: d.product_id, buyer_id: buyerId, requested_kg: quantity.toString(), reason: 'insufficient_available_stock' } } });
      throw new BadRequestException('Stock insuficiente');
    }
    return { reservation: this.reservationView(outcome.reservation), stock: this.view(outcome.stock) };
  }

  async release(id: string, buyerId: string, correlationId: string = randomUUID()) {
    return this.db.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({ where: { id } });
      if (!reservation) throw new NotFoundException('Reserva inexistente');
      if (reservation.buyerId !== buyerId) throw new ConflictException('La reserva pertenece a otro comprador');
      if (reservation.status !== 'active') return this.reservationView(reservation);
      const claimed = await tx.reservation.updateMany({ where: { id, status: 'active' }, data: { status: 'released' } });
      if (claimed.count !== 1) return this.reservationView(await tx.reservation.findUniqueOrThrow({ where: { id } }));
      const stock = await tx.inventoryItem.update({ where: { id: reservation.itemId }, data: { availableKg: { increment: reservation.quantityKg }, stockVersion: { increment: 1 } } });
      const released = await tx.reservation.findUniqueOrThrow({ where: { id } });
      await this.enqueueReleased(tx, released, stock, 'released_by_buyer', correlationId);
      await this.enqueueStock(tx, stock, correlationId);
      return this.reservationView(released);
    });
  }

  async consume(id: string, buyerId: string, correlationId: string = randomUUID()) {
    return this.db.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({ where: { id } });
      if (!reservation) throw new NotFoundException('Reserva inexistente');
      if (reservation.buyerId !== buyerId) throw new ConflictException('La reserva pertenece a otro comprador');
      // La confirmación puede reintentarse si la red perdió la respuesta. Una
      // reserva ya consumida es el resultado correcto y no descuenta stock otra vez.
      if (reservation.status === 'consumed') return this.reservationView(reservation);
      if (reservation.status !== 'active') throw new ConflictException('La reserva no esta activa');
      const claimed = await tx.reservation.updateMany({ where: { id, status: 'active', expiresAt: { gt: new Date() } }, data: { status: 'consumed' } });
      if (claimed.count !== 1) throw new ConflictException('La reserva no esta activa o ya expiró');
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: reservation.itemId } });
      if (item.physicalKg.lessThan(reservation.quantityKg)) throw new ConflictException('El lote no tiene existencias fisicas suficientes');
      const stock = await tx.inventoryItem.update({ where: { id: item.id }, data: { physicalKg: { decrement: reservation.quantityKg }, stockVersion: { increment: 1 }, status: item.physicalKg.equals(reservation.quantityKg) ? 'depleted' : item.status } });
      const consumed = await tx.reservation.findUniqueOrThrow({ where: { id } });
      await this.recordMovement(tx, item, 'dispatch', reservation.quantityKg, reservation.id, correlationId);
      await this.enqueueStock(tx, stock, correlationId);
      return this.reservationView(consumed);
    });
  }

  /** Consume every reservation for an order atomically, preventing a partial
   * multi-product dispatch if one line expired or changed concurrently. */
  async consumeBatch(ids: string[], buyerId: string, correlationId: string = randomUUID()) {
    const uniqueIds = [...new Set(ids)].sort();
    if (!uniqueIds.length || uniqueIds.length !== ids.length) throw new BadRequestException('Las reservas del pedido son inválidas');
    return this.db.$transaction(async (tx) => {
      const reservations = await tx.reservation.findMany({ where: { id: { in: uniqueIds } }, include: { item: true } });
      if (reservations.length !== uniqueIds.length) throw new NotFoundException('Una o más reservas no existen');
      if (reservations.some((reservation) => reservation.buyerId !== buyerId)) throw new ConflictException('Una reserva pertenece a otro comprador');
      if (reservations.every((reservation) => reservation.status === 'consumed')) {
        return { consumed: true, replayed: true, reservations: reservations.map((reservation) => this.reservationView(reservation)) };
      }
      if (reservations.some((reservation) => reservation.status !== 'active')) throw new ConflictException('El pedido tiene reservas vencidas, liberadas o parcialmente consumidas');

      const consumed = [];
      const now = new Date();
      for (const reservation of reservations) {
        const claimed = await tx.reservation.updateMany({ where: { id: reservation.id, status: 'active', expiresAt: { gt: now } }, data: { status: 'consumed' } });
        if (claimed.count !== 1) throw new ConflictException('Una reserva del pedido ya venció o fue procesada');
        const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: reservation.itemId } });
        if (item.physicalKg.lessThan(reservation.quantityKg)) throw new ConflictException('El lote no tiene existencias físicas suficientes');
        const stock = await tx.inventoryItem.update({ where: { id: item.id }, data: {
          physicalKg: { decrement: reservation.quantityKg }, stockVersion: { increment: 1 },
          status: item.physicalKg.equals(reservation.quantityKg) ? 'depleted' : item.status,
        } });
        const record = await tx.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        await this.recordMovement(tx, item, 'dispatch', reservation.quantityKg, reservation.id, correlationId);
        await this.enqueueStock(tx, stock, correlationId);
        consumed.push(this.reservationView(record));
      }
      return { consumed: true, replayed: false, reservations: consumed };
    });
  }

  async waste(d: WasteDto, correlationId: string = randomUUID()) {
    const quantity = new Prisma.Decimal(d.quantity_kg);
    return this.db.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findUnique({ where: { id: d.lot_id } });
      if (!item) throw new NotFoundException('Lote de inventario inexistente');
      const duplicate = await tx.inventoryMovement.findUnique({ where: { sourceOperationId: d.operation_id } });
      if (duplicate) return { duplicate: true, movement_id: duplicate.id };
      if (item.availableKg.lessThan(quantity)) throw new ConflictException('La merma afecta existencias reservadas; libere o reasigne las reservas primero');
      const stock = await tx.inventoryItem.update({ where: { id: item.id }, data: { physicalKg: { decrement: quantity }, availableKg: { decrement: quantity }, stockVersion: { increment: 1 }, status: item.physicalKg.equals(quantity) ? 'depleted' : item.status } });
      const movement = await this.recordMovement(tx, item, 'waste', quantity, d.operation_id, correlationId, d.reason);
      await this.enqueueEvent(tx, { eventType: 'inventory.waste_recorded', entityId: movement.id, entityVersion: Number(stock.stockVersion), correlationId, payload: { movement_id: movement.id, lot_id: item.id, harvest_batch_id: item.batchId, product_id: item.productId, quantity_kg: quantity.toString(), reason: d.reason, occurred_at: movement.createdAt.toISOString() } });
      await this.enqueueStock(tx, stock, correlationId);
      return { duplicate: false, movement_id: movement.id, lot_id: item.id, product_id: item.productId, quantity_kg: Number(quantity), reason: d.reason, stock: this.view(stock) };
    });
  }

  async expireDue() {
    const due = await this.db.reservation.findMany({ where: { status: 'active', expiresAt: { lte: new Date() } } });
    for (const reservation of due) await this.db.$transaction(async (tx) => {
      const claimed = await tx.reservation.updateMany({ where: { id: reservation.id, status: 'active', expiresAt: { lte: new Date() } }, data: { status: 'expired' } });
      if (claimed.count !== 1) return;
      const current = reservation;
      const stock = await tx.inventoryItem.update({ where: { id: current.itemId }, data: { availableKg: { increment: current.quantityKg }, stockVersion: { increment: 1 } } });
      const expired = await tx.reservation.findUniqueOrThrow({ where: { id: current.id } });
      const correlationId = randomUUID();
      await this.enqueueReleased(tx, expired, stock, 'expired', correlationId);
      await this.enqueueStock(tx, stock, correlationId);
    });
  }

  private async recordMovement(tx: Prisma.TransactionClient, item: InventoryItem, movementType: 'entry' | 'dispatch' | 'waste', quantity: Prisma.Decimal, sourceOperationId: string, correlationId: string, reason?: 'expiry' | 'damage' | 'cold_chain') {
    const movement = await tx.inventoryMovement.create({ data: { itemId: item.id, movementType, quantityKg: quantity, reason, sourceOperationId } });
    await this.enqueueEvent(tx, { eventType: 'inventory.movement_recorded', entityId: movement.id, entityVersion: Number(item.stockVersion), correlationId, payload: { movement_id: movement.id, lot_id: item.id, harvest_batch_id: item.batchId, product_id: item.productId, movement_type: movementType, quantity_kg: quantity.toString(), reason: reason ?? null, occurred_at: movement.createdAt.toISOString() } });
    return movement;
  }

  private async enqueueReleased(tx: Prisma.TransactionClient, reservation: Reservation, stock: InventoryItem, reason: 'released_by_buyer' | 'expired', correlationId: string) {
    await this.enqueueEvent(tx, { eventType: 'inventory.released', entityId: reservation.id, entityVersion: Number(stock.stockVersion), correlationId, payload: { reservation_id: reservation.id, lot_id: reservation.itemId, buyer_id: reservation.buyerId, quantity_kg: reservation.quantityKg.toString(), reason } });
  }

  private async enqueueStock(tx: Prisma.TransactionClient, item: InventoryItem, correlationId: string) {
    await this.enqueueEvent(tx, { eventType: 'inventory.stock_changed', entityId: item.id, entityVersion: Number(item.stockVersion), correlationId, payload: { product_id: item.productId, stock_version: item.stockVersion.toString(), physical_kg: item.physicalKg.toString(), available_kg: item.availableKg.toString() } });
  }

  private async enqueueEvent(tx: Prisma.TransactionClient, input: { eventType: string; entityId: string; entityVersion: number; correlationId: string; payload: Record<string, unknown> }) {
    await tx.outboxEvent.create({ data: { eventType: input.eventType, routingKey: input.eventType, entityId: input.entityId, entityVersion: input.entityVersion, correlationId: input.correlationId, payload: input.payload as Prisma.InputJsonValue } });
  }

  private view(item: InventoryItem) { return { id: item.id, batch_id: item.batchId, product_id: item.productId, farm_id: item.farmId ?? null, pickup_address: item.pickupAddress ?? null, pickup_latitude: item.pickupLatitude == null ? null : Number(item.pickupLatitude), pickup_longitude: item.pickupLongitude == null ? null : Number(item.pickupLongitude), expiry_estimate: item.expiryEstimate.toISOString().slice(0, 10), status: item.status, physical_kg: Number(item.physicalKg), available_kg: Number(item.availableKg), stock_version: Number(item.stockVersion), created_at: item.createdAt, updated_at: item.updatedAt }; }
  private reservationView(reservation: Reservation) { return { id: reservation.id, item_id: reservation.itemId, buyer_id: reservation.buyerId, quantity_kg: Number(reservation.quantityKg), status: reservation.status, expires_at: reservation.expiresAt, created_at: reservation.createdAt }; }

  private replayReservation(reservation: Prisma.ReservationGetPayload<{ include: { item: true } }>, buyerId: string, productId: string, quantity: Prisma.Decimal) {
    if (reservation.buyerId !== buyerId || reservation.item.productId !== productId || !reservation.quantityKg.equals(quantity)) throw new ConflictException('La clave de idempotencia ya fue usada para otra reserva');
    return { reservation: this.reservationView(reservation), stock: this.view(reservation.item), replayed: true };
  }
}

function parseExpiry(value: unknown): Date { const date = new Date(`${String(value ?? '').slice(0, 10)}T00:00:00.000Z`); if (Number.isNaN(date.getTime())) throw new BadRequestException('harvest.registered requiere expiry_estimate valido'); return date; }
function optionalUuid(value: unknown): string | null { const text = String(value ?? ''); return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text) ? text : null; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function optionalText(value: unknown): string | null { const text = String(value ?? '').trim(); return text.length >= 3 ? text : null; }
function finiteCoordinate(value: unknown, min: number, max: number): Prisma.Decimal | null { const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? new Prisma.Decimal(n) : null; }
function farFuture(): Date { return new Date('9999-12-31T00:00:00.000Z'); }
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002'); }
