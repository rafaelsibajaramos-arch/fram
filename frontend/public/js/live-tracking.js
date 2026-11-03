import { api } from './api.js';
import { el, vaciar, fmtFecha } from './ui.js';
import { routeMap } from './logistics-map.js';

export const deliveryStages = { pending: 'Pendiente de asignación', assigned: 'Repartidor asignado', preparing: 'Preparando la recogida', picking_up: 'Pasando a recoger', in_transit: 'En camino', approaching: 'Próximo a llegar', arrived: 'Llegó al destino', completed: 'Entrega completada' };
export function liveTracking(deliveryId, onUpdate = () => {}) {
  const title = el('strong', {}, 'Conectando con el seguimiento…');
  const description = el('p', { class: 'pista' });
  const progress = el('progress', { max: 100, value: 0, 'aria-label': 'Avance del recorrido' });
  const details = el('p', { class: 'tracking-metrics' });
  const note = el('p', { class: 'tracking-simulation-label' });
  const mapSlot = el('div');
  const timeline = el('ol', { class: 'delivery-timeline' });
  const error = el('p', { class: 'operations-error', role: 'status', hidden: true });
  const root = el('section', { class: 'live-delivery-tracking', 'aria-label': 'Seguimiento en vivo' }, note, title, description, progress, details, mapSlot, timeline, error);
  let map, timer, disposed = false, running = false, signature = '';
  const dispose = () => { disposed = true; clearTimeout(timer); observer.disconnect(); };
  const observer = new MutationObserver(() => { if (!root.isConnected) dispose(); });
  async function update() {
    if (disposed || !root.isConnected || running) return;
    clearTimeout(timer);
    const parent = root.closest('details');
    if (document.hidden || parent && !parent.open) { timer = setTimeout(update, 3000); return; }
    running = true;
    try {
      const t = await api.logistica('GET', `deliveries/${deliveryId}/tracking`);
      if (disposed || !root.isConnected) return;
      error.hidden = true;
      title.textContent = deliveryStages[t.stage] ?? t.status;
      note.textContent = t.simulated ? `RECORRIDO SIMULADO · ${t.simulation.status === 'paused' ? 'Pausado' : `${t.simulation.speed}×`}` : 'Seguimiento del transportista';
      description.textContent = t.driver ? `${t.driver.fullName} · ${t.vehicle?.plate ?? ''} · ${t.vehicle?.brand ?? ''} ${t.vehicle?.model ?? ''}` : 'El productor o administración asignará un repartidor habilitado.';
      progress.value = t.simulation?.progressPercent ?? (t.closedAt ? 100 : 0);
      const distance = t.simulation?.remainingMeters;
      details.textContent = [distance != null ? `${(distance / 1000).toFixed(2)} km restantes` : '', t.simulation?.etaSeconds != null ? `Llegada estimada: ${Math.ceil(t.simulation.etaSeconds / 60)} min de simulación acelerada` : '', t.simulation?.status === 'paused' ? 'El recorrido está en pausa' : '', t.simulation?.confirmationDueAt && !t.closedAt ? `Confirmación automática simulada: ${fmtFecha(t.simulation.confirmationDueAt)}` : '', t.receipt?.buyerConfirmedAt ? 'Recepción confirmada por el comprador' : t.receipt?.source === 'simulation' ? 'Finalizada automáticamente por simulación; el comprador puede confirmar su recepción' : '', `Actualizado: ${new Date().toLocaleTimeString('es-CO')}`].filter(Boolean).join(' · ');
      const nextSignature = JSON.stringify([t.geometry, t.stops.map(s => s.id)]);
      if (!map || signature !== nextSignature) { signature = nextSignature; map = routeMap({ geometry: t.geometry, stops: t.stops, position: t.position, origin: t.origin }); vaciar(mapSlot).append(map); }
      else map.setPosition(t.position);
      vaciar(timeline).append(...t.stops.map(s => el('li', { class: s.actualAt ? 'done' : '' }, el('strong', {}, s.type === 'pickup' ? 'Recogida en origen' : 'Llegada al comprador'), el('small', {}, `${s.address} · ${s.actualAt ? fmtFecha(s.actualAt) : 'Pendiente'}`))));
      if (t.simulation?.error) { error.hidden = false; error.textContent = t.simulation.error; }
      onUpdate(t);
    } catch (e) { error.hidden = false; error.textContent = `${e.message ?? 'No se pudo actualizar'} · Reintentando la conexión…`; }
    finally { running = false; if (!disposed) timer = setTimeout(update, 3000); }
  }
  requestAnimationFrame(() => { if (!root.isConnected) return; observer.observe(document.body, { childList: true, subtree: true }); void update(); });
  root.refresh = update;
  root.dispose = dispose;
  return root;
}
