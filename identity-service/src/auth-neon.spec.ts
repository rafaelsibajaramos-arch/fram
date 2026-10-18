import { UnauthorizedException } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import { AuthService } from './auth.service';
import { NeonAuthError } from './neon-auth';

describe('Neon Auth identity bridge', () => {
  let service: AuthService, db: any, neon: any, user: any;
  const password = 'LegacyPassword123!';
  const remote = { id: 'neon-1', email: 'farmer@example.test', name: 'Farmer', emailVerified: true };
  const previous = process.env.AUTH_PROVIDER;
  beforeEach(() => {
    process.env.AUTH_PROVIDER = 'neon';
    user = { id: 'local-id', email: remote.email, fullName: 'Farmer', roles: ['producer'], status: 'active', neonAuthId: null, neonCredentialReady: false, passwordHash: hashSync(password, 4) };
    db = {
      user: { findUnique: jest.fn(async () => user), findUniqueOrThrow: jest.fn(async () => user), update: jest.fn(async ({ data }) => { user = { ...user, ...data }; return user; }) },
      actionToken: { findUnique: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
      session: { updateMany: jest.fn() }, $transaction: async (fn: any) => fn(db),
    };
    service = new AuthService(db, {} as any);
    neon = (service as any).neon;
    jest.spyOn(neon, 'signin').mockResolvedValue({ user: remote, token: 'remote-session' });
    jest.spyOn(neon, 'signup').mockResolvedValue({ user: remote, token: 'remote-session' });
    jest.spyOn(neon, 'sendVerification').mockResolvedValue({ success: true });
    jest.spyOn(service as any, 'createSession').mockImplementation(async (u: any) => ({ id: u.id, roles: u.roles }));
  });
  afterEach(() => { if (previous === undefined) delete process.env.AUTH_PROVIDER; else process.env.AUTH_PROVIDER = previous; });

  it('retains the existing UUID and producer roles when linking a verified Neon account', async () => {
    await expect(service.login({ email: user.email, password })).resolves.toEqual({ id: 'local-id', roles: ['producer'] });
    expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'local-id' }, data: expect.objectContaining({ neonAuthId: 'neon-1', neonCredentialReady: true }) }));
    expect(db.user.update.mock.calls[0][0].data.roles).toBeUndefined();
  });
  it('migrates the known legacy password only after validating it', async () => {
    neon.signin.mockRejectedValue(new NeonAuthError(401, 'INVALID_EMAIL_OR_PASSWORD'));
    await service.login({ email: user.email, password });
    expect(neon.signup).toHaveBeenCalledWith(user.email, password, 'Farmer');
  });
  it('never falls back to the old password after Neon migration', async () => {
    user.neonAuthId = 'neon-1'; user.neonCredentialReady = true;
    neon.signin.mockRejectedValue(new NeonAuthError(401, 'INVALID_EMAIL_OR_PASSWORD'));
    await expect(service.login({ email: user.email, password })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(neon.signup).not.toHaveBeenCalled();
    expect((service as any).createSession).not.toHaveBeenCalled();
  });
  it('keeps the old login usable while an initial recovery is pending', async () => {
    user.neonAuthId = 'neon-1';
    neon.signin.mockRejectedValue(new NeonAuthError(401, 'INVALID_EMAIL_OR_PASSWORD'));
    await expect(service.login({ email: user.email, password })).resolves.toMatchObject({ id: 'local-id' });
    expect(neon.signup).not.toHaveBeenCalled();
  });
  it('does not link an unverified external email to an existing privileged account', async () => {
    neon.signin.mockResolvedValue({ user: { ...remote, emailVerified: false }, token: 'session' });
    await expect(service.login({ email: user.email, password })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.user.update).not.toHaveBeenCalled();
  });
  it('rejects a different Neon identity even when the email matches', async () => {
    user.neonAuthId = 'other-identity'; user.neonCredentialReady = true;
    await expect(service.login({ email: user.email, password })).rejects.toBeInstanceOf(UnauthorizedException);
    expect((service as any).createSession).not.toHaveBeenCalled();
  });
  it('does not authenticate disabled users through Neon', async () => {
    user.status = 'disabled';
    await expect(service.login({ email: user.email, password })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(neon.signin).not.toHaveBeenCalled();
  });
  it('revokes old local sessions after a successful Neon password reset', async () => {
    user.neonAuthId = 'neon-1';
    db.actionToken.findUnique.mockResolvedValue({ id: 'context', userId: user.id, purpose: 'password_reset', expiresAt: new Date(Date.now() + 60000) });
    jest.spyOn(neon, 'call').mockResolvedValue({ status: true });
    await expect(service.resetPassword({ token: 'neon-reset-token', password, context: 'recovery-context' })).resolves.toEqual({ reset: true });
    expect(db.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'local-id', revokedAt: null } }));
    expect(user.neonCredentialReady).toBe(true);
  });
});
