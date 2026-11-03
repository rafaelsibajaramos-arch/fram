import { cargarLeaflet } from './geo.js';
import { api } from './api.js';
import { el, boton, vaciar } from './ui.js';

export function locationPicker({ latitude, longitude, address = '', addressInput, cityInput, regionInput, addressState = {}, onAddressChange = () => {}, onChange = () => {}, title = 'Dirección de entrega' } = {}) {
  const street = addressInput ?? el('input', { class: 'input', value: address, placeholder: 'Calle 22 # 9-15 o manzana T, lote 9', 'aria-label': 'Dirección, calle, carrera o manzana', maxLength: 180 });
  const city = cityInput ?? el('input', { class: 'input', value: addressState.city ?? '', placeholder: 'Ej.: Montería, Córdoba', 'aria-label': 'Ciudad o municipio', maxLength: 80 });
  const neighborhood = el('input', { class: 'input', value: addressState.neighborhood ?? '', placeholder: 'Ej.: Las Acacias', 'aria-label': 'Barrio o vereda', maxLength: 80 });
  const extra = el('input', { class: 'input', value: addressState.extra ?? '', placeholder: 'Casa, apartamento, lote o referencia de llegada', 'aria-label': 'Complemento y referencias', maxLength: 150 });
  const label = (text, control) => el('label', { class: 'operations-field' }, el('span', {}, text), control);
  const canvas = el('div', { class: 'location-map', 'aria-label': 'Mapa de la dirección seleccionada' });
  const status = el('p', { class: 'pista', role: 'status' }, 'Escribe la dirección y ciudad; busca y elige una coincidencia. Puedes ajustar el marcador en el mapa.');
  const results = el('div', { class: 'address-results', 'aria-label': 'Coincidencias de dirección' });
  let selected = latitude != null && longitude != null && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)) ? { latitude: Number(latitude), longitude: Number(longitude) } : null;
  let map, marker, L, revision = 0, disposed = false;
  const notify = () => onChange(selected);
  const mark = () => {
    if (!map || !selected) return;
    if (marker) marker.setLatLng([selected.latitude, selected.longitude]);
    else marker = L.marker([selected.latitude, selected.longitude], { draggable: true }).addTo(map).on('dragend', () => { const p = marker.getLatLng(); choose({ latitude: p.lat, longitude: p.lng }); });
  };
  const choose = (p, text = 'Punto confirmado. Verifica la dirección y las referencias de llegada.') => { selected = p; mark(); status.textContent = text; notify(); };
  const invalidate = () => { revision++; selected = null; marker?.remove(); marker = null; vaciar(results); status.textContent = 'La dirección cambió. Busca de nuevo o confirma el punto en el mapa.'; notify(); };
  [street, city, neighborhood, regionInput].filter(Boolean).forEach(input => input.addEventListener('input', invalidate));
  [street, city, neighborhood, extra, regionInput].filter(Boolean).forEach(input => input.addEventListener('input', () => onAddressChange({ city: city.value, neighborhood: neighborhood.value, extra: extra.value })));
  const search = boton('Buscar dirección', async () => {
    if (street.value.trim().length < 3 || !city.value.trim()) { status.textContent = 'Escribe la dirección o barrio y la ciudad o municipio.'; (street.value.trim().length < 3 ? street : city).focus(); return; }
    const current = ++revision;
    search.disabled = true; status.textContent = 'Buscando la dirección…'; vaciar(results);
    try {
      const data = await api.logistica('GET', 'locations/search?q=' + encodeURIComponent([street.value, neighborhood.value, city.value, regionInput?.value, 'Colombia'].filter(Boolean).join(', ')));
      if (disposed || current !== revision) return;
      status.textContent = data.results.length ? 'Selecciona la coincidencia correcta. No se confirma ninguna automáticamente.' : 'No encontramos esa dirección exacta. Busca por barrio y ciudad, y ajusta el marcador hasta el lugar de llegada.';
      for (const p of data.results) results.append(boton(p.label, () => { choose({ latitude: p.latitude, longitude: p.longitude }, 'Ubicación seleccionada: ' + p.label); map?.setView([p.latitude, p.longitude], 17); vaciar(results); }, 'btn btn-sutil address-result'));
    } catch (e) { if (current === revision && !disposed) status.textContent = e.message ?? 'No se pudo buscar. Puedes confirmar el punto en el mapa.'; }
    finally { search.disabled = false; }
  }, 'btn btn-sutil');
  const locate = boton('Usar mi ubicación', () => {
    if (!navigator.geolocation) { status.textContent = 'Busca una dirección o selecciona un punto en el mapa.'; return; }
    navigator.geolocation.getCurrentPosition(p => { if (disposed) return; revision++; choose({ latitude: p.coords.latitude, longitude: p.coords.longitude }); map?.setView([p.coords.latitude, p.coords.longitude], 17); }, () => { status.textContent = 'No se obtuvo tu ubicación. Puedes buscar por dirección.'; }, { enableHighAccuracy: true, timeout: 10000 });
  }, 'btn btn-sutil btn-chico');
  const attribution = el('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener noreferrer', class: 'pista' }, 'Búsqueda y mapa © OpenStreetMap');
  const root = el('div', { class: 'location-picker address-picker' }, el('strong', {}, title), el('div', { class: 'operations-form-grid' }, addressInput ? null : label('Dirección: calle, carrera, manzana o lote', street), cityInput ? null : label('Ciudad o municipio', city), label('Barrio o vereda (opcional)', neighborhood), label('Complemento y referencias (opcional)', extra)), el('div', { class: 'acciones' }, search, locate), status, results, canvas, attribution);
  requestAnimationFrame(async () => {
    try {
      L = await cargarLeaflet(); if (!root.isConnected) return;
      map = L.map(canvas).setView(selected ? [selected.latitude, selected.longitude] : [8.75, -75.88], selected ? 16 : 11);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors', maxZoom: 19 }).addTo(map); mark();
      map.on('click', e => { revision++; choose({ latitude: e.latlng.lat, longitude: e.latlng.lng }); });
      const resize = new ResizeObserver(() => map.invalidateSize()); resize.observe(canvas);
      const observer = new MutationObserver(() => { if (!root.isConnected) { disposed = true; revision++; resize.disconnect(); observer.disconnect(); map.remove(); } }); observer.observe(document.body, { childList: true, subtree: true });
    } catch { status.textContent = 'El mapa no cargó. Puedes buscar y seleccionar una dirección de la lista.'; }
  });
  root.value = () => selected;
  root.addressValue = () => [street.value, neighborhood.value && 'Barrio/vereda ' + neighborhood.value, city.value, regionInput?.value, extra.value].filter(Boolean).join(', ').slice(0, 500);
  root.clear = invalidate;
  return root;
}
