import { cargarLeaflet } from './geo.js';
import { el, boton } from './ui.js';

const point = p => p && p.latitude != null && p.longitude != null && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude));
export function routeMap({ geometry, stops = [], position = null, origin = null } = {}) {
  const node = el('div', { class: 'operations-map', 'aria-label': 'Mapa de la ruta y sus paradas' });
  const status = el('p', { class: 'pista map-status' }, 'Cargando mapa…');
  const wrap = el('div', { class: 'operations-map-wrap' }, node, status);
  requestAnimationFrame(async () => {
    try {
      const L = await cargarLeaflet();
      if (!wrap.isConnected) return;
      const map = L.map(node).setView([8.75, -75.88], 11);
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
      if (point(position)) {
        L.circleMarker([position.latitude, position.longitude], { color: position.stale ? '#a76b20' : '#2874ca', fillOpacity: 1, radius: 10 }).addTo(map).bindTooltip(position.stale ? 'Última posición conocida (señal antigua)' : 'Ubicación compartida por el conductor');
        bounds.push([position.latitude, position.longitude]);
      }
      if (bounds.length) map.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
      status.textContent = geometry ? 'Recorrido por carretera · estimación sin tráfico en vivo' : 'Ubicaciones verificadas · recorrido vial no disponible';
      const resize = new ResizeObserver(() => map.invalidateSize()); resize.observe(node);
      const observer = new MutationObserver(() => { if (!wrap.isConnected) { resize.disconnect(); observer.disconnect(); map.remove(); } });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch { status.textContent = 'No se pudo cargar el mapa. El detalle de las paradas sigue disponible.'; }
  });
  return wrap;
}

export function locationPicker({ latitude, longitude, onChange = () => {}, title = 'Confirma el punto en el mapa' }) {
  const lat = el('input', { class: 'input', type: 'number', min: -90, max: 90, step: 'any', placeholder: 'Latitud', value: latitude ?? '', required: true, 'aria-label': 'Latitud' });
  const lng = el('input', { class: 'input', type: 'number', min: -180, max: 180, step: 'any', placeholder: 'Longitud', value: longitude ?? '', required: true, 'aria-label': 'Longitud' });
  const canvas = el('div', { class: 'location-map', 'aria-label': title });
  const status = el('p', { class: 'pista' }, 'Haz clic en el punto exacto o introduce sus coordenadas.');
  let map, marker, L;
  const value = () => lat.value !== '' && lng.value !== '' && lat.validity.valid && lng.validity.valid ? { latitude: Number(lat.value), longitude: Number(lng.value) } : null;
  const sync = () => {
    const p = value();
    if (map && p) {
      if (marker) marker.setLatLng([p.latitude, p.longitude]);
      else marker = L.marker([p.latitude, p.longitude]).addTo(map);
    }
    status.textContent = p ? 'Punto seleccionado. Verifica que coincida con la dirección.' : 'Debes seleccionar un punto para continuar.';
    onChange(p);
  };
  lat.addEventListener('input', sync); lng.addEventListener('input', sync);
  const locate = boton('Usar mi ubicación', () => {
    if (!navigator.geolocation) { status.textContent = 'Tu navegador no permite geolocalización. Selecciona el punto manualmente.'; return; }
    navigator.geolocation.getCurrentPosition(p => { lat.value = p.coords.latitude.toFixed(6); lng.value = p.coords.longitude.toFixed(6); sync(); map?.setView([lat.value, lng.value], 16); }, () => { status.textContent = 'No se obtuvo la ubicación. Selecciona el punto manualmente.'; }, { enableHighAccuracy: true, timeout: 15000 });
  }, 'btn btn-sutil btn-chico');
  const root = el('div', { class: 'location-picker' }, el('strong', {}, title), canvas, el('div', { class: 'operations-form-grid' }, lat, lng), locate, status);
  requestAnimationFrame(async () => {
    try {
      L = await cargarLeaflet(); if (!root.isConnected) return;
      const initial = value(); map = L.map(canvas).setView(initial ? [initial.latitude, initial.longitude] : [8.75, -75.88], initial ? 15 : 11);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
      map.on('click', e => { lat.value = e.latlng.lat.toFixed(6); lng.value = e.latlng.lng.toFixed(6); sync(); }); sync();
      const resize = new ResizeObserver(() => map.invalidateSize()); resize.observe(canvas);
      const observer = new MutationObserver(() => { if (!root.isConnected) { resize.disconnect(); observer.disconnect(); map.remove(); } }); observer.observe(document.body, { childList: true, subtree: true });
    } catch { status.textContent = 'Mapa no disponible; puedes introducir las coordenadas verificadas.'; }
  });
  root.value = value;
  root.clear = () => { lat.value = ''; lng.value = ''; marker?.remove(); marker = null; sync(); };
  return root;
}
