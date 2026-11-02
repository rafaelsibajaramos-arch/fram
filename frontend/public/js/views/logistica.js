import { api, sesion } from '../api.js';
import { el, vaciar, boton, avisarError, aviso, fmtFecha, fmtKg } from '../ui.js';
import { logisticsMutation, destinationEditor } from './operations.js';
import { routeMap } from '../logistics-map.js';

const call = (method, path, body) => method === 'GET' ? api.logistica(method, path, body) : logisticsMutation(method, path, body);
const names = { scheduled: 'Pendiente de despacho', planned: 'Planificada', in_transit: 'En camino', completed: 'Completada', partial: 'Recepción parcial', failed: 'Fallida', cancelled: 'Cancelada' };
const field = (label, input) => el('label', {}, el('span', {}, label), input);
const input = (type = 'text', extra = {}) => el('input', { class: 'input', type, required: true, ...extra });

function form(fields, action, refresh, label = 'Guardar') {
  const submit = el('button', { class: 'btn btn-primario', type: 'submit' }, label);
  const node = el('form', { style: 'display:grid;gap:12px;max-width:900px', onsubmit: async event => {
    event.preventDefault(); submit.disabled = true;
    try { if (await action() === false) return; aviso('Guardado'); await refresh(); }
    catch (error) { avisarError(error); }
    finally { submit.disabled = false; }
  } }, fields, submit);
  return node;
}

export async function vistaEntregas(root) {
  vaciar(root).append(el('h1', {}, 'Mis entregas'), el('p', { class: 'subtitulo' }, 'Consulta el avance y confirma lo recibido cuando llegue el transportista.'));
  root.append(boton('Actualizar seguimiento', async () => { try { await vistaEntregas(root); } catch (error) { avisarError(error); } }, 'btn btn-sutil'));
  const operator = sesion.roles.some(r => ['admin', 'logistics_admin', 'driver'].includes(r));
  const [deliveries, orders, routes] = await Promise.all([call('GET', 'deliveries'), sesion.esAdmin || sesion.roles.includes('buyer') ? api.listarPedidos() : Promise.resolve([]), operator ? call('GET', 'routes') : Promise.resolve([])]);
  if (!deliveries.length) root.append(el('p', {}, 'Todavía no tienes entregas programadas. Los pedidos confirmados aparecerán aquí.'));
  for (const d of deliveries) {
    const order = orders.find(o => o.id === d.orderId);
    const arrived = d.stops.some(s => s.type === 'dropoff' && s.actualAt);
    const ready = d.status === 'in_transit' && arrived;
    const totalKg = d.lots.reduce((sum, lot) => sum + Number(lot.quantityKg), 0);
    const node = el('section', { class: 'entrega-compacta' },
      el('div', { class: 'entrega-cabecera' }, el('strong', {}, (order?.items ?? []).map(i => i.productName ?? 'Producto').join(', ') || 'Entrega'), el('span', { class: `entrega-estado entrega-${d.status}` }, ready ? 'Pendiente de recepción' : names[d.status] ?? d.status)),
      el('div', { class: 'entrega-resumen' }, el('span', {}, d.deliveryAddress), el('strong', {}, fmtKg(totalKg))));
    const detail = el('details', { class: 'entrega-detalle', open: ready && d.canConfirm }, el('summary', {}, ready && d.canConfirm ? 'Actualizar estado / confirmar recepción' : operator && ['scheduled', 'in_transit'].includes(d.status) ? 'Ver detalle / actualizar estado' : 'Ver detalle y seguimiento'));
    detail.append(el('p', {}, `Entrega prevista: ${fmtFecha(d.windowStart)} — ${fmtFecha(d.windowEnd)}`));
    const tracking = el('div', { class: 'delivery-tracking' });
    detail.append(tracking);
    const loadTracking = async () => {
      try {
        const t = await call('GET', `deliveries/${d.id}/tracking`);
        vaciar(tracking).append(el('ol', { class: 'delivery-timeline' }, [
          ['Pedido programado', true, null], ['En camino', !!t.dispatchedAt, t.dispatchedAt],
          ['Llegada registrada', t.stops.some(s => s.type === 'dropoff' && s.actualAt), t.stops.find(s => s.type === 'dropoff')?.actualAt],
          ['Recepción resuelta', !!t.closedAt, t.closedAt],
        ].map(([label, done, at]) => el('li', { class: done ? 'done' : '' }, el('strong', {}, label), el('small', {}, at ? fmtFecha(at) : done ? 'Registrado' : 'Pendiente')))),
        t.position ? el('p', { class: 'pista' }, `${t.position.stale ? 'Señal antigua · última ubicación' : 'Ubicación del conductor'}: ${fmtFecha(t.position.recordedAt)} · precisión ${Math.round(t.position.accuracy)} m`) : el('p', { class: 'pista' }, 'El conductor aún no ha compartido una ubicación para esta entrega.'),
        routeMap({ stops: t.stops, position: t.position }),
        ...t.incidents.map(i => el('p', { class: 'operations-activity' }, `${i.resolvedAt ? 'Resuelta' : 'Incidencia'}: ${i.message}`)));
      } catch (e) { vaciar(tracking).append(el('p', { class: 'operations-error' }, e.message)); }
    };
    detail.addEventListener('toggle', () => { if (detail.open) loadTracking(); });
    detail.append(boton('Actualizar seguimiento', loadTracking, 'btn btn-sutil btn-chico'));
    if (!d.routeId && d.status === 'scheduled') detail.append(boton(d.locationConfirmedAt ? 'Revisar punto de entrega' : 'Confirmar punto de entrega', async () => {
      try { destinationEditor(d, await call('GET', 'logistics/zones'), () => vistaEntregas(root)); } catch (e) { avisarError(e); }
    }, 'btn btn-sutil btn-chico'));
    if (order) detail.append(el('p', {}, `Compra: ${fmtFecha(order.createdAt)}`));
    if (d.route) detail.append(el('p', {}, `Vehículo: ${d.route.vehicle.plate}`));
    if (d.closedAt) detail.append(boton('Imprimir comprobante de recepción', () => {
      const popup = window.open('', '_blank');
      if (!popup) { aviso('Permite las ventanas emergentes para imprimir el comprobante', '', 'info'); return; }
      popup.document.title = `Recepción ${d.orderId.slice(0, 8)}`;
      const style = popup.document.createElement('style'); style.textContent = 'body{font:14px/1.6 Arial;margin:40px;color:#17382a}h1{font-size:24px}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #ddd;padding:12px}small{color:#68776e}button{padding:10px;margin:20px 0}@media print{button{display:none}}';
      popup.document.head.append(style);
      const doc = popup.document;
      const add = (tag, value, parent = doc.body) => { const node = doc.createElement(tag); node.textContent = value; parent.append(node); return node; };
      add('h1', 'FarmToTable · comprobante de recepción'); add('p', `Pedido: ${d.orderId}`); add('p', `Entrega: ${d.id}`); add('p', `Destino: ${d.deliveryAddress}`); add('p', `Estado: ${names[d.status] ?? d.status} · ${fmtFecha(d.closedAt)}`);
      if (d.receivedByName) add('p', `Recibido por: ${d.receivedByName}`);
      const table = add('table', ''); const header = add('tr', '', table); ['Producto / lote', 'Despachado', 'Aceptado'].forEach(x => add('th', x, header));
      d.lots.forEach((lot, i) => { const row = add('tr', '', table); [order?.items?.find(item => item.id === lot.orderItemId)?.productName ?? `Lote ${i + 1}`, fmtKg(lot.quantityKg), fmtKg(lot.acceptedQuantityKg ?? 0)].forEach(x => add('td', x, row)); });
      if (d.receiptNotes) add('p', `Observaciones: ${d.receiptNotes}`);
      add('small', 'Constancia operativa de recepción registrada por la cuenta autorizada. No constituye una factura fiscal.');
      const print = add('button', 'Imprimir / guardar PDF'); print.onclick = () => popup.print();
    }, 'btn btn-sutil btn-chico'));
    if (['scheduled', 'in_transit'].includes(d.status)) detail.append(el('p', { class: 'pista' }, ready ? 'Llegada registrada. El comprador puede actualizar la recepción.' : d.status === 'scheduled' ? 'Esperando asignación de ruta o despacho por logística.' : 'El transportista debe registrar la llegada antes de confirmar la recepción.'));
    if (operator && ['scheduled', 'in_transit'].includes(d.status)) {
      const route = routes.find(r => r.id === d.routeId);
      const next = route?.stops.find(s => !s.actualAt);
      const mutate = (label, path) => boton(label, async () => { try { await call('PATCH', path); await vistaEntregas(root); } catch (error) { avisarError(error); } }, 'btn btn-sutil btn-chico');
      if (!route) detail.append(el('a', { href: '#/logistica', class: 'btn btn-sutil btn-chico' }, 'Asignar ruta'));
      else if (route.status === 'planned') detail.append(mutate('Actualizar a: en camino', `routes/${route.id}/dispatch`));
      else if (next?.deliveryId === d.id) detail.append(el('p', {}, next.address), mutate(next.type === 'pickup' ? 'Registrar recogida' : 'Registrar llegada al comprador', `routes/${route.id}/stops/${next.id}/arrive`));
      else if (!arrived) detail.append(el('a', { href: '#/logistica', class: 'btn btn-sutil btn-chico' }, 'Continuar paradas de la ruta'));
    }
    if (d.status === 'in_transit' && arrived && d.canConfirm) {
      detail.append(el('p', { class: 'pista' }, 'Los kilos recibidos determinan el estado: completa, parcial o rechazada.'));
      const quantities = d.lots.map((lot, i) => ({ lot, control: input('number', { value: lot.quantityKg, min: 0, max: lot.quantityKg, step: '0.001', 'aria-label': `Kilos recibidos del lote ${i + 1}` }) }));
      const reason = el('textarea', { class: 'input', maxLength: 500, placeholder: 'Motivo obligatorio si faltó o rechazaste producto (mínimo 5 caracteres)' });
      const receiver = input('text', { placeholder: 'Nombre de quien recibe', minLength: 2, maxLength: 150 });
      detail.append(field('Nombre para el comprobante de recepción', receiver));
      detail.append(form(quantities.map(({ lot, control }, i) => field(`${order?.items?.find(item => item.id === lot.orderItemId)?.productName ?? 'Producto'} · lote ${i + 1}: despachados ${fmtKg(lot.quantityKg)}`, control)).concat(field('Observación de recepción', reason)), async () => {
        const acceptedLots = quantities.map(({ lot, control }) => ({ reservationId: lot.reservationId, acceptedQuantityKg: Number(control.value) }));
        const total = acceptedLots.reduce((n, lot) => n + lot.acceptedQuantityKg, 0);
        const complete = quantities.every(({ lot, control }) => Number(control.value) === Number(lot.quantityKg));
        const status = complete ? 'completed' : total > 0 ? 'partial' : 'failed';
        if (!confirm('¿Confirmas estas cantidades? Esta recepción determina el cobro del pedido.')) return false;
        if (!receiver.checkValidity()) { receiver.reportValidity(); return false; }
        await call('PATCH', `deliveries/${d.id}/confirm`, { status, acceptedLots, receivedByName: receiver.value, receiptNotes: reason.value, ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) });
      }, () => vistaEntregas(root), 'Actualizar estado y confirmar recepción'));
    } else for (const [i, lot] of d.lots.entries()) detail.append(el('p', {}, `Lote ${i + 1}: ${fmtKg(lot.quantityKg)} · Aceptado: ${lot.acceptedQuantityKg == null ? 'pendiente' : fmtKg(lot.acceptedQuantityKg)}`));
    node.append(detail);
    root.append(node);
  }
}

export { vistaCentroLogistico as vistaLogistica } from './operations.js';
