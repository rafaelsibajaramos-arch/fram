import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const baseUrl = new URL(process.env.FTT_LOCAL_URL ?? 'http://localhost:14000');
if (!['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)) {
  throw new Error('La prueba de humo solo puede apuntar a localhost para proteger datos reales.');
}

const password = 'LocalOnly-passphrase-938!';
const email = `buyer-${randomUUID()}@example.test`;

async function request(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = text; }
  return { status: response.status, data };
}

const register = await request('/api/v1/identity/auth/register', {
  method: 'POST',
  body: { email, password, full_name: 'Comprador Stack Local', role: 'buyer' },
});
assert.equal(register.status, 201, JSON.stringify(register.data));
assert.ok(register.data.verification_token, 'Identity local debe exponer el token de verificación sin SMTP');
assert.deepEqual(register.data.user.roles, ['buyer']);

const roleEscalation = await request('/api/v1/identity/auth/register', {
  method: 'POST',
  body: { email: `producer-${randomUUID()}@example.test`, password, full_name: 'Sin privilegio', role: 'producer' },
});
assert.equal(roleEscalation.status, 400, JSON.stringify(roleEscalation.data));

const verify = await request('/api/v1/identity/auth/email/verify', {
  method: 'POST', body: { token: register.data.verification_token },
});
assert.equal(verify.status, 201, JSON.stringify(verify.data));
assert.equal(verify.data.status, 'active');

const login = await request('/api/v1/identity/auth/login', {
  method: 'POST', body: { email, password, device_name: 'Smoke test local' },
});
assert.equal(login.status, 201, JSON.stringify(login.data));
assert.ok(login.data.access_token && login.data.refresh_token);

const me = await request('/api/v1/identity/auth/me', { token: login.data.access_token });
assert.equal(me.status, 200, JSON.stringify(me.data));
assert.equal(me.data.id, verify.data.id);
assert.deepEqual(me.data.roles, ['buyer']);

const producerApplication = await request('/api/v1/identity/auth/producer-applications', {
  method: 'POST', token: login.data.access_token,
  body: { business_name: 'Finca de prueba local', phone: '3001234567', message: 'Solicitud de humo local.' },
});
assert.equal(producerApplication.status, 201, JSON.stringify(producerApplication.data));
assert.equal(producerApplication.data.status, 'pending');
const duplicateApplication = await request('/api/v1/identity/auth/producer-applications', {
  method: 'POST', token: login.data.access_token, body: { business_name: 'Otra finca' },
});
assert.equal(duplicateApplication.status, 409, JSON.stringify(duplicateApplication.data));
const myApplication = await request('/api/v1/identity/auth/producer-applications/me', { token: login.data.access_token });
assert.equal(myApplication.status, 200, JSON.stringify(myApplication.data));
assert.equal(myApplication.data.id, producerApplication.data.id);
assert.deepEqual((await request('/api/v1/identity/auth/me', { token: login.data.access_token })).data.roles, ['buyer']);

for (const path of [
  '/api/v1/catalog/products',
  '/api/v1/orders',
  `/api/v1/payments/wallet/${verify.data.id}`,
]) {
  const response = await request(path, { token: login.data.access_token });
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.data)}`);
}

console.log('Local stack smoke passed: buyer registration/verification/login, Gateway JWT, catalog/orders/wallet, producer-role escalation rejection, and buyer producer application with duplicate protection.');
