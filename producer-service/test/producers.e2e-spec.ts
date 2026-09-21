import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * E2E contra la base real (Neon).
 * Requiere DATABASE_URL y se ejecuta con AUTH_DISABLED=true.
 *   npm run test:e2e
 * Recorrido: crear productor -> crear finca -> consultar finca
 *            -> actualizar productor -> desactivar productor.
 */
const hayBase = !!process.env.DATABASE_URL;
const d = hayBase ? describe : describe.skip;

d('producer-service (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const userId = randomUUID();
  const email = `e2e-${Date.now()}@example.com`;
  let producerId: string;
  let farmId: string;

  beforeAll(async () => {
    process.env.AUTH_DISABLED = 'true';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, errorHttpStatusCode: 422 }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (producerId) {
      await prisma.certification.deleteMany({ where: { producerId } });
      await prisma.farm.deleteMany({ where: { producerId } });
      await prisma.outboxEvent.deleteMany({ where: { entityId: producerId } });
      await prisma.producer.deleteMany({ where: { id: producerId } });
    }
    await app?.close();
  });

  it('1. crea el productor', async () => {
    const res = await request(app.getHttpServer())
      .post('/producers')
      .send({ user_id: userId, full_name: 'Productor E2E', email, phone: '3001112233' })
      .expect(201);

    producerId = res.body.id;
    expect(res.body.status).toBe('active');
    expect(res.body).not.toHaveProperty('user_id');
  });

  it('2. rechaza el mismo user_id (409)', async () => {
    await request(app.getHttpServer())
      .post('/producers')
      .send({ user_id: userId, full_name: 'Duplicado', email: `otro-${Date.now()}@example.com` })
      .expect(409);
  });

  it('3. guardo producer.created en el outbox', async () => {
    const eventos = await prisma.outboxEvent.findMany({ where: { entityId: producerId } });
    expect(eventos.map((e) => e.eventType)).toContain('producer.created');
  });

  it('4. crea una finca', async () => {
    const res = await request(app.getHttpServer())
      .post(`/producers/${producerId}/farms`)
      .send({ farm_name: 'Finca E2E', address: 'Vereda El Rosario', latitude: 8.757, longitude: -75.89 })
      .expect(201);

    farmId = res.body.id;
    expect(res.body.active).toBe(true);
  });

  it('5. rechaza coordenadas invalidas (422)', async () => {
    await request(app.getHttpServer())
      .post(`/producers/${producerId}/farms`)
      .send({ farm_name: 'Mala', address: 'x', latitude: 120, longitude: 0 })
      .expect(422);
  });

  it('6. consulta la finca', async () => {
    const res = await request(app.getHttpServer()).get(`/farms/${farmId}`).expect(200);
    expect(res.body).toMatchObject({ id: farmId, producer_id: producerId, latitude: 8.757 });
  });

  it('7. crea y revoca una certificacion', async () => {
    const creada = await request(app.getHttpServer())
      .post(`/producers/${producerId}/certifications`)
      .send({ type: 'Organica', issue_date: '2026-01-10', valid_until: '2027-01-10' })
      .expect(201);

    const revocada = await request(app.getHttpServer())
      .patch(`/certifications/${creada.body.id}/revoke`)
      .expect(200);

    expect(revocada.body.status).toBe('revoked');
    expect(revocada.body.is_current).toBe(false);
  });

  it('8. actualiza el productor', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/producers/${producerId}`)
      .send({ full_name: 'Productor E2E Actualizado' })
      .expect(200);

    expect(res.body.full_name).toBe('Productor E2E Actualizado');
  });

  it('9. desactiva el productor (baja logica)', async () => {
    const res = await request(app.getHttpServer()).patch(`/producers/${producerId}/disable`).expect(200);
    expect(res.body.status).toBe('disabled');

    const sigueExistiendo = await prisma.producer.findUnique({ where: { id: producerId } });
    expect(sigueExistiendo).not.toBeNull();
  });

  it('10. el endpoint interno reporta el productor inactivo', async () => {
    const res = await request(app.getHttpServer())
      .get(`/internal/producers/${producerId}/validate`)
      .expect(200);

    expect(res.body).toMatchObject({ producer_id: producerId, exists: true, active: false });
  });

  it('11. health responde', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
