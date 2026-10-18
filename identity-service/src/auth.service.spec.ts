import { BadRequestException, ForbiddenException } from '@nestjs/common';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { AuthService } from './auth.service';

describe('AuthService role policy', () => {
  let service: AuthService;
  let db: any;

  beforeEach(() => {
    db = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'user-1', ...data, rolesVersion: 1, createdAt: new Date(), emailVerifiedAt: null })),
        update: jest.fn().mockImplementation(async ({ data }) => ({ id: 'user-1', email: 'farmer@example.com', fullName: 'Farmer', roles: data.roles, status: 'active', rolesVersion: 2, version: 2, createdAt: new Date(), emailVerifiedAt: null })),
      },
      session: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
      producerApplication: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'application-1', userId: 'user-1', businessName: 'Finca Esperanza', status: 'pending' }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (fn) => fn(db)),
    };
    service = new AuthService(db, {} as any);
    jest.spyOn(service as any, 'issueActionToken').mockResolvedValue('opaque-action-token');
    jest.spyOn(service as any, 'sendActionEmail').mockResolvedValue(true);
  });

  it('ignora cualquier rol que intente enviar el registro público y crea solo buyer', async () => {
    await service.register({ email: 'Farmer@Example.com', password: 'a-long-password', full_name: ' Farmer ', role: 'buyer' });
    expect(db.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ email: 'farmer@example.com', fullName: 'Farmer', roles: ['buyer'], status: 'pending_email' }) }));
  });

  it('emite identity.roles_changed en la misma transacción y revoca las sesiones anteriores', async () => {
    await service.updateRoles('user-1', ['producer', 'buyer', 'producer'], '11111111-1111-4111-8111-111111111111');
    expect(db.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }));
    expect(db.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'identity.roles_changed', routingKey: 'identity.roles_changed', entityId: 'user-1', payload: expect.objectContaining({ roles: ['producer', 'buyer'], roles_version: 2 }) }) }));
  });

  it('rechaza roles desconocidos aun si el servicio se invoca sin el ValidationPipe HTTP', async () => {
    await expect(service.updateRoles('user-1', ['admin'])).rejects.toBeInstanceOf(BadRequestException);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('recibe una solicitud de productor sin conceder el rol y conserva los datos normalizados', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'user-1', roles: ['buyer'], status: 'active' });
    await service.createProducerApplication('user-1', { business_name: '  Finca   Esperanza ', phone: ' 3001234567 ', message: ' Cultivamos frutas. ' });
    expect(db.producerApplication.create).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: 'user-1', businessName: 'Finca Esperanza', phone: '3001234567', message: 'Cultivamos frutas.' } }));
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('impide más de una solicitud pendiente del mismo comprador', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'user-1', roles: ['buyer'], status: 'active' });
    db.producerApplication.findFirst.mockResolvedValue({ id: 'application-existing', status: 'pending' });
    await expect(service.createProducerApplication('user-1', { business_name: 'Finca Esperanza' })).rejects.toThrow('Ya tienes una solicitud de productor pendiente');
    expect(db.producerApplication.create).not.toHaveBeenCalled();
  });

  it('solo concede productor al aprobar y registra roles, revocación y decisión en la misma transacción', async () => {
    db.producerApplication.findUnique
      .mockResolvedValueOnce({ id: 'application-1', userId: 'user-1', status: 'pending', applicant: { id: 'user-1', status: 'active', roles: ['buyer'] } })
      .mockResolvedValueOnce({ id: 'application-1', userId: 'user-1', status: 'approved' });
    db.user.update.mockResolvedValue({ id: 'user-1', roles: ['buyer', 'producer'], version: 2, rolesVersion: 2 });
    await service.reviewProducerApplication('application-1', 'admin-1', 'approved', 'Verificado', '11111111-1111-4111-8111-111111111111');
    expect(db.producerApplication.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'application-1', status: 'pending' }, data: expect.objectContaining({ status: 'approved', reviewedBy: 'admin-1', reviewNotes: 'Verificado' }) }));
    expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user-1' }, data: expect.objectContaining({ roles: ['buyer', 'producer'], rolesVersion: { increment: 1 }, version: { increment: 1 } }) }));
    expect(db.session.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }));
    expect(db.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'identity.roles_changed', entityId: 'user-1', payload: expect.objectContaining({ roles: ['buyer', 'producer'] }) }) }));
  });

  it('impide que un administrador revise su propia solicitud', async () => {
    db.producerApplication.findUnique.mockResolvedValue({ id: 'application-1', userId: 'admin-1', status: 'pending', applicant: { id: 'admin-1', status: 'active', roles: ['buyer', 'admin'] } });
    await expect(service.reviewProducerApplication('application-1', 'admin-1', 'approved')).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.producerApplication.updateMany).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('limita los timeouts SMTP y cierra el transporte para que recuperación no quede colgada', async () => {
    jest.restoreAllMocks();
    const names = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'APP_PUBLIC_URL'];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const sendMail = jest.fn().mockResolvedValue({});
    const close = jest.fn();
    const createTransport = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close } as any);
    try {
      Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'sender@example.test', SMTP_PASS: 'local-only', SMTP_PORT: '587', SMTP_SECURE: 'false', APP_PUBLIC_URL: 'https://app.example.test' });
      await expect((service as any).sendActionEmail('buyer@example.test', 'Restablecer', 'Token: test-token')).resolves.toBe(true);
      expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000 }));
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'buyer@example.test', text: expect.stringContaining('test-token') }));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      createTransport.mockRestore();
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });

  it('mantiene respuesta neutra de recuperación cuando el envío SMTP falla', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'buyer@example.test', status: 'active' });
    (service as any).sendActionEmail.mockResolvedValue(false);
    await expect(service.requestPasswordReset('Buyer@Example.Test')).resolves.toEqual({ accepted: true });
  });

  it('abandona un servidor SMTP que acepta TCP pero nunca entrega el saludo', async () => {
    jest.restoreAllMocks();
    const names = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_CONNECTION_TIMEOUT_MS', 'SMTP_GREETING_TIMEOUT_MS', 'SMTP_SOCKET_TIMEOUT_MS'];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const smtp = net.createServer((socket) => socket.on('error', () => undefined));
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => smtp.listen(0, '127.0.0.1', resolve).once('error', reject));
      const address = smtp.address();
      if (!address || typeof address === 'string') throw new Error('No se pudo abrir el SMTP local de prueba');
      Object.assign(process.env, {
        SMTP_HOST: '127.0.0.1', SMTP_USER: 'sender@example.test', SMTP_PASS: 'local-only', SMTP_PORT: String(address.port), SMTP_SECURE: 'false',
        SMTP_CONNECTION_TIMEOUT_MS: '1000', SMTP_GREETING_TIMEOUT_MS: '1000', SMTP_SOCKET_TIMEOUT_MS: '1000',
      });
      const startedAt = Date.now();
      await expect((service as any).sendActionEmail('buyer@example.test', 'Restablecer', 'Token: test-token')).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(4000);
    } finally {
      log.mockRestore();
      await new Promise((resolve) => smtp.close(resolve));
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  });
});
