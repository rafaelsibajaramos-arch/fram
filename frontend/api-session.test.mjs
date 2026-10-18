import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();
globalThis.sessionStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
const expiredEvents = [];
globalThis.dispatchEvent = (event) => { expiredEvents.push(event.type); return true; };
const { api, sesion } = await import('./public/js/api.js');

function response(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function login() {
  sesion.guardar({ token: 'expired-access', refresh_token: 'valid-refresh', user_id: 'buyer-1', roles: ['buyer'] });
  expiredEvents.length = 0;
}

test('un rechazo sin cabecera del gateway conserva la sesión recién renovada', async () => {
  login();
  globalThis.fetch = async (url) => url === '/api/v1/identity/auth/refresh'
    ? response(200, { access_token: 'fresh-access', refresh_token: 'rotated-refresh', user: { id: 'buyer-1', roles: ['buyer'] } })
    : response(401, { message: 'Unauthorized' });
  await assert.rejects(api.listarTarjetas('buyer-1'), (error) => error.status === 401);
  assert.equal(sesion.activa, true);
  assert.deepEqual(expiredEvents, []);
});

test('un módulo no disponible no borra la sesión ni intenta renovarla', async () => {
  login();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(503, { message: 'Servicio no disponible' }); };
  await assert.rejects(api.listarPedidos('buyer-1'), (error) => error.status === 503);
  assert.equal(calls, 1);
  assert.equal(sesion.activa, true);
  assert.deepEqual(expiredEvents, []);
});

test('renueva una sesión y reintenta la consulta de pedidos sin expulsar al comprador', async () => {
  login();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    if (url === '/api/v1/orders/?buyerId=buyer-1') return calls.length === 1 ? response(401, { message: 'Unauthorized' }) : response(200, []);
    if (url === '/api/v1/identity/auth/refresh') return response(200, {
      access_token: 'fresh-access', refresh_token: 'rotated-refresh', user: { id: 'buyer-1', roles: ['buyer'] },
    });
    throw new Error(`URL inesperada: ${url}`);
  };

  assert.deepEqual(await api.listarPedidos('buyer-1'), []);
  assert.equal(sesion.activa, true);
  assert.equal(sesion.token, 'fresh-access');
  assert.equal(sesion.refreshToken, 'rotated-refresh');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].authorization, 'Bearer fresh-access');
  assert.deepEqual(expiredEvents, []);
});

test('un 401 de un microservicio y un Identity temporalmente caído conservan la sesión', async () => {
  login();
  globalThis.fetch = async (url) => url === '/api/v1/identity/auth/refresh'
    ? response(503, { message: 'Identity indisponible' })
    : response(401, { message: 'El servicio rechazó el token' });

  await assert.rejects(api.listarTarjetas('buyer-1'), (error) => error.status === 401);
  assert.equal(sesion.activa, true);
  assert.equal(sesion.token, 'expired-access');
  assert.deepEqual(expiredEvents, []);
});

test('un microservicio que sigue rechazando el JWT no cierra la sesión válida de Identity', async () => {
  login();
  let pedidoCount = 0;
  globalThis.fetch = async (url) => {
    if (url === '/api/v1/identity/auth/refresh') return response(200, {
      access_token: 'fresh-access', refresh_token: 'rotated-refresh', user: { id: 'buyer-1', roles: ['buyer'] },
    });
    pedidoCount += 1;
    return new Response(JSON.stringify({ message: 'JWT no aceptado por el microservicio' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-ftt-upstream-response': '1' },
    });
  };

  await assert.rejects(api.listarTarjetas('buyer-1'), (error) => error.status === 401);
  assert.equal(pedidoCount, 2);
  assert.equal(sesion.activa, true);
  assert.equal(sesion.token, 'fresh-access');
  assert.deepEqual(expiredEvents, []);
});

test('cierra la sesión solo cuando Identity rechaza explícitamente el refresh token', async () => {
  login();
  globalThis.fetch = async (url) => url === '/api/v1/identity/auth/refresh'
    ? response(401, { message: 'Refresh token inválido' })
    : response(401, { message: 'Unauthorized' });

  await assert.rejects(api.listarTarjetas('buyer-1'), (error) => error.status === 401);
  assert.equal(sesion.activa, false);
  assert.deepEqual(expiredEvents, ['ftt:expired']);
});
