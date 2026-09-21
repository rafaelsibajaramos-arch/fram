import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { InventoryConsumer } from '../src/consumers/inventory.consumer';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProducerClientService } from '../src/producer-client/producer-client.service';

/**
 * E2E contra la base real (Neon).
 * producer-service se sustituye por un doble para que la prueba no dependa
 * de tener el otro microservicio levantado; el resto (precio dinamico,
 * versiones, outbox, consumidor de stock) es codigo real.
 *
 * Recorrido: categoria -> producto -> lote -> publicar -> stock -> precio.
 */
const hayBase = !!process.env.DATABASE_URL;
const d = hayBase ? describe : describe.skip;

const PRODUCER_ID = randomUUID();
const FARM_ID = randomUUID();

const producerClientDoble: Partial<ProducerClientService> = {
  validateProducer: async () => ({ producer_id: PRODUCER_ID, exists: true, active: true }),
  validateFarm: async () => ({
    farm_id: FARM_ID,
    exists: true,
    active: true,
    producer_id: PRODUCER_ID,
    producer_active: true,
  }),
};

d('catalog-service (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inventory: InventoryConsumer;

  let categoryId: string;
  let productId: string;
  let batchId: string;

  beforeAll(async () => {
    process.env.AUTH_DISABLED = 'true';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ProducerClientService)
      .useValue(producerClientDoble)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, errorHttpStatusCode: 422 }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    inventory = app.get(InventoryConsumer);
  });

  afterAll(async () => {
    if (productId) {
      await prisma.harvestBatch.deleteMany({ where: { productId } });
      await prisma.priceHistory.deleteMany({ where: { productId } });
      await prisma.stockState.deleteMany({ where: { productId } });
      await prisma.outboxEvent.deleteMany({ where: { entityId: productId } });
      await prisma.product.deleteMany({ where: { id: productId } });
    }
    if (batchId) await prisma.outboxEvent.deleteMany({ where: { entityId: batchId } });
    if (categoryId) await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.producerRef.deleteMany({ where: { producerId: PRODUCER_ID } });
    await app?.close();
  });

  it('1. crea una categoria', async () => {
    const res = await request(app.getHttpServer())
      .post('/categories')
      .send({ name: `Frutas E2E ${Date.now()}` })
      .expect(201);
    categoryId = res.body.id;
  });

  it('2. rechaza una categoria duplicada (409)', async () => {
    const nombre = `Verduras E2E ${Date.now()}`;
    const primera = await request(app.getHttpServer()).post('/categories').send({ name: nombre }).expect(201);
    await request(app.getHttpServer()).post('/categories').send({ name: nombre }).expect(409);
    await prisma.category.delete({ where: { id: primera.body.id } });
  });

  it('3. crea un producto con su primera version de precio', async () => {
    const res = await request(app.getHttpServer())
      .post('/products')
      .send({
        producer_id: PRODUCER_ID,
        name: 'Tomate E2E',
        category_id: categoryId,
        unit: 'kg',
        min_order_quantity: 5,
        base_price: 5000,
        low_stock_threshold: 20,
        high_stock_threshold: 100,
      })
      .expect(201);

    productId = res.body.id;
    expect(res.body.price).toBe(5000);

    const versiones = await prisma.priceHistory.findMany({ where: { productId } });
    expect(versiones).toHaveLength(1);
    expect(versiones[0].reason).toBe('initial');
    expect(versiones[0].validTo).toBeNull();
  });

  it('4. rechaza umbrales inconsistentes (422)', async () => {
    await request(app.getHttpServer())
      .post('/products')
      .send({
        producer_id: PRODUCER_ID,
        name: 'Malo',
        category_id: categoryId,
        unit: 'kg',
        min_order_quantity: 1,
        base_price: 100,
        low_stock_threshold: 50,
        high_stock_threshold: 50,
      })
      .expect(422);
  });

  it('5. rechaza una unidad distinta de kg (422)', async () => {
    await request(app.getHttpServer())
      .post('/products')
      .send({
        producer_id: PRODUCER_ID,
        name: 'Malo',
        category_id: categoryId,
        unit: 'lb',
        min_order_quantity: 1,
        base_price: 100,
        low_stock_threshold: 10,
        high_stock_threshold: 50,
      })
      .expect(422);
  });

  it('6. registra un lote de cosecha', async () => {
    const res = await request(app.getHttpServer())
      .post('/harvest-batches')
      .send({
        product_id: productId,
        farm_id: FARM_ID,
        harvest_date: '2026-09-15',
        quantity_kg: 100,
        expiry_estimate: '2026-09-25',
      })
      .expect(201);

    batchId = res.body.batch_id;
    expect(res.body.status).toBe('registered');
  });

  it('7. publica el lote y encola harvest.registered', async () => {
    const res = await request(app.getHttpServer()).patch(`/harvest-batches/${batchId}/publish`).expect(200);
    expect(res.body.status).toBe('published');

    const eventos = await prisma.outboxEvent.findMany({ where: { entityId: batchId } });
    expect(eventos.map((e) => e.eventType)).toContain('harvest.registered');
  });

  it('8. recibe stock de Inventario y sube el precio 10%', async () => {
    await inventory.handle({
      event_id: randomUUID(),
      event_type: 'inventory.stock_changed',
      source_service: 'inventory-service',
      entity_id: productId,
      entity_version: 1,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      payload: { product_id: productId, stock_version: 10, available_kg: 15, physical_kg: 15 },
    });

    const res = await request(app.getHttpServer()).get(`/products/${productId}/price`).expect(200);
    expect(res.body.price).toBe(5500);
    expect(res.body.reason).toBe('low_stock');
    expect(res.body.available_kg).toBe(15);
    expect(res.body.stock_version).toBe(10);
  });

  it('9. ignora un evento de stock con version antigua', async () => {
    await inventory.handle({
      event_id: randomUUID(),
      event_type: 'inventory.stock_changed',
      source_service: 'inventory-service',
      entity_id: productId,
      entity_version: 1,
      schema_version: 1,
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
      payload: { product_id: productId, stock_version: 5, available_kg: 500, physical_kg: 500 },
    });

    const res = await request(app.getHttpServer()).get(`/products/${productId}/price`).expect(200);
    expect(res.body.price).toBe(5500);
    expect(res.body.stock_version).toBe(10);
  });

  it('10. mantiene una sola version vigente y el historial completo', async () => {
    const versiones = await prisma.priceHistory.findMany({
      where: { productId },
      orderBy: { validFrom: 'asc' },
    });

    expect(versiones.length).toBeGreaterThanOrEqual(2);
    expect(versiones.filter((v) => v.validTo === null)).toHaveLength(1);

    // Sin solapamiento: valid_to de una version coincide con valid_from de la siguiente.
    for (let i = 0; i < versiones.length - 1; i++) {
      expect(versiones[i].validTo).not.toBeNull();
      expect(versiones[i].validTo!.getTime()).toBe(versiones[i + 1].validFrom.getTime());
    }
  });

  it('11. el historial se devuelve por valid_from DESC', async () => {
    const res = await request(app.getHttpServer()).get(`/products/${productId}/prices`).expect(200);
    const fechas = res.body.map((v: any) => new Date(v.valid_from).getTime());
    expect([...fechas].sort((a, b) => b - a)).toEqual(fechas);
    expect(res.body[0].valid_to).toBeNull();
  });

  it('12. el producto aparece en /products/available', async () => {
    const res = await request(app.getHttpServer())
      .get('/products/available')
      .query({ producer_id: PRODUCER_ID })
      .expect(200);

    expect(res.body.data.map((p: any) => p.id)).toContain(productId);
  });

  it('13. desactivar el producto lo retira de la oferta sin borrarlo', async () => {
    await request(app.getHttpServer()).patch(`/products/${productId}/disable`).expect(200);

    const res = await request(app.getHttpServer())
      .get('/products/available')
      .query({ producer_id: PRODUCER_ID })
      .expect(200);
    expect(res.body.data.map((p: any) => p.id)).not.toContain(productId);

    const sigueExistiendo = await prisma.product.findUnique({ where: { id: productId } });
    expect(sigueExistiendo).not.toBeNull();

    const historial = await prisma.priceHistory.count({ where: { productId } });
    expect(historial).toBeGreaterThan(0);
  });

  it('14. health responde', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
