import { api, sesion } from '../api.js';
import { el, vaciar, boton, aviso, fmtFecha, fmtKg, fmtDinero } from '../ui.js';
import { liveTracking } from '../live-tracking.js';
import { locationPicker, routeMap } from '../logistics-map.js';

const read = path => api.logistica('GET', path);
const pendingOperations = new Map();
export async function logisticsMutation(method, path, body = {}) {
  const key = JSON.stringify([sesion.userId, method, path, body]);
  if (!pendingOperations.has(key)) pendingOperations.set(key, crypto.randomUUID());
  const result = await api.logistica(method, path, { ...body, operation_id: pendingOperations.get(key) });
  pendingOperations.delete(key);
  return result;
}
const names = { planned: 'Planificada', in_transit: 'En camino', completed: 'Completada', cancelled: 'Cancelada', scheduled: 'Sin despachar', partial: 'Recepción parcial', failed: 'Fallida', available: 'Disponible', maintenance: 'Mantenimiento', out_of_service: 'Fuera de servicio' };
const incidentNames = { delay: 'Retraso', damage: 'Daño de carga', absence: 'Cliente ausente', breakdown: 'Avería', cold_chain: 'Cadena de frío', other: 'Otra incidencia' };
const kinds = { car: 'Automóvil', bicycle: 'Bicicleta', cargo_bike: 'Bicicleta de carga', van: 'Furgón', truck: 'Camión', pickup: 'Camioneta', motorcycle: 'Motocicleta' };
const vehicleName = v => `${kinds[v.kind] ?? v.kind} · ${v.plate} · hasta ${fmtKg(v.capacityKg)}`;
const field = (name, control, help) => {
  control.setAttribute('aria-label', name);
  return el('label', { class: 'operations-field' }, el('span', {}, name), control, help ? el('small', {}, help) : null);
};
const input = (type = 'text', props = {}) => el('input', { class: 'input', type, required: true, ...props });
const choose = (rows, label, value = '') => el('select', { class: 'input', required: true, value }, el('option', { value: '' }, 'Seleccionar…'), rows.map(r => el('option', { value: r.id ?? r.code ?? r.value, selected: (r.id ?? r.code ?? r.value) === value }, label(r))));
const badge = status => el('span', { class: `ops-badge ops-${status}` }, names[status] ?? status);
const short = id => id?.slice(0, 8).toUpperCase() ?? '—';
const kg = d => d.lots.reduce((n, l) => n + Number(l.quantityKg), 0);
const datetime = d => { const x = new Date(d); return new Date(x - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const panel = (title, ...children) => el('section', { class: 'operations-panel' }, el('div', { class: 'operations-panel-head' }, el('h2', {}, title)), ...children);
const empty = (title, detail, action) => el('div', { class: 'operations-empty' }, el('strong', {}, title), el('p', {}, detail), action);
const stat = (label, value, note) => el('div', { class: 'operations-stat' }, el('span', {}, label), el('strong', {}, value), el('small', {}, note ?? ''));
function table(headers, rows) {
  const head = el('thead', {}, el('tr', {}, headers.map(h => el('th', {}, h))));
  const body = el('tbody', {}, rows.map(row => el('tr', {}, row.map((cell, i) => el('td', { dataset: { label: headers[i] } }, cell)))));
  return el('div', { class: 'operations-table-wrap' }, el('table', { class: 'operations-table' }, head, body));
}
function action(label, task, primary = false) {
  const error = el('span', { class: 'operations-error', role: 'alert', hidden: true });
  const button = boton(label, async () => {
    button.disabled = true; error.hidden = true;
    try { await task(); } catch (e) { error.textContent = e.message ?? 'No se pudo completar la operación'; error.hidden = false; }
    finally { button.disabled = false; }
  }, primary ? 'btn btn-primario' : 'btn btn-sutil btn-chico');
  return el('span', { class: 'operations-action' }, button, error);
}
function form(fields, save, label = 'Guardar cambios') {
  const error = el('p', { class: 'operations-error', role: 'alert', hidden: true });
  const submit = el('button', { type: 'submit', class: 'btn btn-primario' }, label);
  return el('form', { class: 'operations-form', onsubmit: async e => {
    e.preventDefault(); if (submit.disabled) return; submit.disabled = true; error.hidden = true;
    try { await save(); } catch (e) { error.textContent = e.message; error.hidden = false; }
    finally { submit.disabled = false; }
  } }, el('div', { class: 'operations-form-grid' }, fields), error, submit);
}
function dialog(title, build) {
  const content = el('div', { class: 'operations-dialog-body' });
  const node = el('dialog', { class: 'operations-dialog', 'aria-label': title }, el('div', { class: 'operations-dialog-head' }, el('h2', {}, title), boton('Cerrar', () => node.close(), 'btn btn-sutil btn-chico')), content);
  const listeners = new AbortController();
  window.addEventListener('hashchange', () => node.close(), { signal: listeners.signal });
  window.addEventListener('ftt:expired', () => node.close(), { signal: listeners.signal });
  node.addEventListener('close', () => { listeners.abort(); node.remove(); }, { once: true });
  document.body.append(node); node.showModal(); build(content, () => node.close());
  return node;
}

export function destinationEditor(delivery, zones, onSaved) {
  dialog('Confirmar destino de entrega', (root, close) => {
    const picker = locationPicker({ latitude: delivery.latitude, longitude: delivery.longitude, address: delivery.deliveryAddress, title: delivery.deliveryAddress });
    const cold = input('checkbox', { required: false, checked: !!delivery.requiresColdChain });
    const logisticsAdmin = sesion.roles.some(r => ['admin', 'logistics_admin'].includes(r));
    const managesPickup = logisticsAdmin || sesion.roles.includes('producer');
    const ready = input('datetime-local', { value: datetime(delivery.pickupReadyAt ?? Date.now() + 20 * 60000), required: false });
    const deadline = input('datetime-local', { value: datetime(delivery.pickupDeadlineAt ?? delivery.windowEnd), required: false });
    root.append(el('p', { class: 'pista' }, 'Confirma con el comprador que el punto corresponde a la dirección. Se conserva la dirección original del pedido.'), picker,
      form([managesPickup ? field('Producto listo para recoger desde', ready) : null, managesPickup ? field('Recoger como máximo a las', deadline) : null, logisticsAdmin ? field('Requiere transporte refrigerado', cold, 'Confirma la condición de conservación de los productos de esta entrega.') : null], async () => {
        const point = picker.value(); if (!point) throw new Error('Selecciona el punto exacto de entrega');
        await logisticsMutation('PATCH', `deliveries/${delivery.id}/location`, { ...point, zoneCode: 'AUTO', ...(managesPickup && ready.value ? { pickupReadyAt: new Date(ready.value).toISOString() } : {}), ...(managesPickup && deadline.value ? { pickupDeadlineAt: new Date(deadline.value).toISOString() } : {}), ...(logisticsAdmin ? { requiresColdChain: cold.checked } : {}) }); close(); await onSaved();
      }, 'Confirmar ubicación'));
  });
}

function dispatchEditor(delivery, onSaved) {
  dialog('Confirmar salida de la mercancía', (root, close) => {
    const first = delivery.lots[0];
    const picker = locationPicker({ latitude: delivery.dispatchLatitude ?? Number(first?.pickupLatitude), longitude: delivery.dispatchLongitude ?? Number(first?.pickupLongitude), address: delivery.dispatchAddress ?? first?.pickupAddress ?? '', title: 'Dirección real donde el repartidor recogerá la mercancía' });
    root.append(el('p', { class: 'pista' }, 'Elige el acceso por carretera de tu finca o centro de despacho. La procedencia del lote se conserva; confirma que la mercancía estará físicamente en este punto.'), picker,
      action('Guardar punto de recogida', async () => {
        const point = picker.value(); if (!point) throw new Error('Busca y selecciona un punto sobre la calle o ajusta el marcador.');
        await logisticsMutation('PATCH', `deliveries/${delivery.id}/dispatch`, { address: picker.addressValue(), ...point });
        close(); await onSaved();
      }, true));
  });
}

export async function vistaCentroLogistico(root) {
  const admin = sesion.roles.some(r => ['admin', 'logistics_admin'].includes(r));
  const producer = !admin && sesion.roles.includes('producer');
  const manager = admin || producer;
  let tab = admin ? 'overview' : producer ? 'planning' : 'routes';
  let data;
  vaciar(root);
  const title = el('header', { class: 'operations-heading' }, el('div', {}, el('small', { class: 'operations-eyebrow' }, 'FARMTOTABLE / OPERACIONES'), el('h1', {}, admin ? 'Centro logístico' : producer ? 'Logística de mis ventas' : 'Mi jornada de transporte'), el('p', {}, admin ? 'Organiza tu flota. Conecta cada pedido con su destino.' : 'Tus rutas, próximas paradas e incidencias en un solo lugar.')));
  const refreshButton = action('Actualizar datos', async () => { await load(); render(); }); title.append(refreshButton);
  const nav = el('nav', { class: 'operations-tabs', 'aria-label': 'Secciones de logística' });
  const body = el('div', { class: 'operations-content' }); root.append(title, nav, body);
  const load = async () => {
    const resources = manager ? await read('logistics/resources') : { vehicles: [], drivers: [], reservations: [] };
    const [routes, deliveries, vehicles, drivers, zones, overview] = await Promise.all([read('routes'), read('deliveries'), admin ? read('vehicles') : resources.vehicles, admin ? read('drivers') : resources.drivers, manager ? read('logistics/zones') : [], admin ? read('logistics/overview') : null]);
    data = { routes, deliveries, vehicles, drivers, zones, overview, reservations: resources.reservations };
  };
  const refresh = async () => { await load(); render(); };
  const go = next => { tab = next; render(); };
  const tabs = admin ? [['overview', 'Resumen'], ['fleet', 'Flota'], ['drivers', 'Conductores'], ['planning', 'Planificación'], ['routes', 'Rutas y seguimiento']] : producer ? [['planning', 'Asignar entregas'], ['routes', 'Rutas y seguimiento']] : [['routes', 'Mis rutas']];
  function render() {
    vaciar(nav); tabs.forEach(([id, label]) => { const b = boton(label, () => go(id), `operations-tab ${tab === id ? 'active' : ''}`); b.setAttribute('aria-current', tab === id ? 'page' : 'false'); nav.append(b); });
    vaciar(body);
    ({ overview: renderOverview, fleet: renderFleet, drivers: renderDrivers, planning: renderPlanning, routes: renderRoutes })[tab]();
  }

  function renderOverview() {
    const s = data.overview;
    body.append(el('div', { class: 'operations-stats' }, stat('Rutas en camino', s.activeRoutes, 'Operación activa'), stat('Por asignar / despachar', s.pendingDeliveries, 'Entregas pendientes'), stat('Vehículos habilitados', s.availableVehicles, 'Disponibilidad depende del horario'), stat('Incidencias abiertas', s.openIncidents, 'Requieren revisión')));
    const active = data.routes.filter(r => ['planned', 'in_transit'].includes(r.status));
    body.append(el('div', { class: 'operations-overview-grid' }, panel('Operación en curso', active.length ? table(['Ruta', 'Vehículo / conductor', 'Estado', ''], active.slice(0, 7).map(r => [short(r.id), el('div', {}, el('strong', {}, r.vehicle.plate), el('small', { class: 'operations-muted' }, r.driver.fullName)), badge(r.status), action('Ver ruta', () => routeDetail(r))])) : empty('Todo al día', 'No hay rutas activas. Planifica las entregas confirmadas.', boton('Planificar ruta', () => go('planning'), 'btn btn-primario'))), panel('Calidad del servicio', stat('Entregas a tiempo', s.onTimePercent == null ? 'Sin datos' : `${s.onTimePercent}%`, `${s.dueDeliveries} entregas vencidas en la cobertura consultada`), stat('Recorrido planificado', `${s.distanceKm.toFixed(1)} km`, 'Rutas programadas en los últimos 30 días'), el('p', { class: 'pista' }, `Datos actualizados: ${fmtFecha(s.calculatedAt)}. El recorrido planificado no equivale a kilómetros medidos por GPS.`))));
    const unlocated = data.deliveries.filter(d => d.status === 'scheduled' && !d.routeId && (!d.locationConfirmedAt || !d.zoneCode));
    if (unlocated.length) body.append(panel('Destinos por verificar', el('p', {}, `${unlocated.length} entregas necesitan punto exacto o zona para calcular una ruta.`), table(['Pedido', 'Dirección', 'Carga', ''], unlocated.map(d => [short(d.orderId), d.deliveryAddress, fmtKg(kg(d)), action('Ubicar destino', () => destinationEditor(d, data.zones, refresh))]))));
    body.append(panel('Áreas internas de operación', el('p', { class: 'pista' }, 'El productor no necesita elegir una zona: el sistema usa la distribución automática. Estas áreas son etiquetas internas opcionales para administración.'), el('div', { class: 'operations-chip-row' }, data.zones.map(z => el('span', { class: `ops-badge ${z.active ? '' : 'ops-cancelled'}` }, z.name))), action('Crear área interna', () => dialog('Nueva área interna', (root, close) => {
      const code = input(), name = input(); root.append(form([field('Código', code), field('Nombre', name)], async () => { await logisticsMutation('POST', 'logistics/zones', { code: code.value, name: name.value }); close(); await refresh(); }, 'Registrar zona'));
    }))));
  }

  function vehicleEditor(vehicle = {}) {
    dialog(vehicle.id ? `Editar vehículo ${vehicle.plate}` : 'Registrar vehículo', (root, close) => {
      const baseCity = input('text', {value: vehicle.baseCity ?? '', maxLength:80, placeholder:'Monteria'}), baseDepartment = input('text', {value:vehicle.baseDepartment ?? '', maxLength:80, placeholder:'Cordoba'});
      const basePicker = locationPicker({latitude:vehicle.baseLatitude, longitude:vehicle.baseLongitude, address:vehicle.baseAddress ?? '', cityInput:baseCity, regionInput:baseDepartment, title:'Dirección de la base del vehículo'});
      root.append(el('div', { class: 'operations-form-grid' }, field('Ciudad base del vehículo', baseCity), field('Departamento base del vehículo', baseDepartment)), basePicker);
      const plate = input('text', { value: vehicle.plate ?? '', maxLength: 12 }), capacity = input('number', { value: vehicle.capacityKg ?? '', min: 0.001, step: 0.001 });
      const minimum = input('number', { value: vehicle.minimumLoadKg ?? 0, min: 0, step: 0.001 });
      const kind = choose(Object.entries(kinds).map(([value, name]) => ({ value, name })), r => r.name, vehicle.kind ?? 'van');
      const brand = input('text', { value: vehicle.brand ?? '', required: false, maxLength: 80 }), model = input('text', { value: vehicle.model ?? '', required: false, maxLength: 80 });
      const state = choose(['available', 'maintenance', 'out_of_service'].map(value => ({ value })), r => names[r.value], vehicle.operationalStatus ?? 'available');
      const cold = input('checkbox', { checked: !!vehicle.refrigerated, required: false });
      const cost = input('number', { value: vehicle.costPerKm ?? '', min: 0, step: 0.01, required: false });
      const insurance = input('date', { value: vehicle.insuranceUntil?.slice(0, 10) ?? '', required: false }), inspection = input('date', { value: vehicle.inspectionUntil?.slice(0, 10) ?? '', required: false });
      root.append(form([field('Placa', plate), field('Capacidad útil en kg', capacity), field('Carga mínima operativa (kg)', minimum), field('Tipo', kind), field('Estado operativo', state), field('Marca', brand), field('Modelo / referencia', model), field('Refrigeración', cold), field('Costo estimado por km (COP)', cost), field('Vencimiento SOAT', insurance), field('Vencimiento revisión técnica', inspection)], async () => {
        if (baseCity.value.trim().length < 2 || baseDepartment.value.trim().length < 2) throw new Error('Indica la ciudad y departamento de la base');
        const basePoint = basePicker.value(); if(!basePoint) throw new Error('Busca y confirma la direccion de la base del vehiculo');
        await logisticsMutation(vehicle.id ? 'PATCH' : 'POST', vehicle.id ? `vehicles/${vehicle.id}` : 'vehicles', { baseCity:baseCity.value, baseDepartment:baseDepartment.value, baseAddress:basePicker.addressValue(), baseLatitude:basePoint.latitude, baseLongitude:basePoint.longitude, costPerKm: cost.value === '' ? null : Number(cost.value), plate: plate.value, capacityKg: Number(capacity.value), minimumLoadKg: Number(minimum.value), kind: kind.value, brand: brand.value, model: model.value, operationalStatus: state.value, refrigerated: cold.checked, ...(insurance.value ? { insuranceUntil: insurance.value } : {}), ...(inspection.value ? { inspectionUntil: inspection.value } : {}) });
        close(); aviso('Vehículo guardado'); await refresh();
      }, 'Guardar vehículo'), el('p', { class: 'pista' }, 'Los vencimientos se registran como avisos. No sustituyen una verificación documental. No se pueden editar vehículos con rutas activas.'));
    });
  }
  function renderFleet() {
    const filter = input('search', { placeholder: 'Buscar por placa, marca o modelo', required: false, 'aria-label': 'Buscar vehículo' });
    const results = el('div');
    const paint = () => {
      const rows = data.vehicles.filter(v => `${v.plate} ${v.brand ?? ''} ${v.model ?? ''}`.toLowerCase().includes(filter.value.toLowerCase()));
      vaciar(results).append(rows.length ? table(['Vehículo', 'Capacidad', 'Condición', 'Operación', 'Acciones'], rows.map(v => {
        const assigned = data.routes.filter(r => r.vehicleId === v.id && ['planned', 'in_transit'].includes(r.status));
        return [el('div', {}, el('strong', {}, vehicleName(v)), el('small', {}, [v.baseCity,v.baseDepartment].filter(Boolean).join(', ') || 'Base pendiente de registrar'), el('small', { class: 'operations-muted' }, [v.brand, v.model].filter(Boolean).join(' ') || 'Sin referencia')), fmtKg(v.capacityKg), v.refrigerated ? 'Refrigerado' : 'Carga seca', el('div', {}, badge(v.active ? v.operationalStatus : 'out_of_service'), el('small', { class: 'operations-muted' }, `${assigned.length} rutas activas`)), el('div', { class: 'acciones' }, action('Editar', () => vehicleEditor(v)), action(v.active ? 'Desactivar' : 'Activar', async () => { await logisticsMutation('PATCH', `vehicles/${v.id}/active`, { active: !v.active }); await refresh(); }))];
      })) : empty('No hay vehículos para mostrar', data.vehicles.length ? 'Prueba otra búsqueda.' : 'Registra los vehículos reales de tu operación para comenzar.', boton('Registrar vehículo', () => vehicleEditor(), 'btn btn-primario')));
    };
    filter.addEventListener('input', paint);
    body.append(panel('Flota de transporte', el('div', { class: 'operations-toolbar' }, filter, boton('Registrar vehículo', () => vehicleEditor(), 'btn btn-primario')), results)); paint();
  }

  async function driverEditor(driver = {}) {
    dialog(driver.id ? 'Editar repartidor' : 'Registrar repartidor', (root, close) => {
      const simulated = input('checkbox', { required: false, checked: driver.simulated ?? true, disabled: !!driver.id });
      const user = choose(driver.userId ? [{ id: driver.userId, label: 'Cuenta registrada de ' + driver.fullName }] : [], r => r.label, driver.userId ?? '');
      const accountField = field('Cuenta de acceso del conductor', user);
      const selectAccount = async () => {
        accountField.hidden = simulated.checked; user.required = !simulated.checked;
        if (simulated.checked || driver.id) return;
        try {
          const result = await api.listarUsuarios();
          const accounts = (Array.isArray(result) ? result : result.items ?? []).filter(u => u.roles?.includes('driver'));
          vaciar(user).append(el('option', { value: '' }, 'Selecciona una cuenta de transportista'), ...accounts.map(u => el('option', { value: u.id }, `${u.full_name ?? u.email} · ${u.email}`)));
        } catch (e) { aviso(e.message, '', 'mal'); }
      };
      simulated.addEventListener('change', selectAccount); void selectAccount();
      const name = input('text', { value: driver.fullName ?? '', maxLength: 150 }), phone = input('tel', { value: driver.phone ?? '', minLength: 5, maxLength: 25 }), license = input('text', { value: driver.licenseNumber ?? '', minLength: 3, maxLength: 40 });
      const baseCity = input('text', {value:driver.baseCity ?? '',maxLength:80}), baseDepartment = input('text', {value:driver.baseDepartment ?? '',maxLength:80});
      const preparation = input('number', { value: driver.preparationMinutes ?? 15, min: 0, max: 120, step: 1 });
      root.append(el('p', { class: 'pista' }, 'Los perfiles simulados no necesitan una cuenta de acceso. Solo administración registra y habilita personas; los productores eligen entre las autorizadas.'), form([field('Ciudad base del repartidor', baseCity), field('Departamento base del repartidor', baseDepartment), field('Repartidor simulado', simulated), accountField, field('Nombre completo', name), field('Teléfono', phone), field('Número de licencia / identificación de prueba', license), field('Preparación mínima antes de salir (min)', preparation)], async () => {
        if (!simulated.checked && !user.value.trim()) throw new Error('Indica una cuenta con rol driver para un conductor real');
        await logisticsMutation(driver.id ? 'PATCH' : 'POST', driver.id ? 'drivers/' + driver.id : 'drivers', { ...(user.value.trim() ? { userId: user.value.trim() } : {}), baseCity:baseCity.value, baseDepartment:baseDepartment.value, simulated: simulated.checked, preparationMinutes: Number(preparation.value), fullName: name.value, phone: phone.value, licenseNumber: license.value }); close(); await refresh();
      }, 'Guardar repartidor'));
    });
  }
  function renderDrivers() {
    body.append(panel('Equipo de transporte', el('div', { class: 'operations-toolbar' }, el('p', {}, 'Repartidores habilitados para transporte real o simulado.'), admin ? action('Registrar conductor', () => driverEditor(), true) : el('p', { class: 'pista' }, 'Solicita a un administrador registrar las cuentas de nuevos conductores.')),
      data.drivers.length ? table(['Conductor', 'Contacto', 'Licencia', 'Rutas activas', 'Acciones'], data.drivers.map(d => [el('div', {}, el('strong', {}, d.fullName), el('small', {}, [d.baseCity,d.baseDepartment].filter(Boolean).join(', ') || 'Base pendiente de registrar'), badge(d.active ? 'available' : 'out_of_service')), d.phone, d.licenseNumber, String(data.routes.filter(r => r.driverId === d.id && ['planned', 'in_transit'].includes(r.status)).length), el('div', { class: 'acciones' }, action('Editar', () => driverEditor(d)), action(d.active ? 'Desactivar' : 'Activar', async () => { await logisticsMutation('PATCH', `drivers/${d.id}/active`, { active: !d.active }); await refresh(); }))])) : empty('Sin conductores registrados', 'Registra un repartidor simulado para comenzar las pruebas de entrega.')));
  }

  function renderPlanning() {
    const pending = data.deliveries.filter(d => d.status === 'scheduled' && !d.routeId && new Date(d.windowEnd) > new Date() && (admin || d.canManage));
    if (!pending.length) { body.append(empty('No hay entregas por asignar', 'Aquí aparecerán las compras pagadas que todavía no tienen repartidor.')); return; }
    const boxes = pending.map(d => ({ d, check: input('checkbox', { required: false, checked: pending.length === 1, 'aria-label': 'Incluir pedido ' + short(d.orderId) }) }));
    const selectedCount = el('span', { class: 'planning-count', role: 'status' });
    const updateCount = () => { const count = boxes.filter(b => b.check.checked).length; selectedCount.textContent = `${count} de ${boxes.length} ${boxes.length === 1 ? 'pedido seleccionado' : 'pedidos seleccionados'}`; };
    boxes.forEach(({ check }) => check.addEventListener('change', updateCount));
    const selectAll = boton('Seleccionar todos', () => { const shouldSelect = boxes.some(b => !b.check.checked); boxes.forEach(b => { b.check.checked = shouldSelect; }); selectAll.textContent = shouldSelect ? 'Quitar selección' : 'Seleccionar todos'; updateCount(); }, 'btn btn-sutil btn-chico');
    updateCount();
    const build = async () => {
      const ids = boxes.filter(b => b.check.checked).map(b => b.d.id);
      if (!ids.length) throw new Error('Selecciona los pedidos que deseas enviar');
      if (ids.length > 12) throw new Error('Agrupa como máximo 12 entregas por recorrido');
      const proposal = await api.logistica('POST', 'routes/auto-plan', { deliveryIds: ids });
      dialog('Despacho automático propuesto', (content, close) => {
        const s = proposal.selection, reviewed = input('checkbox', { required: false });
        let assigned;
        content.append(el('p', {}, `${s.driver} · ${s.baseCity}, ${s.baseDepartment} · ${kinds[s.kind] ?? s.kind} · ${s.vehicle} · carga ${s.totalKg} kg / máximo ${fmtKg(s.capacityKg)}`), el('p', { class: 'pista' }, `El repartidor sale de ${s.originAddress} y recoge la mercancía en ${proposal.dto.stops.find(stop => stop.type === 'pickup')?.address ?? 'el punto confirmado'}. Después continúa al comprador.`), el('p', {}, `${fmtFecha(proposal.dto.scheduledDate)} · ${(proposal.distance / 1000).toFixed(1)} km estimados · ${ids.length} entregas`), routeMap({ geometry: proposal.geometry, stops: proposal.dto.stops, origin: proposal.origin }), ...proposal.warnings.map(w => el('p', { class: 'pista' }, w)), field('Confirmo que el vehículo puede acceder a las calles de esta ruta', reviewed), action('Asignar e iniciar simulación', async () => {
          if (!reviewed.checked) throw new Error('Confirma el acceso del vehículo antes de iniciar');
          assigned ??= await api.logistica('POST', 'routes/confirm', { proposalId: proposal.proposalId, roadRestrictionsReviewed: true });
          await logisticsMutation('POST', `routes/${assigned.id}/simulation`, { action: 'start', speed: 30 });
          close(); await refresh(); go('routes');
        }, true));
      });
    };
    const cards = el('div', { class: 'planning-orders' }, boxes.map(({ d, check }) => el('article', { class: 'planning-order' },
      el('div', { class: 'planning-order-top' }, el('label', { class: 'planning-select' }, check, el('span', {}, `Pedido ${short(d.orderId)}`)), el('strong', { class: 'planning-weight' }, fmtKg(kg(d)))),
      el('div', { class: 'planning-order-locations' },
        el('div', { class: 'planning-location' }, el('span', { class: 'planning-step' }, '1'), el('div', {}, el('small', {}, 'RECOGIDA DE LA MERCANCÍA'), el('p', {}, d.dispatchAddress ?? d.lots[0]?.pickupAddress ?? 'Confirma el punto de recogida'), el('span', { class: d.dispatchAddress ? 'planning-confirmed' : 'planning-pending' }, d.dispatchAddress ? 'Punto confirmado por el productor' : 'Pendiente de confirmar'), action(d.dispatchAddress ? 'Cambiar punto' : 'Confirmar salida', () => dispatchEditor(d, refresh)))),
        el('div', { class: 'planning-location' }, el('span', { class: 'planning-step' }, '2'), el('div', {}, el('small', {}, 'ENTREGA AL COMPRADOR'), el('p', {}, d.deliveryAddress), el('span', { class: 'planning-window' }, `Recibir entre ${fmtFecha(d.windowStart)} y ${fmtFecha(d.windowEnd)}`)))))));
    body.append(panel('Organizar mis entregas', el('p', { class: 'planning-intro' }, 'Selecciona los pedidos. Confirma el lugar de recogida y calcularemos el transporte hasta el comprador.'), el('div', { class: 'planning-toolbar' }, selectedCount, selectAll), cards, el('div', { class: 'planning-actions' }, action('Organizar entregas automáticamente', build, true), boton('Elegir repartidor y vehículo manualmente', () => { vaciar(body); body.append(boton('Volver a asignación automática', () => { vaciar(body); renderPlanning(); }, 'btn btn-sutil')); renderAdvancedPlanning(); }, 'btn btn-sutil'))));
  }
  function renderAdvancedPlanning() {
    let proposal = null;
    const pending = data.deliveries.filter(d => d.status === 'scheduled' && !d.routeId && new Date(d.windowEnd) > new Date() && (admin || d.canManage));
    if (!pending.length) { body.append(empty('No hay entregas por planificar', 'Los pedidos confirmados aparecerán aquí cuando su carga esté reservada.')); return; }
    const driver = choose(data.drivers.filter(d => d.active), d => d.fullName + (d.simulated ? ' · SIMULADO' : '') + ' · preparación ' + d.preparationMinutes + ' min');
    const vehicle = choose(data.vehicles.filter(v => v.active && v.operationalStatus === 'available'), vehicleName);
    const start = input('datetime-local', { value: datetime(Math.max(Date.now() + 31 * 60000, Math.min(...pending.map(d => new Date(d.windowStart).getTime())))) }), end = input('datetime-local', { value: datetime(Math.max(Date.now() + 31 * 60000, Math.min(...pending.map(d => new Date(d.windowStart).getTime()))) + 8 * 3600000) }), service = input('number', { min: 1, max: 120, value: 2 });
    const preview = el('div', { class: 'operations-proposal', 'aria-live': 'polite' });
    const invalidate = () => { proposal = null; vaciar(preview); };
    const boxes = pending.map(d => ({ d, check: input('checkbox', { required: false }) }));
    const recommendations = el('div', { class: 'fleet-recommendations' });
    function updateRecommendations() {
      const chosen = boxes.filter(b => b.check.checked).map(b => b.d);
      const total = chosen.reduce((n,d) => n + kg(d), 0), largest = Math.max(0, ...chosen.map(kg));
      const cold = chosen.some(d => d.requiresColdChain);
      const busy = id => data.reservations.some(r => r.vehicleId === id && new Date(r.scheduledDate) < new Date(end.value) && new Date(r.scheduledEnd) > new Date(start.value));
      const candidates = data.vehicles.filter(v => v.active && v.operationalStatus === 'available' && !busy(v.id) && Number(v.capacityKg) >= largest && Number(v.minimumLoadKg ?? 0) <= total && (!cold || v.refrigerated)).sort((a,b) => Number(a.capacityKg) - Number(b.capacityKg));
      const preferred = candidates.filter(v => Number(v.capacityKg) >= total);
      const ranked = [...preferred, ...candidates.filter(v => !preferred.includes(v))];
      vaciar(recommendations).append(el('strong', {}, chosen.length ? total.toLocaleString('es-CO') + ' kg · ' + chosen.length + ' entregas seleccionadas' : 'Selecciona entregas para sugerir un vehículo'), ...ranked.slice(0,4).map((v,i) => boton((i === 0 ? 'Sugerido: ' : '') + vehicleName(v) + (total > Number(v.capacityKg) ? ' · viajes por tramos' : ''), () => { vehicle.value = v.id; invalidate(); }, 'btn btn-sutil btn-chico')));
      if (chosen.length && !ranked.length) recommendations.append(el('p', { class: 'operations-error' }, 'No hay un vehículo compatible y libre. Divide las entregas o cambia el horario.'));
    }
    const updateAvailability = () => {
      const begin = new Date(start.value), finish = new Date(end.value);
      if (Number.isFinite(begin.getTime()) && Number.isFinite(finish.getTime())) updateRecommendations();
      for (const [control, property] of [[vehicle, 'vehicleId'], [driver, 'driverId']]) for (const option of control.options) {
        const conflict = data.reservations.some(r => ['planned', 'in_transit'].includes(r.status) && r[property] === option.value && new Date(r.scheduledDate) < finish && new Date(r.scheduledEnd) > begin);
        option.disabled = conflict; if (conflict && control.value === option.value) control.value = '';
      }
    };
    [driver, vehicle, start, end, service, ...boxes.map(b => b.check)].forEach(c => c.addEventListener('change', () => { invalidate(); updateAvailability(); })); updateAvailability();
    const selection = table(['Incluir', 'Pedido / destino', 'Carga', 'Ventana', 'Puntos'], boxes.map(({ d, check }) => [check, el('div', {}, el('strong', {}, short(d.orderId)), el('small', { class: 'operations-muted' }, d.deliveryAddress)), el('div', {}, fmtKg(kg(d)), d.requiresColdChain ? el('small', {}, 'Requiere frío') : null), `${fmtFecha(d.windowStart)} — ${fmtFecha(d.windowEnd)}`, el('div', {}, action('Recogida', () => dispatchEditor(d, refresh)), action('Destino', () => destinationEditor(d, data.zones, refresh)))]));
    body.append(panel('Elegir transporte manualmente', el('p', { class: 'pista' }, 'La zona se administra automáticamente. El recorrido sale de la base del vehículo, recoge en el punto confirmado del productor y llega al comprador.'), selection, recommendations,
      form([field('Conductor', driver), field('Vehículo', vehicle), field('Salida prevista', start), field('Fin máximo de ruta', end), field('Minutos en cada parada', service)], async () => {
        const selected = boxes.filter(b => b.check.checked); if (!selected.length) throw new Error('Selecciona una o más entregas');
        const v = data.vehicles.find(item => item.id === vehicle.value);
        if (!v || v.baseLatitude == null || v.baseLongitude == null) throw new Error('Administración debe confirmar la dirección base del vehículo');
        proposal = await api.logistica('POST', 'routes/preview', { driverId: driver.value, vehicleId: vehicle.value, zoneCode: 'AUTO', scheduledDate: new Date(start.value).toISOString(), scheduledEnd: new Date(end.value).toISOString(), serviceMinutes: Number(service.value), originLatitude: Number(v.baseLatitude), originLongitude: Number(v.baseLongitude), deliveryIds: selected.map(b => b.d.id) });
        const reviewed = input('checkbox', { required: true });
        vaciar(preview).append(el('div', { class: 'operations-proposal-title' }, el('h2', {}, 'Propuesta de recorrido'), badge('planned')), el('div', { class: 'operations-stats' }, stat('Distancia', `${(proposal.distance / 1000).toFixed(1)} km`), stat('Conducción estimada', `${Math.ceil(proposal.duration / 60)} min`), stat('Carga máxima', fmtKg(proposal.peakLoadKg), proposal.estimatedCost == null ? 'Sin costo por km registrado' : `Costo estimado: ${fmtDinero(proposal.estimatedCost)} COP`), stat('Finalización estimada', fmtFecha(proposal.estimatedEnd))), routeMap({ geometry: proposal.geometry, stops: proposal.dto.stops, origin: proposal.origin }), table(['Parada', 'Destino', 'Hora prevista', 'Carga a bordo'], proposal.dto.stops.map(s => [`${s.sequence}. ${s.type === 'pickup' ? 'Recoger' : 'Entregar'}`, s.address, fmtFecha(s.plannedAt), fmtKg(s.loadKg)])), el('p', { class: 'pista' }, proposal.warnings.join(' ')), el('p', { class: 'pista' }, `OSRM · calculado ${fmtFecha(proposal.calculatedAt)} · propuesta válida hasta ${fmtFecha(proposal.expiresAt)}.`), action('Confirmar y asignar ruta', async () => {
          if (!proposal) throw new Error('Vuelve a calcular la propuesta');
          if (!reviewed.checked) throw new Error('Confirma la revisión de las restricciones de acceso del vehículo');
          await logisticsMutation('POST', 'routes/confirm', { proposalId: proposal.proposalId, roadRestrictionsReviewed: true }); aviso('Ruta asignada', 'El conductor puede consultar su recorrido.'); tab = 'routes'; await refresh();
        }, true));
        preview.insertBefore(field('He revisado las restricciones de acceso para este vehículo', reviewed), preview.lastChild);
        preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 'Calcular recorrido por carretera')), preview);
  }

  function renderRoutes() {
    const filter = choose([{ value: 'all' }, { value: 'planned' }, { value: 'in_transit' }, { value: 'completed' }, { value: 'cancelled' }], r => r.value === 'all' ? 'Todos los estados' : names[r.value], 'all');
    const search = input('search', { placeholder: 'Buscar por placa, conductor o zona', required: false });
    const result = el('div');
    const paint = () => {
      const rows = data.routes.filter(r => (filter.value === 'all' || r.status === filter.value) && `${r.vehicle.plate} ${r.driver.fullName} ${r.zone.name}`.toLowerCase().includes(search.value.toLowerCase()));
      vaciar(result).append(rows.length ? table(['Ruta', 'Vehículo / conductor', 'Programación', 'Carga / distancia', 'Estado', ''], rows.map(r => [el('div', {}, el('strong', {}, short(r.id)), el('small', { class: 'operations-muted' }, r.zone.name)), el('div', {}, el('strong', {}, vehicleName(r.vehicle)), el('small', { class: 'operations-muted' }, r.driver.fullName)), fmtFecha(r.scheduledDate), el('div', {}, fmtKg(r.peakLoadKg ?? r.deliveries.reduce((n, d) => n + kg(d), 0)), el('small', { class: 'operations-muted' }, r.distanceMeters == null ? 'Ruta anterior sin cálculo vial' : `${(r.distanceMeters / 1000).toFixed(1)} km`)), badge(r.status), action('Abrir operación', () => routeDetail(r))])) : empty('No hay rutas para mostrar', admin ? 'Planifica una ruta o ajusta los filtros.' : 'Aquí verás las rutas que te asigne logística.'));
    };
    filter.addEventListener('change', paint); search.addEventListener('input', paint);
    body.append(panel(admin ? 'Rutas y seguimiento' : 'Rutas asignadas', el('div', { class: 'operations-toolbar' }, search, filter, manager ? boton('Planificar ruta', () => go('planning'), 'btn btn-primario') : null), result)); paint();
  }

  function routeDetail(route) {
    const next = route.stops.find(s => !s.actualAt);
    const mapPlan = route.roadPlan;
    dialog(`Ruta ${short(route.id)}`, (root, close) => {
      root.append(el('div', { class: 'operations-route-summary' }, badge(route.status), el('strong', {}, `${route.vehicle.plate} · ${route.driver.fullName}`), el('p', {}, `${fmtFecha(route.scheduledDate)} — ${fmtFecha(route.scheduledEnd)}`)), routeMap({ geometry: mapPlan?.geometry, stops: route.stops, origin: mapPlan?.origin, position: route.lastPositionAt ? { latitude: route.lastLatitude, longitude: route.lastLongitude, stale: Date.now() - new Date(route.lastPositionAt).getTime() > 120000 } : null }));
      const reload = async () => { close(); await refresh(); const updated = data.routes.find(r => r.id === route.id); if (updated) routeDetail(updated); };
      if (manager && route.driver.simulated && ['planned', 'in_transit'].includes(route.status)) {
        const speed = choose([1, 10, 30, 60, 120].map(value => ({ value })), r => r.value + '×', route.simulation?.speed ?? 30);
        const run = async command => { await logisticsMutation('POST', 'routes/' + route.id + '/simulation', { action: command, speed: Number(speed.value) }); await reload(); };
        root.append(panel('Transporte simulado', el('p', { class: 'tracking-simulation-label' }, 'SIMULACIÓN · no es un repartidor real'), field('Velocidad de simulación', speed), el('p', { class: 'pista' }, 'El servidor mantiene el avance aunque cierres esta página. Al llegar se abre un plazo de 45 segundos para confirmar cantidades; después se registra una recepción automática simulada.'), action(route.status === 'planned' ? 'Iniciar despacho simulado' : route.simulation.status === 'paused' ? 'Reanudar recorrido' : 'Pausar recorrido', () => run(route.status === 'planned' ? 'start' : route.simulation.status === 'paused' ? 'resume' : 'pause'), true), route.simulation && route.status === 'in_transit' ? action('Aplicar velocidad', () => run('speed')) : null));
      }
      if (manager && route.status === 'planned' && (route.driver.simulated || producer)) root.append(action('Cancelar para replanificar', async () => { if (!confirm('¿Liberar estas entregas para calcular una nueva ruta?')) return; await logisticsMutation('PATCH', `routes/${route.id}/cancel`); close(); await refresh(); }));
      route.deliveries.forEach((d, index) => root.append(el('details', { class: 'operations-panel', open: index === 0 }, el('summary', {}, 'Seguimiento de entrega ' + short(d.orderId)), liveTracking(d.id))));
      if (route.status === 'planned' && !route.driver.simulated) root.append(el('div', { class: 'operations-next-stop' }, el('strong', {}, 'Lista para iniciar'), el('p', {}, 'Al despachar se reserva la autorización del pago y comienza el seguimiento.'), action('Iniciar despacho', async () => { await logisticsMutation('PATCH', `routes/${route.id}/dispatch`); await reload(); }, true), admin ? action('Cancelar planificación', async () => { if (!confirm('¿Cancelar la ruta y liberar sus entregas para replanificar?')) return; await logisticsMutation('PATCH', `routes/${route.id}/cancel`); await reload(); }) : null));
      if (route.status === 'in_transit' && next && !route.simulation) root.append(el('div', { class: 'operations-next-stop' }, el('small', {}, `PRÓXIMA PARADA · ${next.sequence}`), el('h3', {}, next.type === 'pickup' ? 'Recoger carga en finca' : 'Llegar al comprador'), el('p', {}, next.address), el('p', {}, `Hora prevista: ${fmtFecha(next.plannedAt)}`), next.latitude != null ? el('a', { class: 'btn btn-sutil', target: '_blank', rel: 'noopener noreferrer', href: `https://www.google.com/maps/dir/?api=1&destination=${next.latitude},${next.longitude}&travelmode=driving` }, 'Abrir navegación') : null, action(next.type === 'pickup' ? 'Registrar recogida' : 'Registrar llegada', async () => { await logisticsMutation('PATCH', `routes/${route.id}/stops/${next.id}/arrive`); await reload(); }, true)));
      if (route.status === 'in_transit' && !next) root.append(el('p', { class: 'operations-next-stop' }, 'Paradas registradas. La ruta finalizará cuando los compradores confirmen la recepción o se resuelvan las entregas fallidas.'));
      root.append(table(['Parada', 'Dirección', 'Prevista', 'Registro'], route.stops.map(s => [`${s.sequence}. ${s.type === 'pickup' ? 'Recogida' : 'Entrega'}`, s.address, fmtFecha(s.plannedAt), s.actualAt ? fmtFecha(s.actualAt) : 'Pendiente'])));
      if (route.status === 'in_transit' && !route.simulation && route.driver.userId === sesion.userId) addGps(root, route);
      if (!producer && ['in_transit', 'planned'].includes(route.status)) {
        const kind = choose(Object.entries(incidentNames).map(([value, name]) => ({ value, name })), r => r.name), message = el('textarea', { class: 'input', required: true, minLength: 5, maxLength: 1000, placeholder: 'Describe qué ocurrió y la acción necesaria' });
        const delivery = choose([{ value: 'route', label: 'Toda la ruta' }, ...route.deliveries.map(d => ({ id: d.id, label: `${short(d.orderId)} · ${d.deliveryAddress}` }))], r => r.label, 'route');
        root.append(panel('Reportar incidencia', form([field('Tipo', kind), field('Alcance', delivery), field('Descripción', message)], async () => { await logisticsMutation('POST', `routes/${route.id}/incidents`, { kind: kind.value, message: message.value, ...(delivery.value !== 'route' ? { deliveryId: delivery.value } : {}) }); await reload(); }, 'Registrar incidencia')));
      }
      if (route.activities?.length) root.append(panel('Historial de incidencias', ...route.activities.map(a => el('div', { class: 'operations-activity' }, el('strong', {}, incidentNames[a.kind] ?? ({ access_reviewed: 'Revisión de acceso confirmada', cancelled: 'Planificación cancelada' }[a.kind] ?? a.kind)), el('small', {}, fmtFecha(a.createdAt)), el('p', {}, a.message), a.resolvedAt ? el('small', {}, `Resuelta: ${fmtFecha(a.resolvedAt)}`) : admin && incidentNames[a.kind] ? action('Marcar resuelta', async () => { await logisticsMutation('PATCH', `routes/${route.id}/incidents/${a.id}/resolve`); await reload(); }) : null))));
      for (const d of route.deliveries.filter(d => !producer && d.status === 'in_transit' && !route.simulation)) {
        const temp = input('number', { step: '0.01' }), reason = el('textarea', { class: 'input', minLength: 5, maxLength: 500, required: true });
        const section = el('details', { class: 'operations-delivery-detail' }, el('summary', {}, `${short(d.orderId)} · ${d.deliveryAddress}`));
        section.append(form([field('Temperatura de la carga °C', temp)], async () => { await logisticsMutation('POST', `deliveries/${d.id}/temperature`, { temperature: Number(temp.value), recordedAt: new Date().toISOString(), sensorEventId: crypto.randomUUID() }); aviso('Lectura registrada'); }, 'Registrar temperatura'), el('p', { class: 'pista' }, 'El comprador confirma la cantidad recibida. Si no fue posible entregar, registra el motivo para resolver la entrega con cero kilos aceptados.'), form([field('Motivo de entrega fallida', reason)], async () => { if (!confirm('¿Cerrar esta entrega sin producto aceptado?')) return; await logisticsMutation('PATCH', `deliveries/${d.id}/close`, { status: 'failed', reason: reason.value, acceptedLots: d.lots.map(l => ({ reservationId: l.reservationId, acceptedQuantityKg: 0 })) }); await reload(); }, 'Registrar entrega fallida')); root.append(section);
      }
    });
  }

  function addGps(root, route) {
    let watch = null, lastSent = 0;
    const status = el('p', { class: 'pista' }, 'Comparte tu ubicación solo durante esta ruta y mientras esta ventana esté abierta. Se conserva únicamente la última posición. Puedes detenerla en cualquier momento.');
    const button = boton('Compartir mi ubicación', () => {
      if (watch != null) { navigator.geolocation.clearWatch(watch); watch = null; button.textContent = 'Compartir mi ubicación'; status.textContent = 'Ubicación detenida. El seguimiento mostrará la antigüedad de la última señal.'; return; }
      if (!navigator.geolocation) { status.textContent = 'Tu navegador no admite geolocalización.'; return; }
      watch = navigator.geolocation.watchPosition(async p => {
        if (Date.now() - lastSent < 20000) return; lastSent = Date.now();
        try { await api.logistica('POST', `routes/${route.id}/position`, { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Math.min(5000, p.coords.accuracy), recordedAt: new Date(p.timestamp).toISOString() }); status.textContent = `Última ubicación enviada: ${new Date().toLocaleTimeString()} · precisión ${Math.round(p.coords.accuracy)} m`; }
        catch (e) { status.textContent = `No se envió la posición: ${e.message}`; }
      }, () => { status.textContent = 'No hay señal o permiso de ubicación. Revisa los permisos del navegador.'; }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
      button.textContent = 'Detener ubicación';
    }, 'btn btn-sutil');
    root.append(panel('Ubicación del conductor', status, button));
    const observer = new MutationObserver(() => { if (!root.isConnected) { if (watch != null) navigator.geolocation.clearWatch(watch); observer.disconnect(); } }); observer.observe(document.body, { childList: true, subtree: true });
  }
  await load(); render();
}
