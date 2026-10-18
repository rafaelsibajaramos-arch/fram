import type { Lot } from './types';

export type DeliveryOutcome = {
  status: 'completed' | 'partial' | 'failed';
  acceptedLots: { reservationId: string; acceptedQuantityKg: number }[];
};

export function buildDeliveryOutcome(lots: Lot[], inputs: Record<string, string>): DeliveryOutcome {
  if (!lots.length) throw new Error('La entrega no tiene lotes registrados.');

  const acceptedLots = lots.map((lot) => {
    const raw = (inputs[lot.reservationId] ?? String(lot.quantityKg)).trim().replace(',', '.');
    const acceptedQuantityKg = Number(raw);
    const maximum = Number(lot.quantityKg);
    if (!raw || !Number.isFinite(acceptedQuantityKg) || acceptedQuantityKg < 0) {
      throw new Error('Cada cantidad recibida debe ser un número igual o mayor que cero.');
    }
    if (!Number.isFinite(maximum) || maximum <= 0 || acceptedQuantityKg > maximum) {
      throw new Error('La cantidad recibida no puede superar la cantidad transportada.');
    }
    if (Math.abs(acceptedQuantityKg * 1000 - Math.round(acceptedQuantityKg * 1000)) > 1e-7) {
      throw new Error('Registra las cantidades con máximo tres decimales.');
    }
    return { reservationId: lot.reservationId, acceptedQuantityKg };
  });

  const expected = lots.reduce((total, lot) => total + Number(lot.quantityKg), 0);
  const accepted = acceptedLots.reduce((total, lot) => total + lot.acceptedQuantityKg, 0);
  const status = accepted <= 0
    ? 'failed'
    : Math.abs(expected - accepted) < 0.0005
      ? 'completed'
      : 'partial';

  return { status, acceptedLots };
}
