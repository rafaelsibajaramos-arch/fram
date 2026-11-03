import { cargarLeaflet } from './geo.js';
import { el, boton } from './ui.js';

const point = p => p && p.latitude != null && p.longitude != null && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude));
export function routeMap({ geometry, stops = [], position = null, origin = null } = {}) {
  let liveMap, liveMarker, leaflet, pendingPosition = position;
  const setPosition = p => { pendingPosition = p; if (!liveMap || !leaflet || !wrap.isConnected) return; if (!point(p)) { liveMarker?.remove(); liveMarker = null; return; } if (liveMarker) liveMarker.setLatLng([p.latitude, p.longitude]); else liveMarker = leaflet.circleMarker([p.latitude, p.longitude], { color: '#2874ca', fillOpacity: 1, radius: 10 }).addTo(liveMap); liveMarker.setStyle({ color: p.stale ? '#a76b20' : '#2874ca' }); };
  const node = el('div', { class: 'operations-map', 'aria-label': 'Mapa de la ruta y sus paradas' });
  const status = el('p', { class: 'pista map-status' }, 'Cargando mapa…');
  const wrap = el('div', { class: 'operations-map-wrap' }, node, status);
  requestAnimationFrame(async () => {
    try {
      const L = await cargarLeaflet();
      if (!wrap.isConnected) return;
      const map = L.map(node).setView([8.75, -75.88], 11); liveMap = map; leaflet = L; setPosition(pendingPosition);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
      const bounds = [];
      if (geometry?.type === 'LineString') {
        const line = L.geoJSON(geometry, { style: { color: '#17785c', weight: 5, opacity: 0.85 } }).addTo(map);
        if (line.getBounds().isValid()) bounds.push(...geometry.coordinates.map(([lng, lat]) => [lat, lng]));
      }
      if (point(origin)) L.circleMarker([origin.latitude, origin.longitude], { radius: 8, color: '#172e31', fillOpacity: 1 }).addTo(map).bindTooltip('Salida');
      stops.filter(point).forEach((s, i) => {
        const label = el('div', {}, el('strong', {}, `${s.sequence ?? i + 1}. ${s.type === 'pickup' ? 'Recogida' : 'Entrega'}`), el('p', {}, s.address ?? 'Destino'));
        L.marker([s.latitude, s.longitude], { icon: L.divIcon({ className: 'route-marker', html: `<span>${s.sequence ?? i + 1}</span>`, iconSize: [30, 30] }) }).addTo(map).bindPopup(label);
        bounds.push([s.latitude, s.longitude]);
      });
      if (bounds.length) map.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
      status.textContent = geometry ? 'Recorrido por carretera · estimación sin tráfico en vivo' : 'Ubicaciones verificadas · recorrido vial no disponible';
      const resize = new ResizeObserver(() => { if (wrap.isConnected && liveMap === map) map.invalidateSize(); }); resize.observe(node);
      const observer = new MutationObserver(() => { if (!wrap.isConnected) { resize.disconnect(); observer.disconnect(); liveMap = null; leaflet = null; liveMarker = null; map.remove(); } });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch { status.textContent = 'No se pudo cargar el mapa. El detalle de las paradas sigue disponible.'; }
  });
  wrap.setPosition = setPosition;
  return wrap;
}

export { locationPicker } from './address-picker.js';
