import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service'; import { DomainEvent, EventsService } from './events.service';
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(OutboxWorker.name); private timer?: NodeJS.Timeout; private running = false;
  constructor(private readonly db: PrismaService, private readonly events: EventsService) {}
  onModuleInit(): void { this.timer = setInterval(() => void this.flush(), 1000); void this.flush(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  async flush(): Promise<void> { if (this.running || !this.events.isConnected()) return; this.running = true; try { for (const row of await this.db.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { occurredAt: 'asc' }, take: 50 })) { try { await this.events.publish({ event_id: row.id, event_type: row.eventType, source_service: row.sourceService, entity_id: row.entityId, entity_version: row.entityVersion, schema_version: row.schemaVersion, occurred_at: row.occurredAt.toISOString(), correlation_id: row.correlationId, payload: row.payload as Record<string, unknown> } satisfies DomainEvent); await this.db.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null } }); } catch (error) { await this.db.outboxEvent.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lastError: (error as Error).message } }); } } } catch (error) { this.log.error((error as Error).message); } finally { this.running = false; } }
}
