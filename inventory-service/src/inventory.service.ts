import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.service';
import { ReceiveDto, ReserveDto, WasteDto } from './dto';
import { DomainEvent, EventsService } from './events.service';

@Injectable()
export class InventoryService implements OnModuleInit {
  constructor(private db: PrismaService, private events: EventsService) {}

  onModuleInit(): void {
    this.events.register('inventory-service.harvest', ['harvest.registered'], async (event) => { await this.receiveHarvest(event); });
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
      const item = await tx.inventoryItem.upsert({ where: { batchId }, create: { batchId, productId, expiryEstimate, physicalKg: quantity, availableKg: quantity }, update: {} });
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
    const existing = await this.db.reservation.findFirst({ where: { buyerId, status: 'active', expiresAt: { gt: new Date() }, quantityKg: { gte: quantity }, item: { productId: d.product_id } }, include: { item: true } });
    if (existing) return { reservation: this.reservationView(existing), stock: this.view(existing.item) };
    const outcome = await this.db.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findFirst({ where: { productId: d.product_id, status: 'available', expiryEstimate: { gte: new Date() }, availableKg: { gte: quantity } }, orderBy: [{ expiryEstimate: 'asc' }, { id: 'asc' }] });
      if (!item) return { insufficient: true as const };
      const updated = await tx.inventoryItem.updateMany({ where: { id: item.id, availableKg: { gte: quantity } }, data: { availableKg: { decrement: quantity }, stockVersion: { increment: 1 } } });
      if (updated.count !== 1) throw new ConflictException('El stock cambio; intente de nuevo');
      const stock = await tx.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      const reservation = await tx.reservation.create({ data: { itemId: item.id, buyerId, quantityKg: quantity, expiresAt: new Date(Date.now() + 15 * 60_000) } });
      await this.enqueueEvent(tx, { eventType: 'inventory.reserved', entityId: reservation.id, entityVersion: Number(stock.stockVersion), correlationId, payload: { reservation_id: reservation.id, lot_id: item.id, harvest_batch_id: item.batchId, product_id: item.productId, buyer_id: buyerId, quantity_kg: quantity.toString(), expires_at: reservation.expiresAt.toISOString() } });
      await this.enqueueStock(tx, stock, correlationId);
      return { insufficient: false as const, reservation, stock };
    });
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
      const stock = await tx.inventoryItem.update({ where: { id: reservation.itemId }, data: { availableKg: { increment: reservation.quantityKg }, stockVersion: { increment: 1 } } });
      const released = await tx.reservation.update({ where: { id }, data: { status: 'released' } });
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
      if (reservation.status !== 'active') throw new ConflictException('La reserva no esta activa');
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: reservation.itemId } });
      if (item.physicalKg.lessThan(reservation.quantityKg)) throw new ConflictException('El lote no tiene existencias fisicas suficientes');
      const stock = await tx.inventoryItem.update({ where: { id: item.id }, data: { physicalKg: { decrement: reservation.quantityKg }, stockVersion: { increment: 1 }, status: item.physicalKg.equals(reservation.quantityKg) ? 'depleted' : item.status } });
      const consumed = await tx.reservation.update({ where: { id }, data: { status: 'consumed' } });
      await this.recordMovement(tx, item, 'dispatch', reservation.quantityKg, reservation.id, correlationId);
      await this.enqueueStock(tx, stock, correlationId);
      return this.reservationView(consumed);
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
      const current = await tx.reservation.findUnique({ where: { id: reservation.id } });
      if (!current || current.status !== 'active' || current.expiresAt > new Date()) return;
      const stock = await tx.inventoryItem.update({ where: { id: current.itemId }, data: { availableKg: { increment: current.quantityKg }, stockVersion: { increment: 1 } } });
      const expired = await tx.reservation.update({ where: { id: current.id }, data: { status: 'expired' } });
      const correlationId = randomUUID();
      await this.enqueueReleased(tx, expired, stock, 'expired', correlationId);
      await this.enqueueStock(tx, stock, correlationId);
    });
  }

  private async recordMovement(tx: Prisma.TransactionClient, item: any, movementType: 'entry' | 'dispatch' | 'waste', quantity: Prisma.Decimal, sourceOperationId: string, correlationId: string, reason?: 'expiry' | 'damage' | 'cold_chain') {
    const movement = await tx.inventoryMovement.create({ data: { itemId: item.id, movementType, quantityKg: quantity, reason, sourceOperationId } });
    await this.enqueueEvent(tx, { eventType: 'inventory.movement_recorded', entityId: movement.id, entityVersion: Number(item.stockVersion), correlationId, payload: { movement_id: movement.id, lot_id: item.id, harvest_batch_id: item.batchId, product_id: item.productId, movement_type: movementType, quantity_kg: quantity.toString(), reason: reason ?? null, occurred_at: movement.createdAt.toISOString() } });
    return movement;
  }

  private async enqueueReleased(tx: Prisma.TransactionClient, reservation: any, stock: any, reason: 'released_by_buyer' | 'expired', correlationId: string) {
    await this.enqueueEvent(tx, { eventType: 'inventory.released', entityId: reservation.id, entityVersion: Number(stock.stockVersion), correlationId, payload: { reservation_id: reservation.id, lot_id: reservation.itemId, buyer_id: reservation.buyerId, quantity_kg: reservation.quantityKg.toString(), reason } });
  }

  private async enqueueStock(tx: Prisma.TransactionClient, item: any, correlationId: string) {
    await this.enqueueEvent(tx, { eventType: 'inventory.stock_changed', entityId: item.id, entityVersion: Number(item.stockVersion), correlationId, payload: { product_id: item.productId, stock_version: item.stockVersion.toString(), physical_kg: item.physicalKg.toString(), available_kg: item.availableKg.toString() } });
  }

  private async enqueueEvent(tx: Prisma.TransactionClient, input: { eventType: string; entityId: string; entityVersion: number; correlationId: string; payload: Record<string, unknown> }) {
    await tx.outboxEvent.create({ data: { eventType: input.eventType, routingKey: input.eventType, entityId: input.entityId, entityVersion: input.entityVersion, correlationId: input.correlationId, payload: input.payload as Prisma.InputJsonValue } });
  }

  private view(item: any) { return { id: item.id, batch_id: item.batchId, product_id: item.productId, expiry_estimate: item.expiryEstimate?.toISOString?.().slice(0, 10) ?? null, status: item.status, physical_kg: Number(item.physicalKg), available_kg: Number(item.availableKg), stock_version: Number(item.stockVersion), created_at: item.createdAt, updated_at: item.updatedAt }; }
  private reservationView(reservation: any) { return { id: reservation.id, item_id: reservation.itemId, buyer_id: reservation.buyerId, quantity_kg: Number(reservation.quantityKg), status: reservation.status, expires_at: reservation.expiresAt, created_at: reservation.createdAt }; }
}

function parseExpiry(value: unknown): Date { const date = new Date(`${String(value ?? '').slice(0, 10)}T00:00:00.000Z`); if (Number.isNaN(date.getTime())) throw new BadRequestException('harvest.registered requiere expiry_estimate valido'); return date; }
function farFuture(): Date { return new Date('9999-12-31T00:00:00.000Z'); }
