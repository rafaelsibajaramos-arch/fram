import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeliveryOutcome } from './workflow.ts';
import type { Lot } from './types.ts';

const lots: Lot[] = [
  { reservationId: 'lot-1', orderItemId: 'item-1', harvestBatchId: 'batch-1', farmId: 'farm-1', quantityKg: '3.000', pickupAddress: 'Finca A' },
  { reservationId: 'lot-2', orderItemId: 'item-2', harvestBatchId: 'batch-2', farmId: 'farm-2', quantityKg: '2.500', pickupAddress: 'Finca B' },
];

test('marca completa cuando se acepta todo el peso de todos los lotes', () => {
  const outcome = buildDeliveryOutcome(lots, {});
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.acceptedLots.map((lot) => lot.acceptedQuantityKg), [3, 2.5]);
});

test('marca parcial y conserva cantidades por reserva', () => {
  const outcome = buildDeliveryOutcome(lots, { 'lot-1': '2.75', 'lot-2': '1,250' });
  assert.equal(outcome.status, 'partial');
  assert.deepEqual(outcome.acceptedLots.map((lot) => lot.acceptedQuantityKg), [2.75, 1.25]);
});

test('marca fallida cuando no se acepta producto', () => {
  assert.equal(buildDeliveryOutcome(lots, { 'lot-1': '0', 'lot-2': '0' }).status, 'failed');
});

test('rechaza cantidades mayores a las transportadas', () => {
  assert.throws(() => buildDeliveryOutcome(lots, { 'lot-1': '3.001' }), /no puede superar/);
});

test('rechaza cantidades con más de tres decimales', () => {
  assert.throws(() => buildDeliveryOutcome(lots, { 'lot-1': '2.1234' }), /máximo tres/);
});

test('no permite cerrar una entrega sin lotes', () => {
  assert.throws(() => buildDeliveryOutcome([], {}), /no tiene lotes/);
});
