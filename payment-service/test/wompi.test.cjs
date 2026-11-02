const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { checkoutUrl, cents, verifyEvent, wompiConfig } = require('../dist/wompi');
const { PaymentsService } = require('../dist/payments.service');
const { WompiRefundsWorker } = require('../dist/wompi-refunds.worker');
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
function config() { Object.assign(process.env, { WOMPI_PUBLIC_KEY: 'pub_test_unit', WOMPI_PRIVATE_KEY: 'prv_test_unit', WOMPI_INTEGRITY_SECRET: 'test_integrity_unit', WOMPI_EVENTS_SECRET: 'test_events_unit', WOMPI_REDIRECT_URL: 'https://shop.example/#/pedidos' }); }
function event(transaction) {
  config(); const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents']; const timestamp = 123;
  const checksum = createHash('sha256').update(properties.map(p => transaction[p.slice(12)]).join('') + timestamp + process.env.WOMPI_EVENTS_SECRET).digest('hex');
  return { event: 'transaction.updated', environment: 'test', data: { transaction }, timestamp, signature: { properties, checksum } };
}
const id='11111111-1111-4111-8111-111111111111';
const buyer='22222222-2222-4222-8222-222222222222';
function fixture() {
  const payment={ id, orderId:id, buyerId:buyer, amount:new Prisma.Decimal('12.34'), currency:'COP', provider:'wompi', providerReference:'FTT-'+id, providerStatus:null, providerTransactionId:null, status:'pending', cancellationRequested:false };
  const outbox=[],refunds=[];
  const tx={ payment:{ findUnique:async()=>({...payment}),update:async({data})=>Object.assign(payment,data) }, outboxEvent:{create:async({data})=>outbox.push(data)},wompiRefundOperation:{upsert:async({create})=>refunds.push(create)} };
  return { payment,outbox,refunds, service:new PaymentsService({$transaction:async cb=>cb(tx)}) };
}
test('centavos y firma de checkout incluyen referencia, monto y vencimiento exactos',()=>{
  config();const expires=new Date('2030-01-01T12:00:00Z');const url=new URL(checkoutUrl('ref',new Prisma.Decimal('12.34'),expires));
  assert.equal(url.searchParams.get('amount-in-cents'),'1234');
  assert.equal(url.searchParams.get('signature:integrity'),createHash('sha256').update('ref1234COP'+expires.toISOString()+'test_integrity_unit').digest('hex'));
  assert.throws(()=>cents(new Prisma.Decimal('1.234')));assert.throws(()=>cents(new Prisma.Decimal('-1')));
});
test('rechaza llaves de producción en modo sandbox',()=>{config();process.env.WOMPI_PUBLIC_KEY='pub_prod_other';assert.throws(wompiConfig);config();});
test('firma manipulada y evento de producción no son aceptados',()=>{const body=event({id:'trx',status:'APPROVED',amount_in_cents:1234});body.data.transaction.amount_in_cents=1;assert.throws(()=>verifyEvent(body));body.environment='prod';assert.throws(()=>verifyEvent(body));});
test('aprobación verificada publica solo una autorización ante reintentos',async()=>{
  const f=fixture();const transaction={id:'trx',reference:f.payment.providerReference,status:'APPROVED',amount_in_cents:1234,currency:'COP'};
  global.fetch=async()=>({ok:true,json:async()=>({data:transaction})});const body=event(transaction);
  await f.service.wompiEvent(body);await f.service.wompiEvent(body);
  assert.equal(f.payment.providerStatus,'APPROVED');assert.equal(f.outbox.length,1);assert.equal(f.outbox[0].eventType,'payment.checkout_authorized');
});
test('firma válida no permite un monto diferente al pedido ni confirma pagos',async()=>{
  const f=fixture();const t={id:'trx',reference:f.payment.providerReference,status:'APPROVED',amount_in_cents:1,currency:'COP'};
  global.fetch=async()=>({ok:true,json:async()=>({data:t})});await assert.rejects(f.service.wompiEvent(event(t)));assert.equal(f.outbox.length,0);
});
test('consulta fallida de Wompi conserva pago pendiente para reentrega del webhook',async()=>{
  const f=fixture();global.fetch=async()=>({ok:false});await assert.rejects(f.service.wompiEvent(event({id:'trx',status:'APPROVED',amount_in_cents:1234})));assert.equal(f.payment.status,'pending');
});
test('rechazo no publica autorización de compra',async()=>{const f=fixture();const t={id:'trx',reference:f.payment.providerReference,status:'DECLINED',amount_in_cents:1234,currency:'COP'};global.fetch=async()=>({ok:true,json:async()=>({data:t})});await f.service.wompiEvent(event(t));assert.equal(f.outbox[0].eventType,'payment.checkout_authorization_rejected');});
test('aprobación tardía de compra cancelada genera reembolso sin despacho',async()=>{const f=fixture();f.payment.cancellationRequested=true;const t={id:'trx',reference:f.payment.providerReference,status:'APPROVED',amount_in_cents:1234,currency:'COP'};global.fetch=async()=>({ok:true,json:async()=>({data:t})});await f.service.wompiEvent(event(t));assert.equal(f.refunds.length,1);assert.equal(f.outbox.length,0);assert.equal(f.payment.status,'voided');});
test('checkout de otro comprador no expone URL de pago',async()=>{const s=new PaymentsService({payment:{findUnique:async()=>({buyerId:buyer})}});await assert.rejects(s.checkoutSession(id,'other'));});
test('reserva consistente crea un pago pendiente, nunca un débito ficticio',async()=>{config();let saved;const s=new PaymentsService({processedEvent:{findFirst:async()=>null},payment:{findUnique:async()=>null,create:async({data})=>(saved=data)}});await s.authorizeCheckoutFromInventory({event_type:'inventory.order_reserved',source_service:'inventory-service',payload:{order_id:id,buyer_id:buyer,total_amount:'12.34',currency:'COP',items:[{subtotal:'12.34'}]}});assert.equal(saved.status,'pending');assert.equal(saved.provider,'wompi');});
test('reembolso incierto no se vuelve a enviar automáticamente',async()=>{
  config();let state='pending',calls=0;
  const job={id,paymentId:id,operationKey:'settle:'+id,amount:new Prisma.Decimal(1),payment:{provider:'wompi',providerStatus:'APPROVED',providerTransactionId:'trx'}};
  const db={payment:{findMany:async()=>[]},wompiRefundOperation:{findMany:async()=>state==='pending'?[job]:[],updateMany:async()=>{state='submitting';return{count:1}},update:async({data})=>{state=data.status}}};
  global.fetch=async()=>{calls++;throw Error('timeout')};const worker=new WompiRefundsWorker(db);await worker.flush();await worker.flush();assert.equal(state,'unknown');assert.equal(calls,1);
});
