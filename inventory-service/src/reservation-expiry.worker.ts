import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InventoryService } from './inventory.service';

/** Libera reservas vencidas aun cuando no llegan nuevas solicitudes. */
@Injectable()
export class ReservationExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly log = new Logger(ReservationExpiryWorker.name);
  private running = false;
  constructor(private readonly inventory: InventoryService) {}
  onModuleInit() { this.timer = setInterval(() => void this.tick(), 30_000); }
  async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.inventory.expireDue(); }
    catch (error) { this.log.error('No se pudieron liberar las reservas vencidas', error instanceof Error ? error.stack : String(error)); }
    finally { this.running = false; }
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
