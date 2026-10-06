import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InventoryService } from './inventory.service';

/** Libera reservas vencidas aun cuando no llegan nuevas solicitudes. */
@Injectable()
export class ReservationExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private readonly inventory: InventoryService) {}
  onModuleInit() { this.timer = setInterval(() => void this.inventory.expireDue(), 30_000); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
