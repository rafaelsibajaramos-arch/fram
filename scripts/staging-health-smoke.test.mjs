import assert from 'node:assert/strict';
import test from 'node:test';
import { readinessFailures, stagingOrigins } from './staging-health-smoke.mjs';

const safeEnvironment = {
  TARGET_ENV: 'staging',
  STAGING_CONFIRMATION: 'I_UNDERSTAND_THIS_IS_STAGING',
  STAGING_BASE_URL: 'https://fram-staging.up.railway.app',
  PRODUCTION_BASE_URL: 'https://fram-production.up.railway.app',
};

test('refuses environments other than staging before making a request', () => {
  assert.throws(() => stagingOrigins({ ...safeEnvironment, TARGET_ENV: 'production' }), /exactamente staging/);
});

test('requires explicit staging confirmation', () => {
  assert.throws(() => stagingOrigins({ ...safeEnvironment, STAGING_CONFIRMATION: '' }), /STAGING_CONFIRMATION/);
});

test('refuses staging when it shares the production origin', () => {
  assert.throws(() => stagingOrigins({
    ...safeEnvironment,
    STAGING_BASE_URL: safeEnvironment.PRODUCTION_BASE_URL,
  }), /apuntan al mismo origen/);
});

test('requires HTTPS and rejects URL credentials or query strings', () => {
  assert.throws(() => stagingOrigins({ ...safeEnvironment, STAGING_BASE_URL: 'http://fram-staging.up.railway.app' }), /HTTPS/);
  assert.throws(() => stagingOrigins({ ...safeEnvironment, STAGING_BASE_URL: 'https://user:pass@fram-staging.up.railway.app' }), /credenciales/);
  assert.throws(() => stagingOrigins({ ...safeEnvironment, STAGING_BASE_URL: 'https://fram-staging.up.railway.app?token=secret' }), /query/);
});

test('accepts distinct HTTPS origins only after explicit staging confirmation', () => {
  assert.deepEqual(stagingOrigins(safeEnvironment), {
    base: 'https://fram-staging.up.railway.app',
    production: 'https://fram-production.up.railway.app',
  });
});

test('marks a missing or unhealthy microservice as a readiness failure', () => {
  assert.deepEqual(readinessFailures({
    'producer-service': { alcanzable: true, listo: true, http: 200 },
    'catalog-service': { alcanzable: true, listo: false, http: 503 },
  }), [
    'catalog-service',
    'identity-service',
    'inventory-service',
    'order-service',
    'payment-service',
    'logistics-service',
    'notification-service',
    'analytics-service',
  ]);
});
