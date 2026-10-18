#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const confirmation = 'I_UNDERSTAND_THIS_IS_STAGING';
const names = [
  'producer-service',
  'catalog-service',
  'identity-service',
  'inventory-service',
  'order-service',
  'payment-service',
  'logistics-service',
  'notification-service',
  'analytics-service',
];

function required(name, env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Falta la variable ${name}.`);
  return value;
}

export function normalizeBase(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} debe ser una URL absoluta.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} debe usar HTTPS.`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} no debe incluir credenciales, query ni fragmento.`);
  }
  return url.origin;
}

export function stagingOrigins(env = process.env) {
  if (env.TARGET_ENV !== 'staging') {
    throw new Error('Se bloqueó el smoke: TARGET_ENV debe ser exactamente staging.');
  }
  if (required('STAGING_CONFIRMATION', env) !== confirmation) {
    throw new Error(`Se bloqueó el smoke: define STAGING_CONFIRMATION=${confirmation}.`);
  }

  const base = normalizeBase(required('STAGING_BASE_URL', env), 'STAGING_BASE_URL');
  const production = normalizeBase(required('PRODUCTION_BASE_URL', env), 'PRODUCTION_BASE_URL');
  if (base === production) throw new Error('Se bloqueó el smoke: staging y producción apuntan al mismo origen.');
  return { base, production };
}

export function readinessFailures(report) {
  return names.filter((name) => {
    const service = report?.[name];
    return !service || service.alcanzable !== true || service.listo !== true || service.http !== 200;
  });
}

async function main() {
  const { base } = stagingOrigins();

  const response = await fetch(`${base}/api/v1/system/health`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Gateway health respondió HTTP ${response.status}.`);

  const report = await response.json();
  const failures = readinessFailures(report);
  for (const name of names) {
    const service = report?.[name];
    const status = service?.listo === true && service?.http === 200 ? 'READY' : `NOT_READY (HTTP ${service?.http ?? 'sin respuesta'})`;
    console.log(`${name}: ${status}`);
  }
  if (failures.length) throw new Error(`Servicios no listos: ${failures.join(', ')}.`);
  console.log('STAGING HEALTH SMOKE: PASS (solo lecturas; no crea ni modifica datos).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`STAGING HEALTH SMOKE: FAIL — ${error.message}`);
    process.exitCode = 1;
  });
}
