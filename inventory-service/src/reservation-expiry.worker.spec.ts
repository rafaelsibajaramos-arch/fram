import { Logger } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { ReservationExpiryWorker } from './reservation-expiry.worker';

describe('ReservationExpiryWorker', () => {
  it('contains database failures and retries on the next tick', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const expireDue = jest.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(undefined);
    const worker = new ReservationExpiryWorker({ expireDue } as unknown as InventoryService);
    await expect(worker.tick()).resolves.toBeUndefined();
    await worker.tick();
    expect(expireDue).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
  it('does not overlap expiry runs', async () => {
    let finish!: () => void;
    const expireDue = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const worker = new ReservationExpiryWorker({ expireDue } as unknown as InventoryService);
    const first = worker.tick();
    await worker.tick();
    expect(expireDue).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});
