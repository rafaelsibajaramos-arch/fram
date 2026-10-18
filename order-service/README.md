# order-service

Servicio NestJS de carrito, checkout, pedidos y calificaciones. Puerto predeterminado: `3005`. Coordina Catálogo, Inventario y Pagos; la compra asíncrona usa eventos/outbox para confirmar o compensar el flujo.

## Desarrollo

Configura `.env.example` contra servicios y PostgreSQL de desarrollo:

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

No migres bases productivas desde una máquina local. Consulta el stack aislado en [../README.md](../README.md#stack-totalmente-local-sin-conectar-a-neon).

## Rutas principales

Las rutas usan prefijo global `/api/v1`.

| Método | Ruta | Uso |
|---|---|---|
| GET/PUT/DELETE | `/api/v1/orders/cart/:buyerId` | Consultar/actualizar/vaciar carrito (dueño/admin) |
| POST | `/api/v1/orders` | Inicia la saga asíncrona de checkout |
| POST | `/api/v1/orders/checkout` | Inicia la misma saga asíncrona (ruta principal de compra) |
| POST | `/api/v1/orders/checkout/async` | Alias compatible de la saga asíncrona |
| GET | `/api/v1/orders`, `/api/v1/orders/:id` | Lista y detalle filtrados por rol |
| PATCH | `/api/v1/orders/:id/status` | Cambio administrativo de estado |
| POST/GET | `/api/v1/orders/:id/rating` | Crear/consultar calificación autorizada |
| GET | `/api/v1/orders/health`, `/api/v1/health/ready` | Salud/readiness |

El Gateway debe propagar JWT y los encabezados internos firmados/configurados; no confíes en cabeceras de identidad enviadas directamente por un cliente.

## Pruebas

`npm test -- --runInBand` ejecuta Jest. `npm run test:e2e:checkout` desde la raíz necesita Docker y usa PostgreSQL/RabbitMQ efímeros para validar checkout, compensación y logística.
