import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel, NotificationStatus, Prisma } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import { EventEnvelope } from './event-envelope';
import { SetNotificationPreferenceDto } from './notification.dto';
import { PrismaService } from './prisma.service';

const MANDATORY_IN_APP = new Set(['order.confirmed', 'order.cancelled', 'delivery.scheduled', 'delivery.completed', 'delivery.partial', 'delivery.failed', 'delivery.cancelled', 'payment.authorized', 'payment.captured', 'payment.completed', 'payment.failed', 'payment.refunded', 'payout.scheduled', 'payout.completed', 'cold_chain.alert', 'rating.created']);
const KNOWN_EVENTS = new Set([
  'order.confirmed', 'order.cancelled', 'delivery.scheduled', 'delivery.completed', 'delivery.partial', 'delivery.failed', 'delivery.cancelled',
  'payment.authorized', 'payment.captured', 'payment.completed', 'payment.failed', 'payment.refunded', 'payout.scheduled', 'payout.completed', 'cold_chain.alert', 'stock.low',
  'product.available', 'product.unavailable', 'identity.user_created', 'identity.user_disabled', 'identity.roles_changed', 'rating.created',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTEMPTS = 3;

type Contact = { id: string; email: string; full_name?: string; status?: string };
type PreparedNotification = { userId: string; type: string; title: string; message: string; preferenceId: string | null; channel: NotificationChannel; email: string | null; phone: string | null };

@Injectable()
export class NotificationsService {
  constructor(private readonly db: PrismaService, private readonly config: ConfigService) {}

  async consume(event: EventEnvelope) {
    validateEnvelope(event);
    if (!KNOWN_EVENTS.has(event.event_type)) throw new BadRequestException(`Tipo de evento no soportado: ${event.event_type}`);
    const recipients = await this.resolveRecipients(event.payload);
    const prepared: PreparedNotification[] = [];
    for (const userId of recipients) {
      const prefs = await this.db.notificationPreference.findMany({ where: { userId, notificationType: event.event_type } });
      const needsContact = prefs.some((pref) => pref.enabled && (pref.channel === NotificationChannel.email || pref.channel === NotificationChannel.sms));
      const contact = needsContact ? await this.contact(userId, event.payload) : null;
      const defaultInApp = !prefs.some((pref) => pref.channel === NotificationChannel.in_app) || prefs.find((pref) => pref.channel === NotificationChannel.in_app)?.enabled;
      if (defaultInApp || MANDATORY_IN_APP.has(event.event_type)) {
        prepared.push(makeNotification(event, userId, NotificationChannel.in_app, prefs.find((pref) => pref.channel === NotificationChannel.in_app)?.id ?? null, contact, null));
      }
      for (const pref of prefs) {
        if (!pref.enabled || pref.channel === NotificationChannel.in_app) continue;
        if (pref.channel === NotificationChannel.email && contact?.email && contact.status === 'active') prepared.push(makeNotification(event, userId, pref.channel, pref.id, contact, null));
        if (pref.channel === NotificationChannel.sms) {
          const phone = text(event.payload.recipient_phone ?? event.payload.phone, 30);
          if (phone) prepared.push(makeNotification(event, userId, pref.channel, pref.id, contact, phone));
        }
      }
    }

    await this.db.$transaction(async (tx) => {
      const prior = await tx.processedEvent.findUnique({ where: { eventId: event.event_id } });
      if (prior) return;
      const sameVersion = await tx.processedEvent.findUnique({ where: { sourceService_eventType_entityId_entityVersion: { sourceService: event.source_service, eventType: event.event_type, entityId: event.entity_id, entityVersion: event.entity_version } } });
      if (sameVersion) return;
      await tx.processedEvent.create({ data: {
        eventId: event.event_id, eventType: event.event_type, sourceService: event.source_service, entityId: event.entity_id,
        entityVersion: event.entity_version, occurredAt: new Date(event.occurred_at), payload: event.payload as Prisma.InputJsonValue,
        schemaVersion: event.schema_version, correlationId: event.correlation_id,
      } });
      for (const item of prepared) {
        const notification = await tx.notification.create({ data: {
          userId: item.userId, type: item.type, title: item.title, message: item.message, channel: item.channel,
          sourceEventId: event.event_id, preferenceId: item.preferenceId, recipientEmail: item.email, recipientPhone: item.phone,
        } }).catch((error: unknown) => { if (isUnique(error)) return null; throw error; });
        if (notification && item.channel === NotificationChannel.in_app) {
          await tx.notification.update({ where: { id: notification.id }, data: { status: NotificationStatus.sent, sentAt: new Date() } });
          await enqueueStatus(tx, notification.id, item.userId, item.type, event, 'notification.sent');
        }
      }
    });
    return { processed: true, recipients: recipients.length, notifications: prepared.length };
  }

  async list(userId: string, limit = 50) {
    return this.db.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: Math.min(100, Math.max(1, limit)), select: {
      id: true, type: true, title: true, message: true, channel: true, status: true, createdAt: true, sentAt: true, readAt: true,
    } });
  }

  preferences(userId: string) { return this.db.notificationPreference.findMany({ where: { userId }, orderBy: [{ notificationType: 'asc' }, { channel: 'asc' }] }); }

  async setPreference(userId: string, dto: SetNotificationPreferenceDto) {
    if (!KNOWN_EVENTS.has(dto.notification_type)) throw new BadRequestException('Tipo de notificación no reconocido');
    const channel = dto.channel as NotificationChannel;
    return this.db.notificationPreference.upsert({
      where: { userId_notificationType_channel: { userId, notificationType: dto.notification_type, channel } },
      create: { userId, notificationType: dto.notification_type, channel, enabled: dto.enabled },
      update: { enabled: dto.enabled },
    });
  }

  async markRead(id: string, userId: string) {
    const changed = await this.db.notification.updateMany({ where: { id, userId, status: NotificationStatus.sent }, data: { status: NotificationStatus.read, readAt: new Date() } });
    if (!changed.count) {
      const row = await this.db.notification.findUnique({ where: { id }, select: { userId: true } });
      if (row && row.userId !== userId) throw new ForbiddenException('Notificación ajena');
      if (!row) throw new NotFoundException('Notificación no encontrada');
    }
    return this.db.notification.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, readAt: true } });
  }

  async dispatchPending() {
    const rows = await this.db.$transaction((tx) => tx.$queryRaw<Array<{ id: string }>>`
      UPDATE notifications SET next_attempt_at = NOW() + INTERVAL '1 minute', attempts = attempts + 1
      WHERE id IN (SELECT id FROM notifications WHERE status = 'pending' AND next_attempt_at <= NOW()
        ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED) RETURNING id
    `);
    for (const row of rows) await this.dispatch(row.id);
    return rows.length;
  }

  private async dispatch(id: string) {
    const row = await this.db.notification.findUnique({ where: { id } });
    if (!row || row.status !== NotificationStatus.pending) return;
    try {
      if (row.channel === NotificationChannel.email) await this.sendEmail(row);
      else if (row.channel === NotificationChannel.sms) await this.sendSms(row);
      else return;
      await this.finish(row, NotificationStatus.sent, null);
    } catch (error) {
      const attempts = row.attempts;
      const terminal = attempts >= MAX_ATTEMPTS;
      if (terminal) await this.finish(row, NotificationStatus.failed, (error as Error).message);
      else await this.db.notification.update({ where: { id }, data: {
        status: NotificationStatus.pending,
        nextAttemptAt: new Date(Date.now() + Math.min(300_000, 5000 * 2 ** Math.max(0, attempts - 1))),
        lastError: (error as Error).message.slice(0, 1000),
      } });
    }
  }

  private async sendEmail(row: { id: string; title: string; message: string; recipientEmail: string | null }) {
    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    if (!host || !user || !pass || !row.recipientEmail) throw new Error('Correo no disponible: falta destinatario o configuración SMTP');
    const transporter = nodemailer.createTransport({ host, port: Number(this.config.get('SMTP_PORT') ?? 587), secure: this.config.get('SMTP_SECURE') === 'true', auth: { user, pass }, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 });
    await transporter.sendMail({ from: this.config.get<string>('SMTP_FROM') ?? user, to: row.recipientEmail, subject: row.title, text: row.message, messageId: `<${row.id}@farmtotable.local>`, headers: { 'X-FarmToTable-Notification': row.id } });
  }

  private async sendSms(row: { id: string; message: string; recipientPhone: string | null }) {
    const url = this.config.get<string>('SMS_WEBHOOK_URL');
    if (!url || !row.recipientPhone) throw new Error('SMS no disponible: configure SMS_WEBHOOK_URL y un teléfono del destinatario');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': row.id, ...(this.config.get<string>('SMS_WEBHOOK_TOKEN') ? { authorization: `Bearer ${this.config.get<string>('SMS_WEBHOOK_TOKEN')}` } : {}) }, body: JSON.stringify({ to: row.recipientPhone, message: row.message }), signal: controller.signal });
      if (!response.ok) throw new Error(`Proveedor SMS respondió HTTP ${response.status}`);
    } finally { clearTimeout(timer); }
  }

  private async finish(row: { id: string; userId: string; type: string; sourceEventId: string }, status: NotificationStatus, reason: string | null) {
    const source = await this.db.processedEvent.findUnique({ where: { eventId: row.sourceEventId } });
    if (!source) return;
    await this.db.$transaction(async (tx) => {
      const changed = await tx.notification.updateMany({ where: { id: row.id, status: { in: [NotificationStatus.pending, status] } }, data: { status, sentAt: status === NotificationStatus.sent ? new Date() : undefined, lastError: reason } });
      if (!changed.count) return;
      await tx.outboxEvent.create({ data: { eventType: status === NotificationStatus.sent ? 'notification.sent' : 'notification.failed', routingKey: status === NotificationStatus.sent ? 'notification.sent' : 'notification.failed', aggregateId: row.id, correlationId: source.correlationId, payload: { notification_id: row.id, user_id: row.userId, type: row.type, source_event_id: row.sourceEventId, status, ...(reason ? { reason: reason.slice(0, 250) } : {}) } } });
    });
  }

  private async contact(userId: string, payload: Record<string, unknown>): Promise<Contact | null> {
    if (String(payload.user_id ?? '') === userId && typeof payload.email === 'string') return { id: userId, email: payload.email, full_name: typeof payload.full_name === 'string' ? payload.full_name : undefined };
    const base = (this.config.get<string>('IDENTITY_SERVICE_URL') ?? 'http://identity-service:3003').replace(/\/+$/, '');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) return null;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${base}/api/v1/internal/users/${encodeURIComponent(userId)}/contact`, { headers: { 'x-internal-api-key': key }, signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Identity contact HTTP ${response.status}`);
      return await response.json() as Contact;
    } finally { clearTimeout(timer); }
  }

  private async resolveRecipients(payload: Record<string, unknown>): Promise<string[]> {
    const recipients = new Set(recipientIds(payload));
    const producerId = text(payload.producer_id ?? payload.producerId, 80);
    if (!producerId || !UUID.test(producerId)) return [...recipients];
    const base = (this.config.get<string>('PRODUCER_SERVICE_URL') ?? 'http://producer-service:3001').replace(/\/+$/, '');
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) return [...recipients];
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${base}/internal/producers/${encodeURIComponent(producerId)}/user`, { headers: { 'x-internal-api-key': key }, signal: controller.signal });
      if (!response.ok) throw new Error(`Producer owner lookup HTTP ${response.status}`);
      const result = await response.json() as { user_id?: unknown };
      const userId = String(result.user_id ?? '');
      if (UUID.test(userId)) recipients.add(userId);
    } finally { clearTimeout(timer); }
    return [...recipients];
  }
}

function validateEnvelope(event: EventEnvelope) {
  if (!event || !UUID.test(String(event.event_id)) || !UUID.test(String(event.entity_id)) || !UUID.test(String(event.correlation_id)) ||
    !event.event_type || !event.source_service || !Number.isInteger(event.entity_version) || event.entity_version < 1 || !Number.isInteger(event.schema_version) || event.schema_version < 1 ||
    !Number.isFinite(Date.parse(event.occurred_at)) || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new BadRequestException('Sobre de evento inválido');
  }
}

function recipientIds(payload: Record<string, unknown>) {
  const candidates = [payload.recipient_user_id, payload.user_id, payload.userId, payload.buyer_id, payload.buyerId, payload.buyer_user_id, payload.producer_user_id, payload.driver_user_id];
  if (Array.isArray(payload.recipient_user_ids)) candidates.push(...payload.recipient_user_ids);
  return [...new Set(candidates.map((candidate) => String(candidate ?? '')).filter((id) => UUID.test(id)))];
}

function makeNotification(event: EventEnvelope, userId: string, channel: NotificationChannel, preferenceId: string | null, contact: Contact | null, phone: string | null): PreparedNotification {
  const { title, message } = notificationCopy(event);
  return { userId, type: event.event_type, title, message, preferenceId, channel, email: channel === NotificationChannel.email ? contact?.email ?? null : null, phone: channel === NotificationChannel.sms ? phone : null };
}

function notificationCopy(event: EventEnvelope) {
  const p = event.payload; const order = text(p.order_number ?? p.orderNumber, 60) ?? `pedido ${String(p.order_id ?? p.orderId ?? '').slice(-6)}`;
  const name = text(p.product_name ?? p.productName, 100) ?? 'un producto';
  const amount = text(p.amount ?? p.gross_amount, 40);
  const copies: Record<string, [string, string]> = {
    'identity.user_created': ['Bienvenido a FarmToTable', 'Tu cuenta ya está activa. Explora productos frescos directos del campo.'],
    'identity.user_disabled': ['Actualización de cuenta', 'El acceso a tu cuenta fue desactivado. Si crees que es un error, contacta al equipo de soporte.'],
    'identity.roles_changed': ['Tu cuenta fue actualizada', 'Se actualizaron los permisos asociados a tu cuenta.'],
    'order.confirmed': ['Pedido confirmado', `Tu ${order} fue confirmado y ya está en preparación.`],
    'order.cancelled': ['Pedido cancelado', `Tu ${order} fue cancelado. Revisa el saldo disponible en tu TerraWallet.`],
    'delivery.scheduled': ['Entrega programada', `La entrega de tu ${order} ya tiene una ventana programada.`],
    'delivery.completed': ['Entrega completada', `La entrega de tu ${order} fue completada.`],
    'delivery.partial': ['Entrega parcial', `La entrega de tu ${order} se cerró parcialmente. El saldo no utilizado se liberó.`],
    'delivery.failed': ['No se pudo completar la entrega', `La entrega de tu ${order} no se pudo completar. Revisa el detalle del pedido.`],
    'delivery.cancelled': ['Entrega cancelada', `La entrega de tu ${order} fue cancelada.`],
    'payment.captured': ['Pago confirmado', `El pago de tu ${order} fue confirmado${amount ? ` por ${amount} COP` : ''}.`],
    'payment.completed': ['Pago confirmado', `El pago de tu ${order} fue confirmado${amount ? ` por ${amount} COP` : ''}.`],
    'payment.authorized': ['Pago autorizado', `El saldo para tu ${order} quedó reservado mientras se completa la entrega.`],
    'payment.failed': ['No se pudo autorizar el pago', `No pudimos confirmar el saldo para tu ${order}. Revisa tu TerraWallet antes de intentar de nuevo.`],
    'payment.refunded': ['Reembolso registrado', `Se registró un reembolso${amount ? ` por ${amount} COP` : ''} para tu ${order}.`],
    'payout.scheduled': ['Liquidación programada', 'Tu liquidación de ventas fue programada.'],
    'payout.completed': ['Liquidación completada', 'La transferencia de tu liquidación fue completada.'],
    'rating.created': ['Gracias por calificar tu compra', `Tu calificación de ${text(p.score, 1) ?? '—'} de 5 quedó registrada.`,],
    'cold_chain.alert': ['Alerta de cadena de frío', `La entrega ${String(p.delivery_id ?? '').slice(-6)} superó el umbral de temperatura. Revisa el lote y registra la inspección.`],
    'stock.low': ['Existencias bajas', `Las existencias de ${name} están por debajo del nivel recomendado.`],
    'product.available': ['Producto disponible', `${name} ya está disponible en el catálogo.`],
    'product.unavailable': ['Producto no disponible', `${name} ya no está disponible temporalmente.`],
  };
  const [title, message] = copies[event.event_type] ?? ['Novedad de FarmToTable', 'Tienes una actualización en FarmToTable.'];
  return { title: title.slice(0, 160), message };
}

function text(value: unknown, max: number) { const result = String(value ?? '').trim(); return result && result.length <= max ? result : null; }
function isUnique(error: unknown) { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'P2002'); }
async function enqueueStatus(tx: Prisma.TransactionClient, notificationId: string, userId: string, type: string, event: EventEnvelope, eventType: string) {
  await tx.outboxEvent.create({ data: { eventType, routingKey: eventType, aggregateId: notificationId, correlationId: event.correlation_id, payload: { notification_id: notificationId, user_id: userId, type, source_event_id: event.event_id, status: 'sent' } } });
}
