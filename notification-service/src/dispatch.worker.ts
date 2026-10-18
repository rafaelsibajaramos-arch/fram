import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Injectable()
export class DispatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly notifications: NotificationsService) {}
  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), Math.max(1000, Number(process.env.NOTIFICATION_POLL_MS ?? 3000)));
    this.timer.unref?.(); void this.tick();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.notifications.dispatchPending(); }
    catch (error) { this.logger.error(`No se pudo despachar notificaciones: ${(error as Error).message}`); }
    finally { this.running = false; }
  }
}
