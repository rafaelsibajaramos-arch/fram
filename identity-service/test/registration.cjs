// Run after npm run build: node --test test/registration.cjs
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ValidationPipe } = require('@nestjs/common');
const { RegisterDto } = require('../dist/dto');
const { AuthService } = require('../dist/auth.service');
const { verify } = require('@node-rs/argon2');

const data = { email: 'farmer@example.com', full_name: ' Test Farmer ', password: 'test-password-123' };
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const validate = body => pipe.transform(body, { type: 'body', metatype: RegisterDto });

for (const role of [undefined, 'buyer', 'producer']) {
  test(`registration preserves verification and assigns only ${role ?? 'buyer by default'}`, async () => {
    let saved;
    let token;
    const db = {
      user: { findUnique: async () => null, create: async ({ data }) => (saved = { id: 'test-id', ...data }) },
      actionToken: { create: async ({ data }) => { token = data; } },
    };
    const service = new AuthService(db, {});
    service.sendActionEmail = async () => true;
    const result = await service.register(await validate({ ...data, ...(role ? { role } : {}) }));
    assert.deepEqual(result.user.roles, [role ?? 'buyer']);
    assert.equal(saved.status, 'pending_email');
    assert.equal(saved.fullName, 'Test Farmer');
    assert.equal(token.purpose, 'email_verification');
    assert.equal(result.delivery, 'verification_required');
    assert.equal(await verify(saved.passwordHash, data.password), true);
    assert.equal(result.user.passwordHash, undefined);
  });
}
for (const role of ['admin', 'Producer', '', ['producer'], null]) {
  test(`public registration rejects invalid role ${JSON.stringify(role)}`, async () => {
    const service = new AuthService({}, {});
    await assert.rejects(async () => service.register(await validate({ ...data, role })));
  });
}
test('public registration rejects injected roles array', async () => {
  await assert.rejects(() => validate({ ...data, roles: ['admin'] }));
});
test('duplicate email remains rejected without creating another user', async () => {
  const service = new AuthService({ user: { findUnique: async () => ({ id: 'existing' }) } }, {});
  await assert.rejects(() => service.register({ ...data, role: 'producer' }), /correo ya esta registrado/);
});
