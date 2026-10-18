import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EventEnvelope } from './event-envelope';
import { PrismaService } from './prisma.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = new Set([
  'order.confirmed', 'order.fulfillment_closed', 'payment.captured', 'payment.refunded',
  'harvest.registered', 'inventory.waste_recorded', 'inventory.movement_recorded', 'inventory.stock_changed',
  'delivery.scheduled', 'delivery.in_transit', 'delivery.completed', 'delivery.partial', 'delivery.failed', 'delivery.cancelled', 'cold_chain.alert', 'rating.created',
  'producer.created', 'producer.updated', 'producer.disabled', 'product.updated', 'product.available', 'product.unavailable',
]);
const ALLOWED_TZ = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;
const REBUILD_CONFIRMATION = 'REBUILD_ANALYTICS_PROJECTIONS';

type Range = { start: Date; end: Date; timezone: string };
type MetricEvent = { eventId: string; eventType: string; entityId: string; entityVersion: number; correlationId: string; occurredAt: Date; payload: Record<string, unknown> };

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: PrismaService) {}

  async consume(event: EventEnvelope) {
    validateEnvelope(event);
    if (!EVENTS.has(event.event_type)) throw new BadRequestException(`Evento no admitido: ${event.event_type}`);
    const occurredAt = new Date(event.occurred_at);
    await this.db.$transaction(async (tx) => {
      if (await tx.processedEvent.findUnique({ where: { eventId: event.event_id } })) return;
      const sameVersion = await tx.processedEvent.findUnique({ where: { sourceService_eventType_entityId_entityVersion: {
        sourceService: event.source_service, eventType: event.event_type, entityId: event.entity_id, entityVersion: event.entity_version,
      } } });
      if (sameVersion) return;
      const startDate = new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate()));
      const endDate = new Date(startDate.getTime() + 86_400_000);
      const period = await tx.analyticsPeriod.upsert({ where: { startDate }, create: { startDate, endDate }, update: {} });
      await tx.processedEvent.create({ data: {
        eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: event.entity_id,
        entityVersion: event.entity_version, schemaVersion: event.schema_version, occurredAt,
        correlationId: event.correlation_id, payload: event.payload as Prisma.InputJsonValue, periodId: period.id,
      } });
      await projectEvent(tx, { eventId: event.event_id, eventType: event.event_type, entityId: event.entity_id, entityVersion: event.entity_version, correlationId: event.correlation_id, occurredAt, payload: event.payload });
    });
    return { processed: true, event_type: event.event_type };
  }

  async rebuildProjections(confirmation: unknown) {
    if (confirmation !== REBUILD_CONFIRMATION) throw new BadRequestException(`Confirma la operación enviando confirmation=${REBUILD_CONFIRMATION}`);
    return this.db.$transaction(async (tx) => {
      // A conflicting write lock waits for in-flight consumers and blocks new
      // inbox inserts until the complete replacement commits atomically.
      await tx.$executeRaw`LOCK TABLE processed_events IN SHARE ROW EXCLUSIVE MODE`;
      const events = await tx.processedEvent.findMany();
      events.sort(compareReplayEvents);

      // These tables are derived projections. Keep the processed-event archive,
      // calendar periods, generated reports and their outbox untouched.
      await tx.orderLineFact.deleteMany();
      await tx.fulfillmentLineFact.deleteMany();
      await tx.paymentFact.deleteMany();
      await tx.refundFact.deleteMany();
      await tx.wasteFact.deleteMany();
      await tx.harvestFact.deleteMany();
      await tx.deliveryStatusFact.deleteMany();
      await tx.deliveryFact.deleteMany();
      await tx.coldChainFact.deleteMany();
      await tx.ratingFact.deleteMany();
      await tx.stockFact.deleteMany();
      await tx.movementFact.deleteMany();
      await tx.orderFact.deleteMany();
      await tx.productFact.deleteMany();
      await tx.producerFact.deleteMany();

      for (const row of events) {
        await projectEvent(tx, {
          eventId: row.eventId,
          eventType: row.eventType,
          entityId: row.entityId,
          entityVersion: row.entityVersion,
          correlationId: row.correlationId,
          occurredAt: row.occurredAt,
          payload: row.payload as Record<string, unknown>,
        });
      }
      return { events_replayed: events.length, rebuilt_at: new Date().toISOString() };
    }, { timeout: 120_000 });
  }

  async sales(query: Record<string, unknown>) {
    const range = parseRange(query);
    const payments = await this.db.paymentFact.findMany({ where: { capturedAt: { gte: range.start, lt: range.end } } });
    const orderIds = [...new Set(payments.map((row) => row.orderId))];
    const [lines, refunds] = await Promise.all([
      orderIds.length ? this.db.orderLineFact.findMany({ where: { orderId: { in: orderIds } } }) : Promise.resolve([]),
      this.db.refundFact.findMany({ where: { occurredAt: { gte: range.start, lt: range.end } } }),
    ]);
    const capturedByOrder = new Map<string, number>();
    for (const payment of payments) capturedByOrder.set(payment.orderId, (capturedByOrder.get(payment.orderId) ?? 0) + Number(payment.amount));
    const byOrder = new Map<string, typeof lines>();
    for (const line of lines) byOrder.set(line.orderId, [...(byOrder.get(line.orderId) ?? []), line]);
    const grouped = new Map<string, { product_id: string; producer_id: string | null; product_name: string; kg: number; revenue_cop: number }>();
    let attributed = 0;
    for (const [orderId, capturedForOrder] of capturedByOrder) {
      const orderLines = byOrder.get(orderId) ?? [];
      const acceptedLines = orderLines.filter((line) => line.acceptedQuantity != null && line.acceptedAmount != null);
      const acceptedTotal = acceptedLines.reduce((sum, line) => sum + Number(line.acceptedAmount), 0);
      const orderAttributed = Math.min(capturedForOrder, acceptedTotal);
      attributed += orderAttributed;
      for (const line of acceptedLines) {
        if (line.acceptedQuantity == null || line.acceptedAmount == null) continue;
        const acceptedAmount = Number(line.acceptedAmount);
        const amount = acceptedTotal > 0 ? orderAttributed * acceptedAmount / acceptedTotal : 0;
        const key = `${line.productId}:${line.producerId ?? ''}`;
        const current = grouped.get(key) ?? { product_id: line.productId, producer_id: line.producerId, product_name: line.productName ?? 'Producto', kg: 0, revenue_cop: 0 };
        current.kg += Number(line.acceptedQuantity); current.revenue_cop += amount; grouped.set(key, current);
      }
    }
    const captured = payments.reduce((sum, item) => sum + Number(item.amount), 0);
    const refunded = refunds.reduce((sum, item) => sum + Number(item.amount), 0);
    const producerIds = [...new Set([...grouped.values()].map((row) => row.producer_id).filter((id): id is string => Boolean(id)))];
    const producerRows = producerIds.length ? await this.db.producerFact.findMany({ where: { producerId: { in: producerIds } } }) : [];
    const producerNames = new Map(producerRows.map((row) => [row.producerId, row.fullName]));
    return reportEnvelope('sales', range, {
      captured_cop: money(captured), refunded_cop: money(refunded),
      unallocated_cop: money(Math.max(0, captured - attributed)),
      orders_captured: orderIds.length, by_product: [...grouped.values()].map((row) => ({ ...row, producer_name: row.producer_id ? producerNames.get(row.producer_id) ?? 'Productor' : 'Productor sin asignar', kg: round(row.kg, 3), revenue_cop: money(row.revenue_cop) })),
      formula: 'captured_amount sum from payment.captured; product kg and amount from accepted order lines in order.fulfillment_closed; refunds reported separately from payment.refunded',
      coverage: payments.length === 0 ? 'no_data' : Math.abs(attributed - captured) > 0.01 ? 'partial_capture_or_missing_order_or_fulfillment_lines' : 'complete',
    });
  }

  async waste(query: Record<string, unknown>) {
    const range = parseRange(query);
    const facts = await this.db.wasteFact.findMany({ where: { occurredAt: { gte: range.start, lt: range.end } } });
    const affectedBatchIds = [...new Set(facts.map((row) => row.batchId).filter((id): id is string => Boolean(id)))];
    const harvests = await this.db.harvestFact.findMany({ where: { OR: [
      { harvestedAt: { gte: range.start, lt: range.end } },
      ...(affectedBatchIds.length ? [{ batchId: { in: affectedBatchIds } }] : []),
    ] } });
    const byProduct = new Map<string, number>(); const byReason = new Map<string, number>();
    for (const fact of facts) {
      byProduct.set(fact.productId, (byProduct.get(fact.productId) ?? 0) + Number(fact.quantityKg));
      byReason.set(fact.reason, (byReason.get(fact.reason) ?? 0) + Number(fact.quantityKg));
    }
    const cohortWaste = affectedBatchIds.length ? await this.db.wasteFact.findMany({ where: { batchId: { in: affectedBatchIds } } }) : [];
    const batchTotals = new Map<string, number>();
    for (const row of cohortWaste) if (row.batchId) batchTotals.set(row.batchId, (batchTotals.get(row.batchId) ?? 0) + Number(row.quantityKg));
    const cohort = harvests.map((harvest) => {
      const wasted = batchTotals.get(harvest.batchId) ?? 0; const initial = Number(harvest.quantityKg);
      return { harvest_batch_id: harvest.batchId, product_id: harvest.productId, harvested_kg: round(initial, 3), wasted_kg: round(wasted, 3), waste_percent: initial > 0 ? round(wasted / initial * 100, 2) : null };
    });
    const productIds = [...new Set(facts.map((row) => row.productId))];
    const products = productIds.length ? await this.db.productFact.findMany({ where: { productId: { in: productIds } } }) : [];
    const productNames = new Map(products.map((row) => [row.productId, row.name]));
    return reportEnvelope('waste', range, {
      wasted_kg: round(facts.reduce((sum, row) => sum + Number(row.quantityKg), 0), 3),
      by_product_kg: [...byProduct].map(([product_id, kg]) => ({ product_id, product_name: productNames.get(product_id) ?? 'Producto', kg: round(kg, 3) })),
      by_reason_kg: [...byReason].map(([reason, kg]) => ({ reason, kg: round(kg, 3) })),
      harvest_cohorts: cohort,
      formula: 'SUM(inventory.waste_recorded.quantity_kg) by effective UTC date; cohort percent = accumulated waste for batch / harvest.registered initial kg × 100',
      coverage: facts.some((row) => !row.batchId) || affectedBatchIds.some((id) => !harvests.some((harvest) => harvest.batchId === id)) ? 'partial_missing_batch_or_harvest_reference' : facts.length ? 'complete' : 'no_data',
    });
  }

  async inventoryRotation(query: Record<string, unknown>) {
    const range = parseRange(query);
    const [initial, changes, dispatches] = await Promise.all([
      this.db.stockFact.findMany({ where: { occurredAt: { lt: range.start } }, orderBy: { occurredAt: 'desc' } }),
      this.db.stockFact.findMany({ where: { occurredAt: { gte: range.start, lt: range.end } }, orderBy: { occurredAt: 'asc' } }),
      this.db.movementFact.findMany({ where: { type: 'dispatch', occurredAt: { gte: range.start, lt: range.end } } }),
    ]);
    const latest = new Map<string, typeof initial[number]>();
    for (const row of initial) if (!latest.has(row.lotId)) latest.set(row.lotId, row);
    const timeline = new Map<string, Array<{ at: Date; kg: number }>>();
    for (const row of latest.values()) timeline.set(row.lotId, [{ at: range.start, kg: Number(row.physicalKg) }]);
    for (const row of changes) {
      if (!timeline.has(row.lotId) && row.occurredAt.getTime() === range.start.getTime()) timeline.set(row.lotId, [{ at: range.start, kg: Number(row.physicalKg) }]);
      if (!timeline.has(row.lotId)) continue;
      const series = timeline.get(row.lotId) ?? [];
      series.push({ at: row.occurredAt, kg: Number(row.physicalKg) }); timeline.set(row.lotId, series);
    }
    let area = 0; let coveredLots = 0;
    const seconds = (range.end.getTime() - range.start.getTime()) / 1000;
    for (const series of timeline.values()) {
      series.sort((a, b) => a.at.getTime() - b.at.getTime());
      let cursor = range.start.getTime(); let balance = series[0]?.kg ?? 0;
      for (const snapshot of series) {
        const at = Math.min(range.end.getTime(), Math.max(cursor, snapshot.at.getTime()));
        area += balance * (at - cursor) / 1000; cursor = at; balance = snapshot.kg;
      }
      area += balance * Math.max(0, range.end.getTime() - cursor) / 1000;
      coveredLots++;
    }
    const averageStock = coveredLots ? area / seconds : null;
    const dispatchedKg = dispatches.reduce((sum, row) => sum + Number(row.quantityKg), 0);
    return reportEnvelope('inventory-rotation', range, {
      dispatched_kg: round(dispatchedKg, 3), time_weighted_average_physical_stock_kg: averageStock == null ? null : round(averageStock, 3),
      rotations: averageStock && averageStock > 0 ? round(dispatchedKg / averageStock, 4) : null,
      coverage: coveredLots ? 'partial_tracked_lots_with_pre_period_snapshot' : 'no_data_missing_initial_stock_snapshots',
      formula: 'sum dispatch kg in period / time-weighted average physical kg from inventory.stock_changed snapshots; periods with no initial snapshot are not reported as zero',
    });
  }

  async deliveries(query: Record<string, unknown>) {
    const range = parseRange(query);
    const facts = await this.db.deliveryFact.findMany({ where: { windowEnd: { gte: range.start, lt: range.end } } });
    const ids = facts.map((row) => row.deliveryId);
    const [statuses, alerts] = await Promise.all([
      ids.length ? this.db.deliveryStatusFact.findMany({ where: { deliveryId: { in: ids }, occurredAt: { lt: range.end } }, orderBy: { occurredAt: 'asc' } }) : Promise.resolve([]),
      ids.length ? this.db.coldChainFact.findMany({ where: { deliveryId: { in: ids }, occurredAt: { gte: range.start, lt: range.end } } }) : Promise.resolve([]),
    ]);
    const byDelivery = new Map<string, typeof statuses[number]>();
    for (const status of statuses) byDelivery.set(status.deliveryId, status);
    const incidents = new Map<string, number>(); for (const alert of alerts) incidents.set(alert.deliveryId, (incidents.get(alert.deliveryId) ?? 0) + 1);
    let eligible = 0; let onTime = 0; const durations: number[] = [];
    const rows = facts.map((fact) => {
      const status = byDelivery.get(fact.deliveryId); const state = status?.status ?? 'scheduled';
      const start = fact.windowStart; const end = fact.windowEnd; const cancelledAt = status?.cancelledAt ?? (state === 'cancelled' ? status?.occurredAt : null);
      const excluded = state === 'cancelled' && cancelledAt != null && cancelledAt < start;
      const deliveredAt = status?.deliveredAt ?? null;
      if (!excluded) eligible++;
      const timely = !excluded && state === 'completed' && deliveredAt != null && deliveredAt >= start && deliveredAt <= end;
      if (timely) onTime++;
      const dispatchedAt = status?.dispatchedAt;
      if (dispatchedAt && deliveredAt) durations.push((deliveredAt.getTime() - dispatchedAt.getTime()) / 60_000);
      return { delivery_id: fact.deliveryId, window_start: start, window_end: end, status: state, delivered_at: deliveredAt, on_time: timely, cold_chain_incidents: incidents.get(fact.deliveryId) ?? 0 };
    });
    return reportEnvelope('deliveries', range, {
      due_deliveries: eligible, on_time_deliveries: onTime, window_compliance_percent: eligible ? round(onTime / eligible * 100, 2) : null,
      average_duration_minutes: durations.length ? round(mean(durations), 2) : null, p95_duration_minutes: durations.length ? round(percentile(durations, 0.95), 2) : null,
      cold_chain_incidents: alerts.length, deliveries: rows,
      formula: 'on-time completed deliveries / deliveries whose window_end falls in period; only cancellations before window_start are excluded; duration = delivered_at - dispatched_at',
      coverage: facts.length ? 'complete_for_scheduled_deliveries' : 'no_data',
    });
  }

  async satisfaction(query: Record<string, unknown>) {
    const range = parseRange(query);
    const ratings = await this.db.ratingFact.findMany({ where: { createdAt: { gte: range.start, lt: range.end } }, orderBy: { createdAt: 'desc' } });
    const scores = ratings.map((row) => row.score);
    return reportEnvelope('satisfaction', range, {
      rating_count: ratings.length, average_score: scores.length ? round(mean(scores), 2) : null,
      score_distribution: [1, 2, 3, 4, 5].map((score) => ({ score, count: scores.filter((value) => value === score).length })),
      formula: 'AVG(score) and count from rating.created; missing ratings are not interpreted as zero', coverage: ratings.length ? 'complete' : 'no_data',
    });
  }

  async generateReport(type: string, query: Record<string, unknown>) {
    const methods: Record<string, (q: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
      sales: (q) => this.sales(q), waste: (q) => this.waste(q), 'inventory-rotation': (q) => this.inventoryRotation(q), deliveries: (q) => this.deliveries(q), satisfaction: (q) => this.satisfaction(q),
    };
    const method = methods[type]; if (!method) throw new BadRequestException('Tipo de reporte no válido');
    const result = await method(query); const range = parseRange(query); const reportId = randomUUID();
    await this.db.$transaction(async (tx) => {
      await tx.reportFact.create({ data: { id: reportId, reportType: type, startAt: range.start, endAt: range.end, timezone: range.timezone, result: result as Prisma.InputJsonValue } });
      await tx.outboxEvent.create({ data: { eventType: 'report.generated', aggregateId: reportId, correlationId: randomUUID(), payload: { report_id: reportId, report_type: type, start: range.start.toISOString(), end: range.end.toISOString(), timezone: range.timezone } } });
    });
    return { report_id: reportId, ...result };
  }
}

async function projectEvent(tx: Prisma.TransactionClient, event: MetricEvent) {
  const p = event.payload;
  switch (event.eventType) {
    case 'order.confirmed': {
      const orderId = uuid(p.orderId ?? p.order_id, 'order_id'); const buyerId = uuid(p.buyerId ?? p.buyer_id, 'buyer_id');
      const paymentId = optionalUuid(p.paymentId ?? p.payment_id); const rawItems = Array.isArray(p.items) ? p.items as Array<Record<string, unknown>> : [];
      await tx.orderFact.upsert({ where: { orderId }, create: { orderId, buyerId, paymentId, orderedAt: event.occurredAt }, update: { buyerId, paymentId } });
      for (const item of rawItems) {
        const orderItemId = uuid(item.id ?? item.order_item_id, 'order_item_id'); const productId = uuid(item.productId ?? item.product_id, 'product_id');
        const quantityKg = decimal(item.quantity ?? item.quantity_kg, 'quantity_kg'); const unitPrice = decimal(item.unitPrice ?? item.unit_price, 'unit_price');
        const accepted = await tx.fulfillmentLineFact.findUnique({ where: { orderItemId } });
        await tx.orderLineFact.upsert({ where: { orderItemId }, create: { orderItemId, orderId, productId, producerId: optionalUuid(item.producerId ?? item.producer_id), productName: optionalText(item.productName ?? item.product_name), quantityKg, unitPrice, ...(accepted ? { acceptedQuantity: accepted.acceptedQuantity, acceptedAmount: accepted.acceptedAmount } : {}) }, update: { orderId, productId, producerId: optionalUuid(item.producerId ?? item.producer_id), productName: optionalText(item.productName ?? item.product_name), quantityKg, unitPrice, ...(accepted ? { acceptedQuantity: accepted.acceptedQuantity, acceptedAmount: accepted.acceptedAmount } : {}) } });
      }
      break;
    }
    case 'order.fulfillment_closed': {
      const orderId = uuid(p.order_id ?? p.orderId, 'order_id');
      for (const item of (Array.isArray(p.items) ? p.items : []) as Array<Record<string, unknown>>) {
        const orderItemId = uuid(item.order_item_id ?? item.id, 'order_item_id');
        const acceptedQuantity = decimal(item.accepted_quantity_kg ?? item.acceptedQuantityKg, 'accepted_quantity_kg');
        const acceptedAmount = decimal(item.accepted_amount ?? item.acceptedAmount, 'accepted_amount');
        await tx.fulfillmentLineFact.upsert({ where: { orderItemId }, create: { orderItemId, orderId, acceptedQuantity, acceptedAmount }, update: { orderId, acceptedQuantity, acceptedAmount } });
        await tx.orderLineFact.updateMany({ where: { orderItemId }, data: { acceptedQuantity, acceptedAmount } });
      }
      break;
    }
    case 'payment.captured': {
      const paymentId = uuid(p.payment_id ?? p.paymentId, 'payment_id'); const orderId = uuid(p.order_id ?? p.orderId, 'order_id'); const amount = decimal(p.amount, 'amount');
      await tx.paymentFact.upsert({ where: { paymentId }, create: { paymentId, orderId, amount, capturedAt: event.occurredAt }, update: { orderId, amount, capturedAt: event.occurredAt } });
      break;
    }
    case 'payment.refunded': {
      await tx.refundFact.upsert({ where: { eventId: event.eventId }, create: { eventId: event.eventId, paymentId: uuid(p.payment_id, 'payment_id'), orderId: uuid(p.order_id, 'order_id'), amount: decimal(p.amount, 'amount'), occurredAt: event.occurredAt }, update: {} });
      break;
    }
    case 'harvest.registered': {
      await tx.harvestFact.upsert({ where: { batchId: uuid(p.batch_id ?? event.entityId, 'batch_id') }, create: { batchId: uuid(p.batch_id ?? event.entityId, 'batch_id'), productId: uuid(p.product_id, 'product_id'), producerId: uuid(p.producer_id, 'producer_id'), quantityKg: decimal(p.quantity_kg, 'quantity_kg'), harvestedAt: dateValue(p.harvest_date ?? event.occurredAt, 'harvest_date') }, update: { quantityKg: decimal(p.quantity_kg, 'quantity_kg'), harvestedAt: dateValue(p.harvest_date ?? event.occurredAt, 'harvest_date') } });
      break;
    }
    case 'inventory.waste_recorded': {
      const movementId = uuid(p.movement_id ?? event.entityId, 'movement_id'); const reason = String(p.reason ?? '');
      if (!['expiry', 'damage', 'cold_chain'].includes(reason)) throw new BadRequestException('Razón de merma no válida');
      await tx.wasteFact.upsert({ where: { movementId }, create: { movementId, eventId: event.eventId, batchId: optionalUuid(p.harvest_batch_id), productId: uuid(p.product_id, 'product_id'), quantityKg: decimal(p.quantity_kg, 'quantity_kg'), reason, occurredAt: dateValue(p.occurred_at ?? event.occurredAt, 'occurred_at') }, update: {} });
      break;
    }
    case 'inventory.movement_recorded': {
      const type = String(p.movement_type ?? ''); if (!['entry', 'dispatch', 'waste'].includes(type)) throw new BadRequestException('Tipo de movimiento no válido');
      await tx.movementFact.upsert({ where: { movementId: uuid(p.movement_id ?? event.entityId, 'movement_id') }, create: { movementId: uuid(p.movement_id ?? event.entityId, 'movement_id'), lotId: uuid(p.lot_id, 'lot_id'), productId: uuid(p.product_id, 'product_id'), type, quantityKg: decimal(p.quantity_kg, 'quantity_kg'), occurredAt: dateValue(p.occurred_at ?? event.occurredAt, 'occurred_at') }, update: {} });
      break;
    }
    case 'inventory.stock_changed': {
      const stockVersion = BigInt(String(p.stock_version ?? event.entityVersion));
      await tx.stockFact.upsert({ where: { lotId_stockVersion: { lotId: uuid(event.entityId, 'lot_id'), stockVersion } }, create: { lotId: uuid(event.entityId, 'lot_id'), stockVersion, productId: uuid(p.product_id, 'product_id'), physicalKg: decimal(p.physical_kg, 'physical_kg'), occurredAt: event.occurredAt }, update: {} });
      break;
    }
    case 'delivery.scheduled': {
      const deliveryId = uuid(p.delivery_id ?? event.entityId, 'delivery_id');
      await tx.deliveryFact.upsert({ where: { deliveryId }, create: { deliveryId, orderId: optionalUuid(p.order_id), windowStart: dateValue(p.window_start, 'window_start'), windowEnd: dateValue(p.window_end, 'window_end'), status: 'scheduled' }, update: { orderId: optionalUuid(p.order_id), windowStart: dateValue(p.window_start, 'window_start'), windowEnd: dateValue(p.window_end, 'window_end') } });
      await tx.deliveryStatusFact.upsert({ where: { eventId: event.eventId }, create: { eventId: event.eventId, deliveryId, status: 'scheduled', occurredAt: event.occurredAt }, update: {} });
      break;
    }
    case 'delivery.in_transit': case 'delivery.completed': case 'delivery.partial': case 'delivery.failed': case 'delivery.cancelled': {
      const deliveryId = uuid(p.delivery_id ?? event.entityId, 'delivery_id');
      await tx.deliveryStatusFact.upsert({ where: { eventId: event.eventId }, create: { eventId: event.eventId, deliveryId, status: event.eventType.slice('delivery.'.length), occurredAt: event.occurredAt, dispatchedAt: optionalDate(p.dispatched_at), deliveredAt: optionalDate(p.delivered_at), cancelledAt: event.eventType === 'delivery.cancelled' ? event.occurredAt : null }, update: {} });
      break;
    }
    case 'cold_chain.alert': {
      const alertId = uuid(p.alert_id ?? event.eventId, 'alert_id');
      await tx.coldChainFact.upsert({ where: { alertId }, create: { alertId, deliveryId: uuid(p.delivery_id, 'delivery_id'), occurredAt: dateValue(p.recorded_at ?? event.occurredAt, 'recorded_at') }, update: {} });
      break;
    }
    case 'rating.created': {
      const ratingId = uuid(p.rating_id ?? event.entityId, 'rating_id'); const score = Number(p.score);
      if (!Number.isInteger(score) || score < 1 || score > 5) throw new BadRequestException('score debe estar entre 1 y 5');
      await tx.ratingFact.upsert({ where: { ratingId }, create: { ratingId, orderId: uuid(p.order_id, 'order_id'), buyerId: uuid(p.buyer_id, 'buyer_id'), score, comment: optionalText(p.comment), createdAt: dateValue(p.created_at ?? event.occurredAt, 'created_at') }, update: { score, comment: optionalText(p.comment) } });
      break;
    }
    case 'producer.created': case 'producer.updated': {
      const producerId = uuid(p.producer_id ?? event.entityId, 'producer_id');
      await tx.producerFact.upsert({ where: { producerId }, create: { producerId, fullName: optionalShortText(p.full_name), status: String(p.status ?? 'active') }, update: { ...(optionalShortText(p.full_name) ? { fullName: optionalShortText(p.full_name) } : {}), ...(typeof p.status === 'string' ? { status: p.status } : {}) } });
      break;
    }
    case 'producer.disabled': {
      const producerId = uuid(p.producer_id ?? event.entityId, 'producer_id');
      await tx.producerFact.upsert({ where: { producerId }, create: { producerId, status: 'disabled' }, update: { status: 'disabled' } });
      break;
    }
    case 'product.updated': {
      const productId = uuid(p.product_id ?? event.entityId, 'product_id');
      await tx.productFact.upsert({ where: { productId }, create: { productId, producerId: optionalUuid(p.producer_id), name: requiredShortText(p.name, 'name'), active: p.active !== false }, update: { producerId: optionalUuid(p.producer_id), name: requiredShortText(p.name, 'name'), ...(typeof p.active === 'boolean' ? { active: p.active } : {}) } });
      break;
    }
    case 'product.available': case 'product.unavailable': {
      const productId = uuid(p.product_id ?? event.entityId, 'product_id'); const active = event.eventType === 'product.available';
      await tx.productFact.updateMany({ where: { productId }, data: { active } });
      break;
    }
  }
}

function compareReplayEvents(a: Pick<MetricEvent, 'eventId' | 'eventType' | 'entityId' | 'entityVersion' | 'occurredAt'>, b: Pick<MetricEvent, 'eventId' | 'eventType' | 'entityId' | 'entityVersion' | 'occurredAt'>) {
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (byTime) return byTime;
  const byEntity = a.entityId.localeCompare(b.entityId);
  if (byEntity) return byEntity;
  const byVersion = a.entityVersion - b.entityVersion;
  if (byVersion) return byVersion;
  const byTypePriority = replayPriority(a.eventType) - replayPriority(b.eventType);
  if (byTypePriority) return byTypePriority;
  return a.eventId.localeCompare(b.eventId);
}

function replayPriority(eventType: string) {
  if (['order.confirmed', 'product.updated', 'producer.created', 'producer.updated', 'delivery.scheduled'].includes(eventType)) return 0;
  if (['order.fulfillment_closed', 'product.available', 'product.unavailable', 'producer.disabled', 'delivery.in_transit', 'delivery.completed', 'delivery.partial', 'delivery.failed', 'delivery.cancelled'].includes(eventType)) return 1;
  return 0;
}

function validateEnvelope(event: EventEnvelope) {
  if (!event || !UUID.test(String(event.event_id)) || !UUID.test(String(event.entity_id)) || !UUID.test(String(event.correlation_id)) || !event.event_type || !event.source_service || !Number.isInteger(event.entity_version) || event.entity_version < 1 || !Number.isInteger(event.schema_version) || event.schema_version < 1 || !Number.isFinite(Date.parse(event.occurred_at)) || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new BadRequestException('Sobre de evento inválido');
}
function uuid(value: unknown, name: string) { const s = String(value ?? ''); if (!UUID.test(s)) throw new BadRequestException(`${name} debe ser UUID`); return s; }
function optionalUuid(value: unknown): string | null { const s = String(value ?? ''); return UUID.test(s) ? s : null; }
function decimal(value: unknown, name: string) { const s = String(value ?? ''); if (!/^-?\d+(?:\.\d+)?$/.test(s)) throw new BadRequestException(`${name} debe ser número decimal`); const result = new Prisma.Decimal(s); if (!result.isFinite() || result.isNegative()) throw new BadRequestException(`${name} no puede ser negativo`); return result; }
function dateValue(value: unknown, name: string): Date { const d = value instanceof Date ? value : new Date(String(value ?? '')); if (!Number.isFinite(d.getTime())) throw new BadRequestException(`${name} debe ser fecha válida`); return d; }
function optionalDate(value: unknown): Date | null { if (value == null || value === '') return null; const d = new Date(String(value)); return Number.isFinite(d.getTime()) ? d : null; }
function optionalText(value: unknown) { const s = String(value ?? '').trim(); return s && s.length <= 1000 ? s : null; }
function optionalShortText(value: unknown) { const s = String(value ?? '').trim(); return s && s.length <= 180 ? s : null; }
function requiredShortText(value: unknown, name: string) { const s = optionalShortText(value); if (!s) throw new BadRequestException(`${name} es obligatorio`); return s; }
function parseRange(query: Record<string, unknown>): Range {
  const timezone = String(query.timezone ?? 'UTC');
  if (!ALLOWED_TZ.test(timezone)) throw new BadRequestException('Zona horaria inválida');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new BadRequestException('Zona horaria IANA no reconocida'); }
  const today = localDateString(new Date(), timezone);
  const startDate = localCalendarDate(query.start ?? addCalendarDays(today, -30), 'start');
  const endDate = localCalendarDate(query.end ?? addCalendarDays(today, 1), 'end');
  const calendarDays = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000;
  if (calendarDays <= 0 || calendarDays > 366) throw new BadRequestException('El rango debe ser positivo y no superar 366 días');
  return { start: localMidnightUtc(startDate, timezone), end: localMidnightUtc(endDate, timezone), timezone };
}
function localCalendarDate(value: unknown, name: string): string {
  const text = String(value ?? ''); const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new BadRequestException(`${name} debe tener formato YYYY-MM-DD`);
  const [, year, month, day] = match; const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) throw new BadRequestException(`${name} no es una fecha válida`);
  return text;
}
function addCalendarDays(date: string, days: number) { const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function localDateString(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function localMidnightUtc(date: string, timezone: string) {
  const [year, month, day] = date.split('-').map(Number); const localAsUtc = Date.UTC(year, month - 1, day); let guess = localAsUtc;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const representedAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    const next = guess + (localAsUtc - representedAsUtc);
    if (next === guess) break;
    guess = next;
  }
  const resolved = new Date(guess);
  if (localDateString(resolved, timezone) !== date) throw new BadRequestException(`${date} no tiene una medianoche válida en ${timezone}`);
  return resolved;
}
function reportEnvelope(type: string, range: Range, data: Record<string, unknown>) { return { type, period: { start_utc: range.start.toISOString(), end_utc_exclusive: range.end.toISOString(), timezone: range.timezone }, generated_at: new Date().toISOString(), ...data }; }
function round(value: number, decimals: number) { return Number(value.toFixed(decimals)); }
function money(value: number) { return round(value, 2); }
function mean(values: number[]) { return values.reduce((a, b) => a + b, 0) / values.length; }
function percentile(values: number[], p: number) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(p * sorted.length) - 1] ?? 0; }
