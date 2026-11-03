// Manual address searches only. One gateway replica with the public provider;
// configure GEOCODING_URL to a dedicated provider when scaling the application.
export function createGeocoder({ fetcher = fetch, baseUrl = process.env.GEOCODING_URL || 'https://nominatim.openstreetmap.org', intervalMs = 1100 } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid geocoding provider');
  let tail = Promise.resolve(), nextAt = 0, pending = 0;
  const cache = new Map(), inflight = new Map();
  return async function search(input) {
    const query = String(input ?? '').trim().replace(/\s+/g, ' ');
    if (query.length < 4 || query.length > 250) throw Object.assign(new Error('Escribe una dirección de entre 4 y 250 caracteres e incluye la ciudad.'), { status: 400 });
    const key = query.toLocaleLowerCase('es');
    const old = cache.get(key);
    if (old && old.until > Date.now()) return old.results;
    if (inflight.has(key)) return inflight.get(key);
    if (pending >= 8) throw Object.assign(new Error('El buscador está ocupado. Reintenta en unos segundos.'), { status: 429 });
    pending++;
    const task = tail.catch(() => {}).then(async () => {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, nextAt - Date.now())));
      nextAt = Date.now() + intervalMs;
      const url = new URL(base.toString().replace(/\/$/, '') + '/search');
      url.search = new URLSearchParams({ format: 'jsonv2', countrycodes: 'co', limit: '5', addressdetails: '1', q: query }).toString();
      const response = await fetcher(url, { headers: { 'user-agent': 'FarmToTable/1.0 (https://fram-production.up.railway.app)', 'accept-language': 'es' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Object.assign(new Error('El buscador de direcciones no está disponible. Reintenta o confirma el punto en el mapa.'), { status: 503 });
      const data = await response.json();
      if (!Array.isArray(data)) throw Object.assign(new Error('No se pudo interpretar la búsqueda.'), { status: 503 });
      const results = data.filter(p => p.lat != null && p.lon != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lon)) <= 180).slice(0, 5).map(p => ({ label: String(p.display_name ?? 'Ubicación encontrada').slice(0, 500), latitude: Number(p.lat), longitude: Number(p.lon) }));
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, { until: Date.now() + 86400000, results });
      return results;
    });
    tail = task;
    inflight.set(key, task);
    try { return await task; } finally { pending--; inflight.delete(key); }
  };
}
