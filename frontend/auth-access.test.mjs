import test from 'node:test';
import assert from 'node:assert/strict';
import { isAnonymousIdentityPost } from './auth-access.mjs';

test('permite renovar sesión con refresh token aunque el access token haya expirado', () => {
  assert.equal(isAnonymousIdentityPost('POST', '/identity/auth/refresh'), true);
});

test('solo permite POST en las rutas públicas explícitas de identidad', () => {
  assert.equal(isAnonymousIdentityPost('GET', '/identity/auth/refresh'), false);
  assert.equal(isAnonymousIdentityPost('POST', '/identity/auth/users'), false);
  assert.equal(isAnonymousIdentityPost('POST', '/identity/auth/password/reset/request'), true);
});
