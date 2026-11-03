import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeocoder } from './geocoding.mjs';

test('busca solo en Colombia, identifica la app y comparte consultas concurrentes/cache', async () => {
  let calls = 0;
  const search = createGeocoder({ intervalMs: 0, fetcher: async (url, options) => {
    calls++; assert.equal(url.searchParams.get('countrycodes'), 'co'); assert.match(options.headers['user-agent'], /FarmToTable/);
    return { ok: true, json: async () => [{ display_name: 'Calle 22, Montería', lat: '8.75', lon: '-75.88' }, { lat: 'invalid', lon: '0' }] };
  } });
  const [a,b] = await Promise.all([search('Calle 22, Montería'), search('Calle 22, Montería')]);
  assert.deepEqual(a,b); assert.equal(a.length, 1); assert.equal(a[0].latitude, 8.75);
  await search('calle 22, montería'); assert.equal(calls, 1);
});
test('rechaza entradas inválidas y permite reintentar fallas sin cachearlas', async () => {
  let calls = 0;
  const search = createGeocoder({ intervalMs: 0, fetcher: async () => ({ ok: ++calls > 1, json: async () => [] }) });
  await assert.rejects(search('x'), { status: 400 });
  await assert.rejects(search('Calle 22 Montería'), { status: 503 });
  assert.deepEqual(await search('Calle 22 Montería'), []); assert.equal(calls, 2);
});
test('espacia las consultas distintas para no saturar el proveedor', async () => {
  const starts = [];
  const search = createGeocoder({ intervalMs: 50, fetcher: async () => { starts.push(Date.now()); return { ok: true, json: async () => [] }; } });
  await Promise.all([search('Calle 22 Montería'), search('Carrera 9 Montería')]);
  assert.ok(starts[1] - starts[0] >= 45);
});
