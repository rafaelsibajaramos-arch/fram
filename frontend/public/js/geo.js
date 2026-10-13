import { aviso, boton, el } from './ui.js';

const DEFAULT = [4.5709, -74.2973];
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
let leafletPromise;

/** Carga Leaflet solo al abrir el formulario de finca, no con toda la app. */
function cargarLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-ftt-leaflet]')) {
      document.head.append(el('link', { rel: 'stylesheet', href: LEAFLET_CSS, 'data-ftt-leaflet': 'true' }));
    }
    // En condiciones normales el script ya viene en index.html. Si un CDN lo
    // retrasó, esperamos ese mismo recurso en vez de insertar otra copia.
    let script = document.querySelector('script[data-ftt-leaflet]');
    const creadoAhora = !script;
    if (!script) script = el('script', { src: LEAFLET_JS, async: true, 'data-ftt-leaflet': 'true' });
    const timeout = setTimeout(() => reject(new Error('El mapa tardó demasiado en cargar')), 12_000);
    const listo = () => { clearTimeout(timeout); window.L ? resolve(window.L) : reject(new Error('Leaflet no se inicializó')); };
    script.addEventListener('load', listo, { once: true });
    script.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('No se pudo descargar el mapa')); }, { once: true });
    if (creadoAhora) document.head.append(script);
    // Navegadores que ya terminaron el script antes de registrar el listener.
    setTimeout(() => { if (window.L) listo(); }, 0);
  });
  return leafletPromise;
}

export function selectorUbicacion({ address, latitude, longitude, name, existingFarms = [] }) {
  const estado = el('p', { class: 'pista geo-estado' }, 'Elige un punto en el mapa, busca una dirección o usa tu ubicación actual.');
  const mapaNodo = el('div', { class: 'mapa-finca mapa-cargando', role: 'application', 'aria-label': 'Mapa para ubicar la finca' }, el('div', { class: 'mapa-carga' }, 'Cargando mapa…'));
  const actual = boton('Usar mi ubicación', () => ubicar(), 'btn btn-sutil btn-chico');
  const buscar = boton('Buscar dirección', () => geocodificar(), 'btn btn-sutil btn-chico');
  const proximidad = el('div', { class: 'geo-proximidad', hidden: true });
  const raiz = el('div', { class: 'selector-ubicacion' },
    el('div', { class: 'geo-encabezado' }, el('strong', {}, 'Ubicación de la finca'), el('span', { class: 'geo-ayuda' }, 'El marcador define el punto de recogida')),
    el('div', { class: 'acciones' }, actual, buscar), mapaNodo, estado, proximidad,
  );

  let map; let marker; let L; let reverseController; let fincasExistentes = normalizarFincas(existingFarms); let grupoFincas; let capaBase; let temporizadorBase;
  raiz.actualizarFincas = (fincas) => {
    fincasExistentes = normalizarFincas(fincas);
    pintarFincas();
    // Sin un punto nuevo en edición, encuadramos las fincas para que todos
    // los marcadores registrados sean visibles de inmediato.
    if (!marker && map) enfocarFincasExistentes();
  };
  raiz.limpiarPunto = () => {
    marker?.remove(); marker = undefined;
    proximidad.hidden = true; proximidad.replaceChildren();
    if (map) enfocarFincasExistentes();
  };
  const actualizarNombre = () => { if (marker) marker.setTooltipContent(etiquetaPunto()); };
  name?.addEventListener('input', actualizarNombre);
  address.addEventListener('input', actualizarNombre);
  latitude.addEventListener('change', sincronizarDesdeCampos);
  longitude.addEventListener('change', sincronizarDesdeCampos);
  void iniciarMapa();

  async function iniciarMapa() {
    try {
      L = await cargarLeaflet();
      const lat = numeroValido(latitude.value, -90, 90);
      const lng = numeroValido(longitude.value, -180, 180);
      const inicial = lat !== null && lng !== null ? [lat, lng] : DEFAULT;
      map = L.map(mapaNodo, { scrollWheelZoom: false, zoomControl: true, preferCanvas: true, zoomSnap: 0.5, fadeAnimation: false, markerZoomAnimation: false }).setView(inicial, lat !== null ? 15 : 5.5);
      // Una sola imagen de mapa por vista en lugar de 6–12 teselas. Evita
      // huecos y hace la carga notablemente más rápida en conexiones móviles.
      actualizarCapaBase();
      grupoFincas = L.layerGroup().addTo(map);
      map.on('click', (event) => fijar(event.latlng.lat, event.latlng.lng, true));
      map.on('moveend', programarCapaBase);
      mapaNodo.classList.remove('mapa-cargando');
      mapaNodo.querySelector('.mapa-carga')?.remove();
      // El panel se renderiza junto con otras tarjetas; invalidar más de una
      // vez evita huecos de teselas si su tamaño final llega unos ms después.
      [0, 150, 600].forEach((delay) => setTimeout(() => { map?.invalidateSize({ pan: false, debounceMoveend: true }); programarCapaBase(); }, delay));
      if (lat !== null && lng !== null) fijar(lat, lng, false, false);
      else {
        pintarFincas();
        enfocarFincasExistentes();
      }
    } catch {
      mapaNodo.classList.remove('mapa-cargando'); mapaNodo.classList.add('mapa-error');
      mapaNodo.textContent = 'No fue posible cargar el mapa. Puedes registrar la ubicación escribiendo latitud y longitud.';
      estado.textContent = 'Mapa no disponible; las coordenadas manuales siguen siendo válidas.';
    }
  }

  function programarCapaBase() {
    clearTimeout(temporizadorBase);
    temporizadorBase = setTimeout(actualizarCapaBase, 100);
  }

  function actualizarCapaBase() {
    if (!map || !L) return;
    const limites = map.getBounds();
    const suroeste = L.CRS.EPSG3857.project(limites.getSouthWest());
    const noreste = L.CRS.EPSG3857.project(limites.getNorthEast());
    const tamano = map.getSize();
    const ancho = Math.max(320, Math.min(1600, Math.round(tamano.x)));
    const alto = Math.max(220, Math.min(1200, Math.round(tamano.y)));
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/export?bbox=${suroeste.x},${suroeste.y},${noreste.x},${noreste.y}&bboxSR=3857&imageSR=3857&size=${ancho},${alto}&format=png32&transparent=false&f=image`;
    if (!capaBase) {
      capaBase = L.imageOverlay(url, limites, {
        interactive: false,
        attribution: 'Mapa &copy; Esri — fuentes: Esri, TomTom, Garmin, FAO, NOAA, USGS y OpenStreetMap',
      }).addTo(map);
      capaBase.on('error', () => { estado.textContent = 'El mapa tardó en responder. Puedes seguir seleccionando el punto o intentar moverlo.'; });
      return;
    }
    capaBase.setBounds(limites);
    capaBase.setUrl(url);
  }

  function etiquetaPunto() { return name?.value.trim() || address.value.trim() || 'Punto de recogida'; }
  function fijar(lat, lng, consultarDireccion, moverMapa = true) {
    latitude.value = Number(lat).toFixed(6); longitude.value = Number(lng).toFixed(6);
    if (map) {
      const point = [lat, lng];
      if (!marker) marker = L.marker(point, { icon: marcadorPremium() }).addTo(map).bindTooltip(etiquetaPunto(), { permanent: true, direction: 'top', offset: [0, -26], className: 'geo-etiqueta' });
      else { marker.setLatLng(point); marker.setTooltipContent(etiquetaPunto()); }
      if (moverMapa) map.flyTo(point, Math.max(map.getZoom(), 15), { duration: 0.45 });
    }
    pintarFincas();
    estado.textContent = `Punto guardado: ${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}.`;
    if (consultarDireccion) void reversa(lat, lng);
  }
  function marcadorPremium() { return L.divIcon({ className: 'geo-pin-contenedor', iconSize: [34, 42], iconAnchor: [17, 40], tooltipAnchor: [0, -38], html: '<span class="geo-pin"><span></span></span>' }); }
  function marcadorExistente() { return L.divIcon({ className: 'geo-punto-existente-contenedor', iconSize: [18, 18], iconAnchor: [9, 9], html: '<span class="geo-punto-existente"></span>' }); }
  function pintarFincas() {
    if (!grupoFincas) return;
    grupoFincas.clearLayers();
    const puntoNuevo = marker?.getLatLng();
    for (const finca of fincasExistentes) {
      const distancia = puntoNuevo ? distanciaKm(puntoNuevo.lat, puntoNuevo.lng, finca.latitude, finca.longitude) : null;
      const etiqueta = `${finca.name}${distancia === null ? '' : ` · ${formatoDistancia(distancia)}`}`;
      L.marker([finca.latitude, finca.longitude], { icon: marcadorExistente(), keyboard: false })
        .bindTooltip(etiqueta, { direction: 'top', offset: [0, -8], className: 'geo-etiqueta geo-etiqueta-secundaria' })
        .bindPopup(`<strong>${textoSeguro(finca.name)}</strong><br>${textoSeguro(finca.address || 'Dirección no registrada')}${distancia === null ? '' : `<br><small>A ${textoSeguro(formatoDistancia(distancia))} del nuevo punto</small>`}`)
        .addTo(grupoFincas);
    }
    pintarProximidad(puntoNuevo);
  }
  function pintarProximidad(puntoNuevo) {
    if (!puntoNuevo || !fincasExistentes.length) { proximidad.hidden = true; proximidad.replaceChildren(); return; }
    const ordenadas = fincasExistentes.map((finca) => ({ finca, distancia: distanciaKm(puntoNuevo.lat, puntoNuevo.lng, finca.latitude, finca.longitude) })).sort((a, b) => a.distancia - b.distancia);
    proximidad.hidden = false;
    proximidad.replaceChildren(
      el('strong', {}, 'Distancia a fincas registradas'),
      el('div', { class: 'geo-lista-distancias' }, ordenadas.map(({ finca, distancia }) => el('span', { class: `geo-distancia ${nivelDistancia(distancia)}` }, `${finca.name} · ${formatoDistancia(distancia)}`))),
    );
  }
  function enfocarFincasExistentes() {
    if (!fincasExistentes.length) { map.setView(DEFAULT, 5.5); return; }
    if (fincasExistentes.length === 1) { map.setView([fincasExistentes[0].latitude, fincasExistentes[0].longitude], 14); return; }
    map.fitBounds(fincasExistentes.map((finca) => [finca.latitude, finca.longitude]), { padding: [34, 34], maxZoom: 13 });
  }
  function sincronizarDesdeCampos() { const lat = numeroValido(latitude.value, -90, 90); const lng = numeroValido(longitude.value, -180, 180); if (lat !== null && lng !== null) fijar(lat, lng, false); }
  async function reversa(lat, lng) {
    reverseController?.abort(); reverseController = new AbortController();
    estado.textContent = 'Punto guardado. Buscando el nombre de la ubicación…';
    try {
      const result = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`, { headers: { 'accept-language': 'es' }, signal: reverseController.signal });
      if (!result.ok) throw new Error('No se pudo consultar la dirección');
      const data = await result.json();
      if (data.display_name) { address.value = data.display_name; actualizarNombre(); estado.textContent = `Punto y dirección guardados: ${data.display_name}.`; }
    } catch (error) { if (error.name !== 'AbortError') estado.textContent = 'Punto guardado. Puedes escribir o ajustar la dirección manualmente.'; }
  }
  function ubicar() {
    if (!navigator.geolocation) { aviso('Ubicación no disponible', 'Tu navegador no admite geolocalización.', 'info'); return; }
    actual.disabled = true; actual.textContent = 'Ubicando…';
    navigator.geolocation.getCurrentPosition(
      pos => { fijar(pos.coords.latitude, pos.coords.longitude, true); actual.disabled = false; actual.textContent = 'Usar mi ubicación'; },
      () => { estado.textContent = 'No se pudo acceder a tu ubicación. Autoriza el acceso o elige un punto en el mapa.'; actual.disabled = false; actual.textContent = 'Usar mi ubicación'; },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 120_000 },
    );
  }
  async function geocodificar() {
    if (!address.value.trim()) { estado.textContent = 'Escribe una dirección antes de buscarla.'; address.focus(); return; }
    buscar.disabled = true; buscar.textContent = 'Buscando…';
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=co&q=${encodeURIComponent(address.value)}`, { headers: { 'accept-language': 'es' }, signal: AbortSignal.timeout(10_000) });
      const [found] = await res.json(); if (!found) throw new Error('Dirección no encontrada');
      address.value = found.display_name; fijar(Number(found.lat), Number(found.lon), false);
    } catch { estado.textContent = 'No encontramos esa dirección. Elige el punto manualmente en el mapa.'; }
    finally { buscar.disabled = false; buscar.textContent = 'Buscar dirección'; }
  }
  return raiz;
}

function numeroValido(value, min, max) {
  // Number('') es 0: una coordenada vacía no puede convertirse en el punto
  // 0,0. Solo aceptamos números escritos explícitamente por la persona.
  if (String(value ?? '').trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizarFincas(fincas) {
  return (fincas ?? []).map((finca) => ({
    name: String(finca.farm_name ?? finca.name ?? 'Finca registrada'),
    address: String(finca.address ?? ''),
    latitude: Number(finca.latitude),
    longitude: Number(finca.longitude),
  })).filter((finca) => Number.isFinite(finca.latitude) && Number.isFinite(finca.longitude));
}

function distanciaKm(lat1, lng1, lat2, lng2) {
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1); const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatoDistancia(km) { return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString('es-CO', { maximumFractionDigits: 1 })} km`; }
function nivelDistancia(km) { return km < 5 ? 'cerca' : km < 30 ? 'media' : 'lejos'; }
function textoSeguro(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
