import { aviso, boton, el } from './ui.js';

const DEFAULT = [4.5709, -74.2973];

function esperarLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (window.L) { clearInterval(timer); resolve(window.L); } }, 80);
    setTimeout(() => { clearInterval(timer); reject(new Error('No se pudo cargar el mapa')); }, 6000);
  });
}

export async function selectorUbicacion({ address, latitude, longitude }) {
  const estado = el('p', { class: 'pista geo-estado' }, 'Seleccione un punto en el mapa o use su ubicación actual.');
  const mapaNodo = el('div', { class: 'mapa-finca', role: 'application', 'aria-label': 'Mapa para ubicar la finca' });
  const actual = boton('Usar mi ubicación', () => ubicar(), 'btn btn-sutil btn-chico');
  const buscar = boton('Buscar dirección', () => geocodificar(), 'btn btn-sutil btn-chico');
  const raiz = el('div', { class: 'selector-ubicacion' }, el('div', { class: 'acciones' }, actual, buscar), mapaNodo, estado);

  let map; let marker; let L;
  try {
    L = await esperarLeaflet();
    map = L.map(mapaNodo, { scrollWheelZoom: false }).setView(DEFAULT, 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    map.on('click', (event) => fijar(event.latlng.lat, event.latlng.lng, true));
  } catch (error) { estado.textContent = 'El mapa no está disponible. Puede escribir las coordenadas manualmente.'; }

  function fijar(lat, lng, consultarDireccion) {
    latitude.value = Number(lat).toFixed(6); longitude.value = Number(lng).toFixed(6);
    if (map) { if (!marker) marker = L.marker([lat, lng]).addTo(map); else marker.setLatLng([lat, lng]); map.setView([lat, lng], Math.max(map.getZoom(), 15)); }
    estado.textContent = 'Ubicación seleccionada: ' + Number(lat).toFixed(6) + ', ' + Number(lng).toFixed(6);
    if (consultarDireccion) void reversa(lat, lng);
  }
  async function reversa(lat, lng) {
    try {
      const result = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, { headers: { 'accept-language': 'es' } });
      const data = await result.json(); if (data.display_name) address.value = data.display_name;
    } catch { /* Las coordenadas siguen siendo válidas aunque falle la dirección. */ }
  }
  function ubicar() {
    if (!navigator.geolocation) { aviso('Ubicación no disponible', 'Su navegador no admite geolocalización.', 'info'); return; }
    actual.disabled = true; actual.textContent = 'Ubicando…';
    navigator.geolocation.getCurrentPosition(
      pos => { fijar(pos.coords.latitude, pos.coords.longitude, true); actual.disabled = false; actual.textContent = 'Usar mi ubicación'; },
      () => { estado.textContent = 'No pudimos acceder a su ubicación. Permita el acceso o elija un punto en el mapa.'; actual.disabled = false; actual.textContent = 'Usar mi ubicación'; },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }
  async function geocodificar() {
    if (!address.value.trim()) { estado.textContent = 'Escriba una dirección antes de buscarla.'; address.focus(); return; }
    buscar.disabled = true; buscar.textContent = 'Buscando…';
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=co&q=' + encodeURIComponent(address.value));
      const [found] = await res.json();
      if (!found) throw new Error('Dirección no encontrada');
      fijar(Number(found.lat), Number(found.lon), false); address.value = found.display_name;
    } catch { estado.textContent = 'No encontramos esa dirección. Seleccione el punto manualmente en el mapa.'; }
    finally { buscar.disabled = false; buscar.textContent = 'Buscar dirección'; }
  }
  return raiz;
}
