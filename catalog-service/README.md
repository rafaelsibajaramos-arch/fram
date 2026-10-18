# catalog-service

Servicio NestJS de categorías, productos, precios y lotes de cosecha. Puerto predeterminado: `3002`. Es propietario de su PostgreSQL; consulta Productores por REST y consume/publica eventos RabbitMQ. Redis es caché opcional, no fuente de verdad.

## Desarrollo y migraciones

Configura `.env.example` con PostgreSQL de desarrollo, RabbitMQ, URL de Productores y, opcionalmente, Redis:

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

Usa únicamente bases aisladas para migraciones. El stack local desconectado de Neon se inicia siguiendo [../README.md](../README.md#stack-totalmente-local-sin-conectar-a-neon).

## Rutas principales

El servicio no configura prefijo global.

| Método | Ruta | Uso |
|---|---|---|
| GET/POST | `/categories` | Listar/crear categorías |
| GET/PATCH | `/categories/:id` | Consultar/editar categoría |
| GET | `/products`, `/products/available` | Catálogo y oferta disponible |
| POST/PATCH | `/products`, `/products/:id` | Crear/editar producto (autorizado) |
| GET | `/products/:id/price`, `/products/:id/prices` | Precio actual e historial |
| GET/POST | `/harvest-batches` | Consultar/registrar cosechas |
| PATCH | `/harvest-batches/:id/publish`, `/harvest-batches/:id/close` | Publicar/cerrar lote |
| GET | `/health`, `/health/ready` | Estado y readiness |

`REDIS_URL` vacío desactiva la caché. El precio vigente se deriva del historial de precios y la disponibilidad validada.

## Pruebas

`npm test -- --runInBand` y `npm run build` validan el servicio. `npm run test:e2e:redis-cache` requiere Docker para su modo Redis real; incluye también la ruta degradada sin Redis.
