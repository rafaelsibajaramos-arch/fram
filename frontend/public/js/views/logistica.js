import { api, sesion } from '../api.js';
import { el, vaciar, boton, avisarError, aviso, fmtFecha, fmtKg } from '../ui.js';

const call = (method, path, body) => api.logistica(method, path, body);
const names = { scheduled: 'Pendiente de despacho', planned: 'Planificada', in_transit: 'En camino', completed: 'Completada', partial: 'Recepción parcial', failed: 'Fallida', cancelled: 'Cancelada' };
const field = (label, input) => el('label', {}, el('span', {}, label), input);
const input = (type = 'text', extra = {}) => el('input', { class: 'input', type, required: true, ...extra });
const select = (rows, label) => el('select', { class: 'input', required: true }, el('option', { value: '' }, 'Selecciona…'), rows.map(row => el('option', { value: row.id ?? row.code }, label(row))));
const panel = (title, ...children) => el('section', { class: 'panel', style: 'padding:24px;margin:18px 0' }, el('h2', {}, title), ...children);
const localDate = value => { const d = new Date(value); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

function form(fields, action, refresh) {
  const submit = el('button', { class: 'btn btn-primario', type: 'submit' }, 'Guardar');
  const node = el('form', { style: 'display:grid;gap:12px;max-width:900px', onsubmit: async event => {
    event.preventDefault(); submit.disabled = true;
    try { if (await action() === false) return; aviso('Guardado'); await refresh(); }
    catch (error) { avisarError(error); }
    finally { submit.disabled = false; }
  } }, fields, submit);
  return node;
}

export async function vistaEntregas(root) {
  vaciar(root).append(el('h1', {}, 'Mis entregas'), el('p', {}, 'El transportista registra la llegada. Después confirma únicamente los kilos que recibiste. Se cobrará lo aceptado y se liberará el resto del saldo reservado.'));
  root.append(boton('Actualizar seguimiento', async () => { try { await vistaEntregas(root); } catch (error) { avisarError(error); } }, 'btn btn-sutil'));
  const [deliveries, orders] = await Promise.all([call('GET', 'deliveries'), sesion.esAdmin || sesion.roles.includes('buyer') ? api.listarPedidos() : Promise.resolve([])]);
  if (!deliveries.length) root.append(el('p', {}, 'Todavía no tienes entregas programadas. Los pedidos confirmados aparecerán aquí.'));
  for (const d of deliveries) {
    const order = orders.find(o => o.id === d.orderId);
    const node = panel(`Entrega · ${names[d.status] ?? d.status}`, el('p', {}, d.deliveryAddress), el('p', {}, `Ventana: ${fmtFecha(d.windowStart)} — ${fmtFecha(d.windowEnd)}`));
    if (order) node.append(el('p', {}, `Compra: ${fmtFecha(order.createdAt)} · ${(order.items ?? []).map(i => i.productName ?? 'Producto').join(', ')}`));
    if (d.route) node.append(el('p', {}, `Vehículo: ${d.route.vehicle.plate}`));
    const arrived = d.stops.some(s => s.type === 'dropoff' && s.actualAt);
    node.append(el('p', {}, arrived ? 'El transportista registró la llegada al destino.' : 'Aún no se ha registrado la llegada al destino.'));
    if (d.status === 'in_transit' && arrived && d.canConfirm) {
      const quantities = d.lots.map((lot, i) => ({ lot, control: input('number', { value: lot.quantityKg, min: 0, max: lot.quantityKg, step: '0.001', 'aria-label': `Kilos recibidos del lote ${i + 1}` }) }));
      const reason = el('textarea', { class: 'input', maxLength: 500, placeholder: 'Motivo obligatorio si faltó o rechazaste producto (mínimo 5 caracteres)' });
      node.append(form(quantities.map(({ lot, control }, i) => field(`${order?.items?.find(item => item.id === lot.orderItemId)?.productName ?? 'Producto'} · lote ${i + 1}: despachados ${fmtKg(lot.quantityKg)}`, control)).concat(field('Observación de recepción', reason)), async () => {
        const acceptedLots = quantities.map(({ lot, control }) => ({ reservationId: lot.reservationId, acceptedQuantityKg: Number(control.value) }));
        const total = acceptedLots.reduce((n, lot) => n + lot.acceptedQuantityKg, 0);
        const complete = quantities.every(({ lot, control }) => Number(control.value) === Number(lot.quantityKg));
        const status = complete ? 'completed' : total > 0 ? 'partial' : 'failed';
        if (!confirm('¿Confirmas estas cantidades? Esta recepción determina el cobro del pedido.')) return false;
        await call('PATCH', `deliveries/${d.id}/confirm`, { status, acceptedLots, ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) });
      }, () => vistaEntregas(root)));
    } else for (const [i, lot] of d.lots.entries()) node.append(el('p', {}, `Lote ${i + 1}: ${fmtKg(lot.quantityKg)} · Aceptado: ${lot.acceptedQuantityKg == null ? 'pendiente' : fmtKg(lot.acceptedQuantityKg)}`));
    root.append(node);
  }
}

export async function vistaLogistica(root) {
  vaciar(root).append(el('h1', {}, 'Logística y rutas'), el('p', {}, 'Planificar → despachar → recoger en finca → llegar al comprador → confirmar recepción → cerrar cobro.'));
  const refresh = async () => { try { await vistaLogistica(root); } catch (error) { avisarError(error); } };
  root.append(boton('Actualizar rutas', refresh, 'btn btn-sutil'));
  const admin = sesion.roles.some(r => ['admin', 'logistics_admin'].includes(r));
  const [routes, deliveries] = await Promise.all([call('GET', 'routes'), call('GET', 'deliveries')]);
  if (admin) {
    const [zones, drivers, vehicles] = await Promise.all([call('GET', 'logistics/zones'), call('GET', 'drivers'), call('GET', 'vehicles')]);
    const zoneCode = input(), zoneName = input();
    root.append(panel('Zonas de cobertura', el('p', {}, zones.map(z => `${z.name} (${z.code})`).join(' · ') || 'Sin zonas'), form([field('Código', zoneCode), field('Nombre', zoneName)], () => call('POST', 'logistics/zones', { code: zoneCode.value, name: zoneName.value }), refresh)));
    const plate = input(), capacity = input('number', { min: 0.001, step: 0.001 }), cold = input('checkbox', { required: false });
    root.append(panel('Vehículos', el('p', {}, vehicles.map(v => `${v.plate} · ${fmtKg(v.capacityKg)}${v.refrigerated ? ' · refrigerado' : ''}`).join(' / ') || 'Sin vehículos'), form([field('Placa', plate), field('Capacidad kg', capacity), field('Refrigerado', cold)], () => call('POST', 'vehicles', { plate: plate.value, capacityKg: Number(capacity.value), refrigerated: cold.checked }), refresh)));
    const user = input(), fullName = input(), phone = input('tel'), license = input();
    if (sesion.esAdmin) {
      const result = await api.listarUsuarios();
      const users = Array.isArray(result) ? result : result.items ?? result.data ?? [];
      const chooser = select(users.filter(u => u.roles?.includes('driver')), u => `${u.full_name ?? u.fullName ?? u.email} · ${u.email}`);
      user.hidden = true; user.required = false;
      chooser.onchange = () => { user.value = chooser.value; const selected = users.find(u => u.id === chooser.value); fullName.value = selected?.full_name ?? selected?.fullName ?? ''; };
      root.append(panel('Transportistas', el('p', {}, 'Primero asigna el rol driver en Usuarios y roles. Luego vincula su perfil de transporte.'), form([field('Usuario transportista', chooser), user, field('Nombre', fullName), field('Teléfono', phone), field('Licencia', license)], () => call('POST', 'drivers', { userId: user.value, fullName: fullName.value, phone: phone.value, licenseNumber: license.value }), refresh)));
    }
    root.append(el('p', {}, `Transportistas activos: ${drivers.filter(d => d.active).map(d => d.fullName).join(', ') || 'ninguno'}`));
    const pending = deliveries.filter(d => d.status === 'scheduled' && !d.routeId);
    const driver = select(drivers.filter(d => d.active), d => d.fullName), vehicle = select(vehicles.filter(v => v.active), v => `${v.plate} · ${fmtKg(v.capacityKg)}`), zone = select(zones.filter(z => z.active), z => z.name);
    const start = input('datetime-local'), end = input('datetime-local');
    const boxes = pending.map(d => ({ d, check: input('checkbox', { required: false }), eta: input('datetime-local', { required: false, value: localDate(d.windowStart) }) }));
    root.append(panel('Planificar ruta', el('p', {}, 'Selecciona entregas de la misma zona y revisa sus ventanas. Se proponen recogidas primero y destinos después; el servidor comprueba capacidad, cadena de frío y solapamientos. No se cambia la ventana prometida.'), form([
      field('Zona', zone), field('Transportista', driver), field('Vehículo', vehicle), field('Inicio de recogidas', start), field('Fin de ruta', end),
      ...boxes.map(({ d, check, eta }) => el('div', {}, field(`${d.deliveryAddress} · ${fmtKg(d.lots.reduce((n, l) => n + Number(l.quantityKg), 0))} · ${fmtFecha(d.windowStart)} — ${fmtFecha(d.windowEnd)}`, check), field('Hora prevista de entrega', eta))),
      !pending.length ? el('p', {}, 'No hay entregas pendientes de asignación.') : null,
    ], async () => {
      const selected = boxes.filter(b => b.check.checked);
      if (!selected.length) throw new Error('Selecciona al menos una entrega');
      const begin = new Date(start.value).getTime(), finish = new Date(end.value).getTime();
      const stops = [];
      const pickups = selected.flatMap(({ d }) => [...new Map(d.lots.map(l => [l.farmId, l])).values()].map(l => ({ deliveryId: d.id, type: 'pickup', farmId: l.farmId, address: l.pickupAddress })));
      const firstDrop = Math.min(...selected.map(b => new Date(b.eta.value).getTime()));
      if (!Number.isFinite(begin) || !Number.isFinite(finish) || !Number.isFinite(firstDrop) || begin >= firstDrop || firstDrop > finish) throw new Error('Las recogidas deben preceder a las entregas y estar dentro del horario');
      pickups.forEach((p, i) => stops.push({ ...p, sequence: stops.length + 1, plannedAt: new Date(begin + (firstDrop - begin) * i / (pickups.length + 1)).toISOString() }));
      selected.sort((a, b) => new Date(a.eta.value) - new Date(b.eta.value)).forEach(({ d, eta }) => stops.push({ deliveryId: d.id, type: 'dropoff', address: d.deliveryAddress, sequence: stops.length + 1, plannedAt: new Date(eta.value).toISOString() }));
      await call('POST', 'routes', { driverId: driver.value, vehicleId: vehicle.value, zoneCode: zone.value, scheduledDate: new Date(begin).toISOString(), scheduledEnd: new Date(finish).toISOString(), deliveryIds: selected.map(b => b.d.id), stops });
    }, refresh)));
  }
  if (!routes.length) root.append(el('p', {}, 'No tienes rutas asignadas.'));
  for (const route of routes) {
    const node = panel(`${names[route.status] ?? route.status} · ${route.zone.name}`, el('p', {}, `${route.driver.fullName} · ${route.vehicle.plate} · ${fmtFecha(route.scheduledDate)} — ${fmtFecha(route.scheduledEnd)}`));
    const action = (label, method, path, body) => boton(label, async () => { try { await call(method, path, body); await refresh(); } catch (error) { avisarError(error); } }, 'btn btn-sutil');
    if (route.status === 'planned') node.append(action('Iniciar ruta y despachar', 'PATCH', `routes/${route.id}/dispatch`));
    for (const stop of route.stops) {
      const row = el('p', {}, `${stop.sequence}. ${stop.type === 'pickup' ? 'Recogida' : 'Entrega'} · ${stop.address} · ${fmtFecha(stop.plannedAt)}${stop.actualAt ? ' · Registrada ' + fmtFecha(stop.actualAt) : ''}`);
      if (route.status === 'in_transit' && !stop.actualAt && !route.stops.some(s => s.sequence < stop.sequence && !s.actualAt)) row.append(action('Registrar llegada', 'PATCH', `routes/${route.id}/stops/${stop.id}/arrive`));
      node.append(row);
    }
    for (const d of route.deliveries.filter(d => d.status === 'in_transit')) {
      const reason = input('text', { minLength: 5, maxLength: 500 }), temp = input('number', { step: '0.01' });
      const detail = el('details', {}, el('summary', {}, `Entrega: ${d.deliveryAddress} · pendiente de recepción del comprador`));
      detail.append(form([field('Temperatura °C', temp)], () => call('POST', `deliveries/${d.id}/temperature`, { temperature: Number(temp.value), recordedAt: new Date().toISOString(), sensorEventId: crypto.randomUUID() }), refresh));
      detail.append(el('p', {}, 'Si no fue posible entregar, registra el motivo. Se aceptarán cero kilos y no se cobrará esta entrega.'), form([field('Motivo de entrega fallida', reason)], async () => {
        if (!confirm('¿Registrar entrega fallida con cero kilos aceptados?')) return false;
        await call('PATCH', `deliveries/${d.id}/close`, { status: 'failed', reason: reason.value, acceptedLots: d.lots.map(l => ({ reservationId: l.reservationId, acceptedQuantityKg: 0 })) });
      }, refresh));
      node.append(detail);
    }
    root.append(node);
  }
}
