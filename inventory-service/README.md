# inventory-service

Microservicio NestJS de existencias físicas, recepción desde cosechas, reservas, consumo FEFO y mermas. Puerto predeterminado: `3004`. PostgreSQL y RabbitMQ son dependencias del servicio.

## Desarrollo

Configura `.env.example` para una base local aislada y RabbitMQ:

```bash
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run start:dev
```

No ejecutes migraciones de desarrollo sobre producción. Para levantar las nueve bases locales aisladas, utiliza la guía en [../README.md](../README.md#stack-totalmente-local-sin-conectar-a-neon).

## Rutas principales

No hay prefijo global.

| Método | Ruta | Uso |
|---|---|---|
| POST | `/inventory/receive` | Recibir cantidades desde cosechas |
| GET | `/inventory/products/:productId` | Consultar existencias del producto |
| POST | `/inventory/reservations` | Reservar stock de forma idempotente |
| POST | `/inventory/reservations/:id/release` | Liberar reserva |
| POST | `/inventory/reservations/:id/consume` | Consumir reserva |
| POST | `/inventory/reservations/consume-batch` | Consumo atómico de varias reservas |
| POST | `/inventory/waste` | Registrar merma (admin) |
| GET | `/health`, `/health/ready` | Liveness y readiness de PostgreSQL/RabbitMQ |

Las operaciones de reserva, liberación y consumo están protegidas por JWT y verificaciones de propiedad/rol. No desactives autenticación para exponer el servicio.

## Pruebas

`npm test` ejecuta Jest y `npm run build` compila el servicio. Las pruebas de migración/E2E usan infraestructura local efímera descrita en el plan raíz.
