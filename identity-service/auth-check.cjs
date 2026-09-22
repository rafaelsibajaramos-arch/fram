const assert = require('node:assert/strict');
const { AuthService } = require('./dist/auth.service');
const { JwtService } = require('@nestjs/jwt');
const { randomUUID } = require('node:crypto');
process.env.JWT_SECRET = randomUUID();
let user;
const db = { user: {
  findUnique: async ({where}) => user && (where.id === user.id || where.email === user.email) ? user : null,
  create: async ({data}) => user = { ...data, id: randomUUID(), version: 1, status: 'active' }
}};
(async () => {
  const auth = new AuthService(db, new JwtService());
  await assert.rejects(auth.register({email:'test@example.com', password:'StrongSecret123', full_name:'Test', roles:['admin']}));
  await auth.register({email:'test@example.com', password:'StrongSecret123', full_name:'Test', roles:['buyer']});
  assert.notEqual(user.passwordHash, 'StrongSecret123');
  await assert.rejects(auth.login({email:user.email,password:'incorrect'}));
  const access = await auth.login({email:user.email,password:'StrongSecret123'});
  assert.equal((await auth.authenticate('Bearer ' + access.access_token)).id,user.id);
  await assert.rejects(auth.authenticate('Bearer invalid'));
  const mock = new JwtService().sign({sub:user.id,roles:['admin']},{secret:process.env.JWT_SECRET});
  await assert.rejects(auth.authenticate('Bearer ' + mock));
  user.status = 'disabled';
  await assert.rejects(auth.authenticate('Bearer ' + access.access_token));
  console.log('PASS: registro, hash, login, token, rechazo de acceso simulado y cuenta deshabilitada');
})().catch(e => { console.error(e); process.exit(1); });
