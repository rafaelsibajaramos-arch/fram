import { api, sesion } from '../api.js';
import { el, vaciar, boton, aviso, fmtFecha, fmtKg } from '../ui.js';
import { logisticsMutation, destinationEditor } from './operations.js';
import { liveTracking, deliveryStages } from '../live-tracking.js';

const statusNames = { scheduled: 'Pendiente de despacho', in_transit: 'En camino', completed: 'Entregada', partial: 'Recepción parcial', failed: 'Entrega fallida', cancelled: 'Cancelada' };
export async function vistaEntregas(root) {
  vaciar(root).append(el('h1', {}, sesion.roles.includes('producer') ? 'Entregas de mis ventas' : 'Mis entregas'), el('p', { class: 'subtitulo' }, 'Sigue el recorrido y confirma los productos recibidos. Los transportes de prueba aparecen identificados como simulados.'));
  const list = el('div', { class: 'delivery-live-list' });
  const error = el('p', { role: 'status', class: 'operations-error' });
  root.append(list, error);
  const cards = new Map(); let disposed = false, timer, busy = false;
  const ordersPromise = sesion.roles.some(r => ['buyer', 'producer', 'admin'].includes(r)) ? api.listarPedidos().catch(() => []) : Promise.resolve([]);
  const observer = new MutationObserver(() => { if (!list.isConnected) { disposed = true; clearTimeout(timer); observer.disconnect(); } });
  observer.observe(document.body, { childList: true, subtree: true });
  const refresh = async () => {
    if (disposed || busy) return; busy = true;
    try {
      const rows = await api.logistica('GET', 'deliveries');
      const orders = await ordersPromise;
      error.textContent = '';
      if (!rows.length && !cards.size) list.textContent = 'Tus entregas aparecerán aquí cuando se confirme un pedido pagado.';
      if (rows.length && !cards.size) vaciar(list);
      for (const row of rows) {
        const order = orders.find(o => o.id === row.orderId);
        row.productNames = (order?.items ?? []).filter(i => row.lots.some(l => l.orderItemId === i.id)).map(i => i.productName).filter(Boolean);
        let card = cards.get(row.id);
        if (!card) { card = deliveryCard(row, refresh, cards.size === 0); cards.set(row.id, card); list.append(card.root); }
        card.update(row);
      }
    } catch (e) { error.textContent = `${e.message ?? 'No se pudo actualizar'} · Se reintentará automáticamente.`; }
    finally { busy = false; if (!disposed) { clearTimeout(timer); timer = setTimeout(refresh, 5000); } }
  };
  root.insertBefore(boton('Actualizar entregas', refresh, 'btn btn-sutil'), list);
  await refresh();
}
function deliveryCard(initial, refresh, open) {
  let delivery = initial, trackingState;
  const title = el('strong'), status = el('span', { class: 'entrega-estado' }), destination = el('span'), weight = el('strong');
  const detail = el('details', { class: 'entrega-detalle', open }, el('summary', {}, 'Ver recorrido y recepción'));
  const controls = el('section', { class: 'receipt-controls' });
  const info = el('p', { class: 'pista' });
  const tracking = liveTracking(initial.id, t => { trackingState = t; status.textContent = deliveryStages[t.stage] ?? statusNames[t.status]; updateControls(); });
  detail.append(info, tracking, controls);
  const root = el('section', { class: 'entrega-compacta' }, el('div', { class: 'entrega-cabecera' }, title, status), el('div', { class: 'entrega-resumen' }, destination, weight), detail);
  function updateControls() {
    const arrived = trackingState?.stage === 'arrived' || delivery.stops?.some(s => s.type === 'dropoff' && s.actualAt);
    const buyerConfirmed = delivery.buyerConfirmedAt || trackingState?.receipt?.buyerConfirmedAt;
    const completed = delivery.closedAt || trackingState?.closedAt;
    const mode = !delivery.canConfirm ? 'viewer' : buyerConfirmed ? 'confirmed' : completed && (trackingState?.status ?? delivery.status) === 'completed' ? 'acknowledge' : !completed && arrived ? 'receive' : 'waiting';
    if (controls.dataset.mode === mode) return;
    controls.dataset.mode = mode; vaciar(controls);
    if (completed) controls.append(boton('Imprimir comprobante', () => printReceipt(delivery), 'btn btn-sutil btn-chico'));
    if (mode === 'confirmed') { controls.append(el('p', { class: 'tracking-confirmed' }, 'Recepción confirmada por ti. Gracias por tu compra.')); return; }
    if (mode === 'viewer') { if (delivery.canManage) controls.append(el('a', { class: 'btn btn-sutil', href: '#/logistica' }, 'Gestionar asignación y recorrido')); return; }
    if (mode === 'waiting') { controls.append(el('p', { class: 'pista' }, 'Podrás confirmar la recepción cuando el repartidor llegue al destino.')); return; }
    const name = el('input', { class: 'input', required: true, minLength: 2, maxLength: 150, placeholder: 'Nombre de quien recibe', 'aria-label': 'Nombre de quien recibe' });
    const notes = el('textarea', { class: 'input', maxLength: 500, placeholder: 'Observaciones; mínimo 5 caracteres si hay faltantes', 'aria-label': 'Observaciones de recepción' });
    const quantities = mode === 'receive' ? delivery.lots.map((lot, i) => ({ lot, input: el('input', { class: 'input', type: 'number', required: true, min: 0, max: Number(lot.quantityKg), value: Number(lot.quantityKg), step: 0.001, 'aria-label': `Kilos recibidos del lote ${i + 1}` }) })) : [];
    const feedback = el('p', { class: 'operations-error', role: 'alert' });
    const submit = el('button', { class: 'btn', type: 'submit' }, 'Confirmar recepción');
    controls.append(el('p', {}, mode === 'acknowledge' ? 'El recorrido terminó automáticamente por simulación. Confirma si recibiste el pedido; esta confirmación no vuelve a cobrar.' : 'Confirma lo que recibiste. Cualquier diferencia genera una solicitud de devolución por Wompi.'), el('form', { class: 'operations-form', onsubmit: async event => {
      event.preventDefault(); if (submit.disabled) return; submit.disabled = true; feedback.textContent = '';
      try {
        if (mode === 'acknowledge') await logisticsMutation('POST', `deliveries/${delivery.id}/acknowledge`, { receivedByName: name.value, receiptNotes: notes.value });
        else {
          const acceptedLots = quantities.map(q => ({ reservationId: q.lot.reservationId, acceptedQuantityKg: Number(q.input.value) }));
          const total = acceptedLots.reduce((n, q) => n + q.acceptedQuantityKg, 0), full = quantities.every(q => Number(q.input.value) === Number(q.lot.quantityKg));
          const status = full ? 'completed' : total > 0 ? 'partial' : 'failed';
          if (!full && notes.value.trim().length < 5) throw new Error('Describe qué producto faltó o no aceptaste.');
          await logisticsMutation('PATCH', `deliveries/${delivery.id}/confirm`, { status, acceptedLots, receivedByName: name.value, receiptNotes: notes.value, ...(full ? {} : { reason: notes.value }) });
        }
        aviso('Recepción registrada'); await refresh(); await tracking.refresh();
      } catch (e) { feedback.textContent = e.message; }
      finally { submit.disabled = false; }
    } }, name, ...quantities.map((q,i) => el('label', {}, `Lote ${i + 1}: despachados ${fmtKg(q.lot.quantityKg)}`, q.input)), notes, feedback, submit));
  }
  return { root, update(row) {
    delivery = row;
    title.textContent = row.productNames?.join(' · ') || `Pedido ${row.orderId.slice(0, 8).toUpperCase()}`;
    status.textContent = trackingState ? deliveryStages[trackingState.stage] : statusNames[row.status];
    destination.textContent = row.deliveryAddress; weight.textContent = fmtKg(row.lots.reduce((n,l) => n + Number(l.quantityKg), 0));
    info.textContent = `Ventana de entrega: ${fmtFecha(row.windowStart)} — ${fmtFecha(row.windowEnd)}`;
    if (!row.routeId && row.canManage && !controls.querySelector('[data-destination]')) {
      const button = boton('Confirmar ubicación y recogida', async () => { try { destinationEditor(row, await api.logistica('GET','logistics/zones'), refresh); } catch(e) { aviso(e.message, '', 'mal'); } }, 'btn btn-sutil'); button.dataset.destination = 'true'; info.append(button);
    }
    updateControls();
  } };
}
function printReceipt(d) {
  const popup = window.open('', '_blank'); if (!popup) { aviso('Permite las ventanas emergentes para imprimir', '', 'info'); return; }
  const doc = popup.document; doc.title = 'FarmToTable · comprobante de recepción';
  const style = doc.createElement('style'); style.textContent = 'body{font:15px/1.7 Arial;margin:40px;color:#17382a}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}table{width:100%;border-collapse:collapse}@media print{button{display:none}}'; doc.head.append(style);
  const add = (tag, text, parent = doc.body) => { const node = doc.createElement(tag); node.textContent = text; parent.append(node); return node; };
  add('h1','FarmToTable · recepción'); add('p','Pedido: '+d.orderId); add('p',d.deliveryAddress); add('p','Estado: '+(statusNames[d.status] ?? d.status)+' · '+fmtFecha(d.closedAt));
  add('p',d.completionSource === 'simulation' ? 'Cierre automático de recorrido SIMULADO.' : 'Recepción registrada por el comprador.');
  add('p',d.buyerConfirmedAt ? 'Confirmación personal: '+fmtFecha(d.buyerConfirmedAt) : 'Pendiente de confirmación personal del comprador.');
  if(d.receivedByName)add('p','Recibido por: '+d.receivedByName);
  const table=add('table',''),head=add('tr','',table);['Lote','Despachado','Aceptado'].forEach(x=>add('th',x,head));
  d.lots.forEach((l,i)=>{const row=add('tr','',table);[String(i+1),fmtKg(l.quantityKg),fmtKg(l.acceptedQuantityKg??0)].forEach(x=>add('td',x,row));});
  if(d.receiptNotes)add('p',d.receiptNotes);add('small','Constancia operativa. No constituye una factura fiscal.');const print=add('button','Imprimir / guardar PDF');print.onclick=()=>popup.print();
}
