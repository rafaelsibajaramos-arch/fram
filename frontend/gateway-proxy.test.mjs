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
});
