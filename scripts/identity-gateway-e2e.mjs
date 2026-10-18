import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const pgContainer = `ftt-identity-pg-${suffix}`;
const rabbitContainer = `ftt-identity-rabbit-${suffix}`;
const pgUser = 'ftt_identity_test';
const pgPassword = 'ftt_identity_local_only';
const database = 'identity_gateway_e2e';
const email = `buyer-${suffix}@example.test`;
const password = 'TestOnly-passphrase-938!';
let pgPort; let rabbitPort; let identityPort; let gatewayPort;
let pgStarted = false; let rabbitStarted = false;
let identityProcess; let gatewayProcess; let prisma; let smtpServer; let smtpPort;
let identityLog = ''; let gatewayLog = '';

function run(command, args, env = process.env) {
  try { return execFileSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`${command} ${args.join(' ')} failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error }); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(label, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* wait for dependency startup */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} no quedó listo a tiempo`);
}

function start(command, args, cwd, env, appendLog) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  return child;
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function post(url, body, token) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function patch(url, body, token) {
  const response = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

try {
  [pgPort, rabbitPort, identityPort, gatewayPort, smtpPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  // SMTP de prueba que acepta el socket pero no envía el saludo 220. Simula un
  // relay lento/atascado sin contactar Gmail ni ningún proveedor externo.
  smtpServer = net.createServer((socket) => socket.on('error', () => undefined));
  await new Promise((resolve, reject) => smtpServer.listen(smtpPort, '127.0.0.1', resolve).once('error', reject));
  run('docker', ['run', '--rm', '-d', '--name', pgContainer, '-p', `127.0.0.1:${pgPort}:5432`, '-e', `POSTGRES_USER=${pgUser}`, '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', `POSTGRES_DB=${database}`, 'postgres:16-alpine']);
  pgStarted = true;
  run('docker', ['run', '--rm', '-d', '--name', rabbitContainer, '-p', `127.0.0.1:${rabbitPort}:5672`, '-e', 'RABBITMQ_DEFAULT_USER=ftt_identity_test', '-e', 'RABBITMQ_DEFAULT_PASS=ftt_identity_local_only', 'rabbitmq:3.13-alpine']);
  rabbitStarted = true;
  await waitFor('PostgreSQL temporal', () => { run('docker', ['exec', pgContainer, 'pg_isready', '-U', pgUser, '-d', database]); return true; });
  await waitFor('RabbitMQ temporal', () => { run('docker', ['exec', rabbitContainer, 'rabbitmq-diagnostics', '-q', 'ping']); return true; });

  const databaseUrl = `postgresql://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${database}?schema=public`;
  const identityDir = path.join(root, 'identity-service');
  const identityEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', PORT: String(identityPort),
    DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl,
    JWT_ISSUER: 'farmtotable-identity', JWT_AUDIENCE: 'farmtotable-api', JWT_ALG: 'RS256',
    JWT_PRIVATE_KEY: 'test-only-key-creation-will-be-overridden', JWT_PUBLIC_KEY: 'test-only-key-creation-will-be-overridden',
    AUTH_EXPOSE_ACTION_TOKENS: 'true', RABBITMQ_URL: `amqp://ftt_identity_test:ftt_identity_local_only@127.0.0.1:${rabbitPort}`,
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false',
    SMTP_USER: 'sender@example.test', SMTP_PASS: 'local-only', SMTP_GREETING_TIMEOUT_MS: '1000',
  };
  const { generateKeyPairSync } = await import('node:crypto');
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  identityEnv.JWT_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  identityEnv.JWT_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  run(process.execPath, [path.join(identityDir, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy', '--schema', path.join(identityDir, 'prisma', 'schema.prisma')], identityEnv);

  const requireFromIdentity = createRequire(path.join(identityDir, 'package.json'));
  const { PrismaClient } = requireFromIdentity('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  identityProcess = start(process.execPath, [path.join(identityDir, 'dist', 'main.js')], identityDir, identityEnv, (chunk) => { identityLog = `${identityLog}${chunk}`.slice(-10_000); });
  await waitFor('Identity readiness', async () => {
    if (identityProcess.exitCode != null) throw new Error(identityLog);
    return (await fetch(`http://127.0.0.1:${identityPort}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok;
  });

  const frontendDir = path.join(root, 'frontend');
  const gatewayEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test', GATEWAY_PORT: String(gatewayPort), IDENTITY_SERVICE_URL: `http://127.0.0.1:${identityPort}`, RATE_LIMIT: '1000' };
  gatewayProcess = start(process.execPath, ['server.mjs'], frontendDir, gatewayEnv, (chunk) => { gatewayLog = `${gatewayLog}${chunk}`.slice(-10_000); });
  const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
  await waitFor('Gateway readiness', async () => {
    if (gatewayProcess.exitCode != null) throw new Error(gatewayLog);
    const response = await fetch(gatewayBase, { signal: AbortSignal.timeout(1000) });
    return response.status === 200;
  });

  const publicBase = `${gatewayBase}/api/v1/identity/auth`;
  const registration = await post(`${publicBase}/register`, { email, password, full_name: 'Comprador E2E', role: 'buyer' });
  assert.equal(registration.status, 201, JSON.stringify(registration.body));
  assert.equal(registration.body.user.roles.includes('buyer'), true);
  assert.equal(registration.body.user.roles.includes('producer'), false);
  assert.equal(registration.body.delivery, 'verification_required');
  assert.ok(registration.body.verification_token);

  const resetStartedAt = Date.now();
  const resetRequest = await post(`${publicBase}/password/reset/request`, { email });
  const resetDurationMs = Date.now() - resetStartedAt;
  assert.equal(resetRequest.status, 201, JSON.stringify(resetRequest.body));
  assert.equal(resetRequest.body.accepted, true);
  assert.ok(resetRequest.body.reset_token, 'el token solo se expone en este E2E aislado');
  assert.ok(resetDurationMs < 5000, `SMTP bloqueado no debe colgar el Gateway (${resetDurationMs} ms)`);
  const unknownReset = await post(`${publicBase}/password/reset/request`, { email: `unknown-${suffix}@example.test` });
  assert.deepEqual(unknownReset.body, { accepted: true }, 'la respuesta no revela si la cuenta existe');

  const invalidRole = await post(`${publicBase}/register`, { email: `bad-role-${suffix}@example.test`, password, full_name: 'No debe ser productor', role: 'producer' });
  assert.equal(invalidRole.status, 400, 'el registro público no puede elevar a productor');
  const activation = await post(`${publicBase}/email/verify`, { token: registration.body.verification_token });
  assert.equal(activation.status, 201, JSON.stringify(activation.body));
  assert.equal(activation.body.status, 'active');

  const login = await post(`${publicBase}/login`, { email, password, device_name: 'E2E navegador' });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  const first = login.body;
  assert.ok(first.access_token && first.refresh_token && first.session.id);

  const meBefore = await fetch(`${publicBase}/me`, { headers: { authorization: `Bearer ${first.access_token}` } });
  assert.equal(meBefore.status, 200, await meBefore.text());
  const refresh = await post(`${publicBase}/refresh`, { refresh_token: first.refresh_token, device_name: 'E2E renovado' });
  assert.equal(refresh.status, 201, JSON.stringify(refresh.body));
  const second = refresh.body;
  assert.notEqual(second.refresh_token, first.refresh_token, 'el refresh rota el secreto');
  assert.notEqual(second.session.id, first.session.id, 'el refresh crea una sesión nueva');

  const oldAccess = await fetch(`${publicBase}/me`, { headers: { authorization: `Bearer ${first.access_token}` } });
  assert.equal(oldAccess.status, 401, 'la sesión anterior queda revocada tras rotar refresh');
  const replayedRefresh = await post(`${publicBase}/refresh`, { refresh_token: first.refresh_token });
  assert.equal(replayedRefresh.status, 401, 'el refresh anterior no se puede reutilizar');
  const meAfter = await fetch(`${publicBase}/me`, { headers: { authorization: `Bearer ${second.access_token}` } });
  assert.equal(meAfter.status, 200, await meAfter.text());

  const application = await post(`${publicBase}/producer-applications`, { business_name: 'Finca E2E La Esperanza', phone: '3001234567', message: 'Cultivo local de prueba.' }, second.access_token);
  assert.equal(application.status, 201, JSON.stringify(application.body));
  assert.equal(application.body.status, 'pending');
  const duplicateApplication = await post(`${publicBase}/producer-applications`, { business_name: 'Otra finca' }, second.access_token);
  assert.equal(duplicateApplication.status, 409, 'solo se permite una solicitud pendiente por comprador');
  const forbiddenApplicationList = await fetch(`${publicBase}/producer-applications`, { headers: { authorization: `Bearer ${second.access_token}` } });
  assert.equal(forbiddenApplicationList.status, 403, 'un comprador no puede revisar solicitudes administrativas');

  const buyerRecord = await prisma.user.findUniqueOrThrow({ where: { id: activation.body.id } });
  const adminEmail = `admin-${suffix}@example.test`;
  await prisma.user.create({ data: { email: adminEmail, fullName: 'Admin E2E', passwordHash: buyerRecord.passwordHash, roles: ['admin'], status: 'active', emailVerifiedAt: new Date() } });
  const adminLogin = await post(`${publicBase}/login`, { email: adminEmail, password, device_name: 'E2E administrador' });
  assert.equal(adminLogin.status, 201, JSON.stringify(adminLogin.body));
  const listedApplications = await fetch(`${publicBase}/producer-applications`, { headers: { authorization: `Bearer ${adminLogin.body.access_token}` } });
  assert.equal(listedApplications.status, 200);
  assert.ok((await listedApplications.json()).some((row) => row.id === application.body.id));
  const approved = await patch(`${publicBase}/producer-applications/${application.body.id}`, { decision: 'approved', review_notes: 'Datos de prueba verificados.' }, adminLogin.body.access_token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'approved');
  assert.ok(approved.body.applicant.roles.includes('producer'));
  const staleApplicantSession = await fetch(`${publicBase}/me`, { headers: { authorization: `Bearer ${second.access_token}` } });
  assert.equal(staleApplicantSession.status, 401, 'la aprobación revoca el token anterior para refrescar los permisos');

  const rejectedEmail = `rejected-${suffix}@example.test`;
  const rejectedRegistration = await post(`${publicBase}/register`, { email: rejectedEmail, password, full_name: 'Productor pendiente E2E' });
  assert.equal(rejectedRegistration.status, 201);
  const rejectedActivation = await post(`${publicBase}/email/verify`, { token: rejectedRegistration.body.verification_token });
  assert.equal(rejectedActivation.status, 201);
  const rejectedBuyer = await post(`${publicBase}/login`, { email: rejectedEmail, password });
  assert.equal(rejectedBuyer.status, 201);
  const rejectionCandidate = await post(`${publicBase}/producer-applications`, { business_name: 'Finca E2E por revisar' }, rejectedBuyer.body.access_token);
  assert.equal(rejectionCandidate.status, 201);
  const rejected = await patch(`${publicBase}/producer-applications/${rejectionCandidate.body.id}`, { decision: 'rejected', review_notes: 'Faltan datos verificables.' }, adminLogin.body.access_token);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.status, 'rejected');
  assert.deepEqual(rejected.body.applicant.roles, ['buyer']);
  const rejectedSession = await fetch(`${publicBase}/me`, { headers: { authorization: `Bearer ${rejectedBuyer.body.access_token}` } });
  assert.equal(rejectedSession.status, 200, 'rechazar una solicitud no cambia ni revoca el acceso comprador');
  const resubmission = await post(`${publicBase}/producer-applications`, { business_name: 'Finca E2E corregida' }, rejectedBuyer.body.access_token);
  assert.equal(resubmission.status, 201, 'una solicitud rechazada puede volver a presentarse');
  assert.equal(resubmission.body.status, 'pending');

  const producerLogin = await post(`${publicBase}/login`, { email, password, device_name: 'E2E productor aprobado' });
  assert.equal(producerLogin.status, 201);
  assert.ok(producerLogin.body.user.roles.includes('producer'));
  const repeatedApplication = await post(`${publicBase}/producer-applications`, { business_name: 'Finca duplicada' }, producerLogin.body.access_token);
  assert.equal(repeatedApplication.status, 409, 'una cuenta ya aprobada no puede volver a solicitar el rol');
  const logout = await post(`${publicBase}/logout`, { refresh_token: producerLogin.body.refresh_token }, producerLogin.body.access_token);
  assert.equal(logout.status, 201, JSON.stringify(logout.body));
  const afterLogout = await fetch(`${publicBase}/me`, { headers: { authorization: `Bearer ${producerLogin.body.access_token}` } });
  assert.equal(afterLogout.status, 401, 'cerrar sesión invalida el access token a través del Gateway');

  const sessions = await prisma.session.findMany({ where: { userId: activation.body.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(sessions.length, 3);
  assert.ok(sessions.every((session) => session.revokedAt), 'rotación, aprobación y logout revocaron todas las sesiones anteriores');
  assert.equal(await prisma.outboxEvent.count({ where: { entityId: activation.body.id, eventType: 'identity.user_created' } }), 1);
  assert.equal(await prisma.outboxEvent.count({ where: { entityId: activation.body.id, eventType: 'identity.roles_changed' } }), 1);
  console.log('Identity ↔ Gateway E2E passed: buyer registration/verification/login/refresh/logout, producer application duplicate protection, admin approve/reject/resubmit, role-change event, stale-session revocation and buyer-role preservation.');
} catch (error) {
  console.error(error);
  if (identityLog) console.error(`identity-service logs:\n${identityLog}`);
  if (gatewayLog) console.error(`gateway logs:\n${gatewayLog}`);
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect().catch(() => undefined);
  await Promise.all([stop(identityProcess), stop(gatewayProcess)]);
  if (smtpServer?.listening) await new Promise((resolve) => smtpServer.close(resolve));
  if (rabbitStarted) { try { run('docker', ['rm', '-f', rabbitContainer]); } catch { /* already removed */ } }
  if (pgStarted) { try { run('docker', ['rm', '-f', pgContainer]); } catch { /* already removed */ } }
}
