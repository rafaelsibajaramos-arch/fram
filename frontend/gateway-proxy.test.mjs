import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server?.listening) return;
  server.close();
  await once(server, 'close');
}

async function waitForGateway(port, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Gateway terminó durante el inicio (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch { /* el socket aún no está escuchando */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Gateway no inició dentro del tiempo esperado');
}

test('permite al productor confirmar recogida sin conceder despacho ni cierre de entregas', async (t) => {
  const identity = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'user', roles: [req.headers.authorization === 'Bearer producer' ? 'producer' : 'buyer'] }));
  });
  let calls = 0;
  const logistics = createServer((req, res) => { calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ address: 'Calle 10' })); });
  const identityPort = await listen(identity), logisticsPort = await listen(logistics);
  const reservation = createServer(); const gatewayPort = await listen(reservation); await close(reservation);
  const gateway = spawn(process.execPath, [join(here, 'server.mjs')], { cwd: here, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test', GATEWAY_PORT: String(gatewayPort), IDENTITY_SERVICE_URL: `http://127.0.0.1:${identityPort}`, LOGISTICS_SERVICE_URL: `http://127.0.0.1:${logisticsPort}`, RATE_LIMIT: '100' }, stdio: 'ignore' });
  t.after(async () => { if (gateway.exitCode === null) { gateway.kill('SIGTERM'); await Promise.race([once(gateway, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]); } await close(identity); await close(logistics); });
  await waitForGateway(gatewayPort, gateway);
  const base = `http://127.0.0.1:${gatewayPort}/api/v1/deliveries/11111111-1111-4111-8111-111111111111`;
  const request = (token, suffix, method = 'PATCH') => fetch(base + suffix, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await request('producer', '/dispatch')).status, 200);
  assert.equal((await request('buyer', '/dispatch')).status, 403);
  assert.equal((await request('producer', '/dispatch', 'POST')).status, 403);
  assert.equal((await request('producer', '/close')).status, 403);
  assert.equal(calls, 1);
});

test('Gateway reenvía idempotencia al servicio y no reutiliza respuestas entre usuarios', async (t) => {
  const solicitudesCatalogo = [];
  const identity = createServer((req, res) => {
    const token = req.headers.authorization;
    if (!token) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sub: token.replace(/^Bearer\s+/i, ''), roles: ['buyer'] }));
  });
  const catalog = createServer((req, res) => {
    solicitudesCatalogo.push({
      authorization: req.headers.authorization,
      idempotencyKey: req.headers['idempotency-key'],
      forgedIdentity: req.headers['x-gateway-user-roles'],
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ buyer: req.headers.authorization }));
  });

  let gateway;
  const identityPort = await listen(identity);
  const catalogPort = await listen(catalog);
  const reservation = createServer();
  const gatewayPort = await listen(reservation);
  await close(reservation);
  gateway = spawn(process.execPath, [join(here, 'server.mjs')], {
    cwd: here,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: 'test',
      GATEWAY_PORT: String(gatewayPort),
      IDENTITY_SERVICE_URL: `http://127.0.0.1:${identityPort}`,
      CATALOG_SERVICE_URL: `http://127.0.0.1:${catalogPort}`,
      PAYMENT_SERVICE_URL: `http://127.0.0.1:${catalogPort}`,
      RATE_LIMIT: '1',
      GATEWAY_TRUST_PROXY: '1',
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    if (gateway && gateway.exitCode === null) {
      gateway.kill('SIGTERM');
      await Promise.race([once(gateway, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    await close(identity);
    await close(catalog);
  });

  await waitForGateway(gatewayPort, gateway);

  const readiness = await fetch(`http://127.0.0.1:${gatewayPort}/health/ready`);
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { status: 'ready', service: 'gateway' });

  const call = (token, clientIp) => fetch(`http://127.0.0.1:${gatewayPort}/api/v1/catalog/products`, {
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'same-operation-key',
      'x-gateway-user-roles': 'admin',
      'x-forwarded-for': clientIp,
    },
  });

  const first = await call('buyer-one', '198.51.100.10');
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { buyer: 'Bearer buyer-one' });

  const second = await call('buyer-two', '198.51.100.11');
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { buyer: 'Bearer buyer-two' });

  assert.equal(solicitudesCatalogo.length, 2, 'cada identidad debe llegar al servicio aguas arriba');
  assert.deepEqual(solicitudesCatalogo.map((request) => request.authorization), ['Bearer buyer-one', 'Bearer buyer-two']);
  assert.deepEqual(solicitudesCatalogo.map((request) => request.idempotencyKey), ['same-operation-key', 'same-operation-key']);
  assert.deepEqual(solicitudesCatalogo.map((request) => request.forgedIdentity), [undefined, undefined]);

  const limited = await call('buyer-three', '198.51.100.11');
  assert.equal(limited.status, 429, 'la IP reenviada por el proxy confiable queda limitada');
  assert.equal(Number(limited.headers.get('retry-after')) > 0, true);
  const event = await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/payments/wompi/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.23' }, body: JSON.stringify({ event: 'transaction.updated' }) });
  assert.equal(event.status, 200, 'el webhook llega al servicio sin JWT de comprador; el servicio valida la firma');
  const protectedRoute = await fetch(`http://127.0.0.1:${gatewayPort}/api/v1/payments/wompi/config`, { headers: { 'x-forwarded-for': '198.51.100.24' } });
  assert.equal(protectedRoute.status, 401, 'la excepción pública solo aplica al POST exacto de eventos');
});

test('Gateway conserva archivos multipart y descargas privadas de solicitudes', async (t) => {
  let uploaded = null;
  const identity = createServer((req, res) => {
    if (req.url === '/auth/me') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'buyer', roles: ['buyer'] })); return; }
    if (req.method === 'POST' && req.url?.endsWith('/documents')) {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { uploaded = { body: Buffer.concat(chunks), type: req.headers['content-type'] }; res.writeHead(201, { 'content-type': 'application/json' }); res.end('{}'); });
      return;
    }
    if (req.method === 'GET' && req.url?.includes('/documents/')) { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.from('%PDF-1.0\narchivo')); return; }
    res.writeHead(404).end();
  });
  const identityPort = await listen(identity);
  const reservation = createServer(); const gatewayPort = await listen(reservation); await close(reservation);
  const gateway = spawn(process.execPath, [join(here, 'server.mjs')], { cwd: here, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test', GATEWAY_PORT: String(gatewayPort), IDENTITY_SERVICE_URL: `http://127.0.0.1:${identityPort}`, RATE_LIMIT: '100' }, stdio: 'ignore' });
  t.after(async () => { if (gateway.exitCode === null) { gateway.kill('SIGTERM'); await Promise.race([once(gateway, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]); } await close(identity); });
  await waitForGateway(gatewayPort, gateway);
  const route = `http://127.0.0.1:${gatewayPort}/api/v1/identity/auth/producer-applications/11111111-1111-4111-8111-111111111111/documents`;
  const form = new FormData(); form.append('kind', 'certificacion'); form.append('file', new Blob([Buffer.from('%PDF-1.0\narchivo')], { type: 'application/pdf' }), 'certificado.pdf');
  const upload = await fetch(route, { method: 'POST', headers: { authorization: 'Bearer buyer' }, body: form });
  assert.equal(upload.status, 201);
  assert.match(uploaded.type, /^multipart\/form-data/);
  assert.ok(uploaded.body.includes(Buffer.from('%PDF-1.0\narchivo')));
  const download = await fetch(route + '/22222222-2222-4222-8222-222222222222', { headers: { authorization: 'Bearer buyer' } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from('%PDF-1.0\narchivo'));
});
