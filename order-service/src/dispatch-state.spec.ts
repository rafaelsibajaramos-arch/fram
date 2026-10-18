import { OrdersService } from './orders.service';
import { EventEnvelope } from './events/event-envelope';

const orderId = '11111111-1111-4111-8111-111111111111';
const event: EventEnvelope = { event_id: '22222222-2222-4222-8222-222222222222', entity_id: orderId, entity_version: 1, schema_version: 1, occurred_at: new Date().toISOString(), correlation_id: orderId, event_type: 'delivery.in_transit', source_service: 'logistics-service', payload: { order_id: orderId } };
describe('Estados controlados por cumplimiento', () => {
  it('solo avanza pedidos confirmados, sin regresar estados terminales', async () => {
    const db: any = { order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    await new OrdersService(db).consumeDeliveryInTransit(event);
    expect(db.order.updateMany).toHaveBeenCalledWith({ where: { id: orderId, status: 'confirmed' }, data: { status: 'dispatched' } });
  });
  it('rechaza un evento de despacho de otro servicio', async () => {
    await expect(new OrdersService({} as any).consumeDeliveryInTransit({ ...event, source_service: 'identity-service' })).rejects.toThrow('no confiable');
  });
  it('impide marcar manualmente un pedido como entregado', async () => {
    const db: any = { order: { findUnique: jest.fn().mockResolvedValue({ id: orderId, status: 'confirmed' }), update: jest.fn() } };
    await expect(new OrdersService(db).updateStatus(orderId, 'delivered')).rejects.toThrow('saltar');
    expect(db.order.update).not.toHaveBeenCalled();
  });
});
